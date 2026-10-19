// chat-v2's screen capture helper for macOS: a ScreenCaptureKit stream of one display, kept open
// while computer use works, so a screenshot is the newest frame (no fresh capture each time), and
// the stream's own frame reports say when the screen changed, so actions wait only until it holds
// still. The app drives it over stdin and stdout (see src/main/macCapture.ts), one request per
// line, `<id> <op> <args...>`, and one JSON reply per line, after a first {"ready":true,...} line.
//
// It never asks for Screen Recording itself: the app asks first (macPermissions in desktop.ts),
// and without the permission this helper reports so and touches nothing that would prompt.
//
// `--selftest` prints the OS version and what is available, without capturing, and exits.

import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit

// MARK: - Output

let outLock = NSLock()

func send(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) else { return }
  outLock.lock()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
  outLock.unlock()
}

struct Failure: Error {
  let message: String
  init(_ message: String) { self.message = message }
}

/** Milliseconds on a clock that never jumps, for "how long has the screen been still". */
func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }

func osVersion() -> String {
  let v = ProcessInfo.processInfo.operatingSystemVersion
  return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

#if arch(arm64)
let arch = "arm64"
#else
let arch = "x86_64"
#endif

/** The main display (the one with the menu bar) and its size in pixels, for checking by hand. */
func mainDisplay() -> [String: Any] {
  let id = CGMainDisplayID()
  let mode = CGDisplayCopyDisplayMode(id)
  return ["id": Int(id), "w": mode?.pixelWidth ?? Int(CGDisplayPixelsWide(id)), "h": mode?.pixelHeight ?? Int(CGDisplayPixelsHigh(id))]
}

/** ScreenCaptureKit with the frame reports used here (status, dirty rects) came in macOS 12.3. */
func sckAvailable() -> Bool {
  if #available(macOS 12.3, *) { return true }
  return false
}

// MARK: - Waiting on completion handlers

/** Runs `start` and waits for the completion it calls, at most `seconds`. */
func blocking<T>(_ what: String, seconds: Double = 5, _ start: (@escaping (T?, Error?) -> Void) -> Void) throws -> T {
  let done = DispatchSemaphore(value: 0)
  var value: T?
  var failure: Error?
  start { v, e in
    value = v
    failure = e
    done.signal()
  }
  if done.wait(timeout: .now() + seconds) == .timedOut { throw Failure("\(what) took too long") }
  if let failure { throw Failure("\(what): \(failure.localizedDescription)") }
  guard let value else { throw Failure("\(what) gave nothing back") }
  return value
}

// MARK: - The stream

/**
 * A frame counts as a change when the parts it redraws add up to at least this share of the
 * screen. Below it: a blinking text caret, a small spinner. About what Windows tolerates with its
 * 64×36 thumbnails (more than four cells changed), so the two settle alike. The pointer never
 * counts: it isn't in the stream (showsCursor is off).
 */
let MIN_CHANGE = 0.001

/**
 * The menu bar's height on `displayID`, in points (0 when it hides itself). Redraws that stay
 * inside it don't count either: while the stream runs, macOS pulses its screen-recording indicator
 * there about 30 times a second (seen on GitHub's macOS 26 runners, at 0.11% of a 1024×768 screen),
 * and the clock ticks. A menu opening reaches below it, so that still counts.
 */
func menuBarPoints(_ displayID: CGDirectDisplayID) -> (height: Double, width: Double) {
  var result = (height: 0.0, width: 0.0)
  let read = {
    let screen = NSScreen.screens.first {
      ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID
    } ?? NSScreen.screens.first
    if let screen { result = (Double(screen.frame.maxY - screen.visibleFrame.maxY), Double(screen.frame.width)) }
  }
  if Thread.isMainThread { read() } else { DispatchQueue.main.sync(execute: read) }
  return result
}

@available(macOS 12.3, *)
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
  private let lock = NSLock()
  private let frameQueue = DispatchQueue(label: "chat-v2-capture.frames")
  private var active: SCStream?
  /** The newest complete frame. */
  private var latest: CVPixelBuffer?
  private var frames = 0
  /** Frames that changed the screen (see MIN_CHANGE), and when the last one came. */
  private var changes = 0
  private var changedAt = nowMs()
  /** The share of the screen the newest frame redrew, to tell on a real Mac what counts. */
  private var lastArea = 0.0
  /** Why the stream stopped by itself (a display change, permission taken away), if it did. */
  private var stoppedBy: String?
  /** The last complete frames: when, how much they redrew, where, and whether that counted. */
  private var recent: [[String: Any]] = []
  /** The menu bar's height in the stream's pixels (see menuBarPoints). */
  private var menuBar = 0.0

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, CMSampleBufferIsValid(sampleBuffer) else { return }
    guard
      let infos = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let info = infos.first,
      let raw = info[.status] as? Int,
      let status = SCFrameStatus(rawValue: raw)
    else { return }
    // `.idle` means nothing changed since the last frame; only complete frames carry a new picture.
    // Nothing is inferred from frames not arriving: a still screen may send none at all.
    guard status == .complete, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let total = Double(CVPixelBufferGetWidth(pixels) * CVPixelBufferGetHeight(pixels))
    // The first frame has no dirty rects: all of it is new.
    var area = 1.0
    var dirty: [CGRect] = []
    lock.lock()
    let strip = menuBar
    lock.unlock()
    // Dirty rects are in the frame's pixels, counted from its top-left corner.
    if let rects = info[.dirtyRects] as? [NSDictionary], total > 0 {
      var sum = 0.0
      for d in rects {
        if let r = CGRect(dictionaryRepresentation: d as CFDictionary) {
          dirty.append(r)
          if Double(r.maxY) > strip { sum += Double(r.width * r.height) }
        }
      }
      area = min(1, sum / total)
    }
    let now = nowMs()
    let counted = area >= MIN_CHANGE
    lock.lock()
    latest = pixels
    frames += 1
    lastArea = area
    if counted {
      changes += 1
      changedAt = now
    }
    recent.append([
      "t": now, "area": area, "counted": counted,
      "rects": dirty.prefix(6).map { [Int($0.minX), Int($0.minY), Int($0.width), Int($0.height)] },
    ])
    if recent.count > 40 { recent.removeFirst(recent.count - 40) }
    lock.unlock()
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    lock.lock()
    if active === stream {
      active = nil
      latest = nil
      stoppedBy = error.localizedDescription
    }
    lock.unlock()
  }

  /** Whether a stream is running, or why not. */
  private func running() throws {
    lock.lock()
    defer { lock.unlock() }
    if active == nil { throw Failure(stoppedBy.map { "the stream stopped: \($0)" } ?? "the stream isn't running") }
  }

  /**
   * Streams the display `displayID` at `width`×`height` pixels, leaving out every window of the
   * app with process id `pid` (the overlay, the chat, any it opens later). Replies once the first
   * frame is in.
   */
  func start(displayID: CGDirectDisplayID, pid: pid_t, width: Int, height: Int) throws -> [String: Any] {
    stop()
    let content: SCShareableContent = try blocking("Listing what can be captured") { done in
      SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { c, e in done(c, e) }
    }
    guard let display = content.displays.first(where: { $0.displayID == displayID }) ?? content.displays.first else {
      throw Failure("no display to capture")
    }
    // The app as a whole when it's listed, so windows it opens later are left out too. It may not
    // be listed (no window of its own on screen yet): then its windows as they are now, and the
    // app hides the overlay for each capture as it does without the stream.
    let mine = content.applications.filter { $0.processID == pid }
    let appExcluded = !mine.isEmpty
    let filter = appExcluded
      ? SCContentFilter(display: display, excludingApplications: mine, exceptingWindows: [])
      : SCContentFilter(display: display, excludingWindows: content.windows.filter { $0.owningApplication?.processID == pid })

    let config = SCStreamConfiguration()
    config.width = max(1, width)
    config.height = max(1, height)
    // At most 30 frames a second, and only when something changed.
    config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    config.showsCursor = false
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.colorSpaceName = CGColorSpace.sRGB
    config.queueDepth = 5
    config.capturesAudio = false

    let s = SCStream(filter: filter, configuration: config, delegate: self)
    try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: frameQueue)
    let bar = menuBarPoints(display.displayID)
    lock.lock()
    menuBar = bar.width > 0 ? bar.height * Double(config.width) / bar.width : 0
    active = s
    latest = nil
    stoppedBy = nil
    let before = frames
    lock.unlock()
    let _: Bool = try blocking("Starting the stream") { done in
      s.startCapture { e in done(e == nil ? true : nil, e) }
    }
    // The first frame, so a capture straight after has something to show.
    let t = nowMs()
    while nowMs() - t < 2000 {
      lock.lock()
      let got = frames > before
      lock.unlock()
      if got { return ["appExcluded": appExcluded, "w": config.width, "h": config.height, "menuBar": menuBar, "ms": nowMs() - t] }
      Thread.sleep(forTimeInterval: 0.01)
    }
    stop()
    throw Failure("the stream sent no frame")
  }

  func stop() {
    lock.lock()
    let s = active
    active = nil
    latest = nil
    lock.unlock()
    guard let s else { return }
    let done = DispatchSemaphore(value: 0)
    s.stopCapture { _ in done.signal() }
    _ = done.wait(timeout: .now() + 2)
  }

  /** How many times the screen has changed, and how long it has been still. */
  func changesNow() throws -> [String: Any] {
    try running()
    lock.lock()
    defer { lock.unlock() }
    return ["count": changes, "stillMs": nowMs() - changedAt, "frames": frames, "area": lastArea]
  }

  /** The last complete frames, for seeing on a real Mac what redraws and what counts. */
  func recentFrames() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    let now = nowMs()
    return ["frames": recent.map { f in f.merging(["ago": now - (f["t"] as? Double ?? now)]) { _, new in new } }]
  }

  /**
   * The newest frame as a JPEG of `w`×`h`, with `cover` (image pixels) painted grey with stripes,
   * as paintHidden in desktop.ts paints them. With `crop` (physical pixels from the display's
   * corner, which is `physicalW` wide), only that part, scaled to `w`×`h`.
   */
  func grab(w: Int, h: Int, cover: [CGRect], crop: CGRect?, physicalW: Double) throws -> [String: Any] {
    try running()
    lock.lock()
    let frame = latest
    lock.unlock()
    guard let pixels = frame else { throw Failure("no frame yet") }
    let t0 = nowMs()
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pixels) else { throw Failure("the frame has no pixels") }
    let bw = CVPixelBufferGetWidth(pixels)
    let bh = CVPixelBufferGetHeight(pixels)
    let rowBytes = CVPixelBufferGetBytesPerRow(pixels)
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let bitmapInfo = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    // The frame as an image without copying it; it's only drawn while the buffer is locked.
    guard
      let provider = CGDataProvider(dataInfo: nil, data: base, size: rowBytes * bh, releaseData: { _, _, _ in }),
      let image = CGImage(
        width: bw, height: bh, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: rowBytes, space: space,
        bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo), provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    else { throw Failure("the frame couldn't be read") }
    var source = image
    if let crop {
      let k = Double(bw) / max(1, physicalW)
      let r = CGRect(x: crop.minX * k, y: crop.minY * k, width: max(1, crop.width * k), height: max(1, crop.height * k)).integral
      guard let part = image.cropping(to: r) else { throw Failure("the close-up is off the screen") }
      source = part
    }
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: bitmapInfo) else {
      throw Failure("couldn't make a \(w)×\(h) picture")
    }
    ctx.interpolationQuality = .high
    ctx.draw(source, in: CGRect(x: 0, y: 0, width: w, height: h))
    let t1 = nowMs()
    if !cover.isEmpty, let data = ctx.data {
      // The bitmap's first row is the picture's top row, as `cover` counts them.
      let px = data.bindMemory(to: UInt8.self, capacity: ctx.bytesPerRow * h)
      let stride = ctx.bytesPerRow
      for r in cover {
        let x0 = max(0, Int(r.minX.rounded(.down)))
        let y0 = max(0, Int(r.minY.rounded(.down)))
        let x1 = min(w, Int(r.maxX.rounded(.up)))
        let y1 = min(h, Int(r.maxY.rounded(.up)))
        if x1 <= x0 || y1 <= y0 { continue }
        for y in y0..<y1 {
          for x in x0..<x1 {
            let v: UInt8 = (x + y) % 16 < 3 ? 0x6e : 0x9a
            let i = y * stride + x * 4
            px[i] = v
            px[i + 1] = v
            px[i + 2] = v
            px[i + 3] = 0xff
          }
        }
      }
    }
    let t2 = nowMs()
    guard let picture = ctx.makeImage() else { throw Failure("couldn't finish the picture") }
    let jpeg = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(jpeg as CFMutableData, "public.jpeg" as CFString, 1, nil) else {
      throw Failure("couldn't encode a JPEG")
    }
    CGImageDestinationAddImage(dest, picture, [kCGImageDestinationLossyCompressionQuality: 0.75] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw Failure("couldn't encode a JPEG") }
    let t3 = nowMs()
    return [
      "jpeg": (jpeg as Data).base64EncodedString(), "w": w, "h": h,
      "ms": ["draw": t1 - t0, "cover": t2 - t1, "encode": t3 - t2],
    ]
  }
}

// MARK: - Requests

func number(_ s: String?) throws -> Double {
  guard let s, let v = Double(s), v.isFinite else { throw Failure("expected a number, got \(s ?? "nothing")") }
  return v
}

func rects(_ json: String) throws -> [CGRect] {
  guard let data = json.data(using: .utf8), let list = try JSONSerialization.jsonObject(with: data) as? [[String: Double]] else {
    throw Failure("expected a list of rectangles")
  }
  return list.map { CGRect(x: $0["x"] ?? 0, y: $0["y"] ?? 0, width: $0["w"] ?? 0, height: $0["h"] ?? 0) }
}

@available(macOS 12.3, *)
func handle(_ capture: Capture, _ op: String, _ args: [String]) throws -> [String: Any] {
  switch op {
  case "start":
    return try capture.start(
      displayID: CGDirectDisplayID(try number(args.first)), pid: pid_t(try number(args.count > 1 ? args[1] : nil)),
      width: Int(try number(args.count > 2 ? args[2] : nil)), height: Int(try number(args.count > 3 ? args[3] : nil)))
  case "stop":
    capture.stop()
    return [:]
  case "changes":
    return try capture.changesNow()
  case "recent":
    return capture.recentFrames()
  case "grab":
    guard args.count >= 5 else { throw Failure("grab needs w h cover crop physicalW") }
    let crop = args[3] == "null" ? nil : try rects("[\(args[3])]").first
    return try capture.grab(w: Int(try number(args[0])), h: Int(try number(args[1])), cover: try rects(args[2]), crop: crop, physicalW: try number(args[4]))
  default:
    throw Failure("unknown request \(op)")
  }
}

// MARK: - Main

if CommandLine.arguments.contains("--selftest") {
  // Checks only: CGPreflightScreenCaptureAccess never prompts.
  send(["selftest": true, "os": osVersion(), "arch": arch, "sck": sckAvailable(), "permission": CGPreflightScreenCaptureAccess(), "display": mainDisplay()])
  exit(0)
}

// A window-server connection before ScreenCaptureKit is used, as an app has; never in the Dock.
_ = NSApplication.shared
NSApplication.shared.setActivationPolicy(.prohibited)
_ = CGMainDisplayID()

let permission = CGPreflightScreenCaptureAccess()
send(["ready": true, "os": osVersion(), "arch": arch, "sck": sckAvailable(), "permission": permission, "display": mainDisplay()])

Thread {
  if #available(macOS 12.3, *), permission {
    let capture = Capture()
    while let line = readLine() {
      let words = line.split(separator: " ").map(String.init)
      guard words.count >= 2, let id = Int(words[0]) else { continue }
      do {
        var reply = try handle(capture, words[1], Array(words.dropFirst(2)))
        reply["id"] = id
        reply["ok"] = true
        send(reply)
      } catch let f as Failure {
        send(["id": id, "ok": false, "error": f.message])
      } catch {
        send(["id": id, "ok": false, "error": error.localizedDescription])
      }
    }
    capture.stop()
  } else {
    // Nothing it can do; the app falls back to its own captures after reading the ready line.
    while let line = readLine() {
      if let id = Int(line.split(separator: " ").first ?? "") { send(["id": id, "ok": false, "error": "screen capture isn't available"]) }
    }
  }
  exit(0)
}.start()

RunLoop.main.run()
