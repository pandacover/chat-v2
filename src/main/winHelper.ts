import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import type { DesktopState, WindowInfo } from '@shared/computer'
import type { Driver } from './driver'
import { helperProcess, runCommand } from './helperProcess'

// Windows input and window inspection for computer use, without native modules: one long-lived
// PowerShell process compiles a small C# class over user32 and answers one request per line.
//
// Requests are a line of space-separated words (text is base64, so it holds no spaces):
//   <id> state | click hwnd x y left|right|middle count post|auto|pointer | hover hwnd x y
//   <id> drag hwnd x0 y0 x1 y1 | borrowdrag hwnd x0 y0 x1 y1 | wheel hwnd x y dx dy | hit hwnd x y
//   <id> element hwnd x y | text <base64 utf-8> | keys vk,vk,... | focus hwnd | affinity hwnd
// Replies are one JSON object per line: {"id":1,"ok":true,...} or {"id":1,"ok":false,"error":"..."}.
// Coordinates are physical screen pixels: the process opts into per-monitor DPI awareness first,
// so nothing is scaled behind our back on a 125% or 150% display.
//
// The mouse is moved only where nothing else works, and only when the user allows it. Clicks,
// drags and scrolls are posted to the window under the point, as the messages the real mouse
// would have produced, so the user keeps their pointer. Some apps take only the real mouse: their
// content ignores posted clicks (UWP and WinUI apps, XAML islands in File Explorer and the
// taskbar, WPF), and many follow a drag only from it (drag and drop between panels, a clip onto a
// timeline). There a click or drag borrows the pointer, moves it through the action and puts it
// back where the user left it, in under a second ("auto" clicks, borrowdrag), as does a click
// sent again after the same one posted did nothing ("pointer"). Keys and text go through
// SendInput, which doesn't touch the mouse either; they reach the foreground window.

export const HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace ChatV2 {
public static class Helper {
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  // Sent only by BorrowDrag; it also sets the size of INPUT, which SendInput checks.
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT p, uint flags);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hwnd, ref POINT p);
  [DllImport("user32.dll")] static extern bool PhysicalToLogicalPointForPerMonitorDPI(IntPtr hwnd, ref POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")] static extern IntPtr GetClassLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);

  // Within one state read only: Windows reuses process ids, so a name kept longer could vouch
  // for a different (protected) app that later got the same id.
  static readonly Dictionary<uint, string> exeCache = new Dictionary<uint, string>();

  static string Exe(uint pid) {
    string name;
    if (exeCache.TryGetValue(pid, out name)) return name;
    name = "";
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h != IntPtr.Zero) {
      var sb = new StringBuilder(1024);
      int size = sb.Capacity;
      if (QueryFullProcessImageName(h, 0, sb, ref size)) name = System.IO.Path.GetFileName(sb.ToString());
      CloseHandle(h);
    }
    exeCache[pid] = name;
    return name;
  }

  static string Esc(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  static string Text(IntPtr hwnd, bool cls) {
    var sb = new StringBuilder(512);
    if (cls) GetClassName(hwnd, sb, sb.Capacity); else GetWindowText(hwnd, sb, sb.Capacity);
    return sb.ToString();
  }

  // UWP apps (Settings among them) live inside an ApplicationFrameHost window; the app is a child.
  static uint HostedPid(IntPtr hwnd, uint hostPid) {
    uint found = 0;
    EnumChildWindows(hwnd, (child, _) => {
      uint pid;
      GetWindowThreadProcessId(child, out pid);
      if (pid != hostPid) { found = pid; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static string State() {
    exeCache.Clear();
    POINT cur;
    GetCursorPos(out cur);
    var fg = GetForegroundWindow();
    var list = new List<string>();
    EnumWindows((hwnd, _) => {
      if (list.Count >= 80 || !IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
      int cloaked;
      if (DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      RECT r;
      // The frame bounds leave out the invisible resize border GetWindowRect includes.
      if (DwmGetWindowAttribute(hwnd, 9, out r, 16) != 0) GetWindowRect(hwnd, out r);
      if (r.Right - r.Left < 2 || r.Bottom - r.Top < 2) return true;
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      string exe = Exe(pid);
      if (exe.Equals("ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) {
        uint inner = HostedPid(hwnd, pid);
        if (inner != 0) { pid = inner; exe = Exe(inner); }
      }
      int ex = GetWindowLong(hwnd, -20);
      list.Add("{\"hwnd\":" + hwnd.ToInt64() + ",\"pid\":" + pid + ",\"exe\":" + Esc(exe) +
        ",\"title\":" + Esc(Text(hwnd, false)) + ",\"cls\":" + Esc(Text(hwnd, true)) +
        ",\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"w\":" + (r.Right - r.Left) + ",\"h\":" + (r.Bottom - r.Top) +
        ",\"clickThrough\":" + ((ex & 0x20) != 0 ? "true" : "false") + "}");
      return true;
    }, IntPtr.Zero);
    return "\"cursor\":{\"x\":" + cur.X + ",\"y\":" + cur.Y + "},\"foreground\":" + fg.ToInt64() + ",\"windows\":[" + string.Join(",", list) + "]";
  }

  const uint KEYBOARD = 1;

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT { type = KEYBOARD };
    i.U.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
    return i;
  }

  static void Send(List<INPUT> inputs) {
    if (inputs.Count == 0) return;
    uint sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    // A window running as administrator silently refuses input from this one (UIPI).
    if (sent != inputs.Count) throw new Exception("Windows blocked the input (the window may be running as administrator)");
  }

  // --- The mouse, by message ---------------------------------------------------------------

  // A physical screen point as the window sees it: logical (for apps that aren't DPI aware), and
  // relative to its client area unless screen coordinates are asked for.
  static POINT Local(IntPtr hwnd, int x, int y, bool screen) {
    var p = new POINT { X = x, Y = y };
    PhysicalToLogicalPointForPerMonitorDPI(hwnd, ref p);
    if (screen) return p;
    IntPtr old = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(hwnd));
    try { ScreenToClient(hwnd, ref p); } finally { SetThreadDpiAwarenessContext(old); }
    return p;
  }

  // The innermost window under a point, inside top only: the guard checked top, so nothing
  // posted may land in another window. Skips hidden, disabled and see-through children (Chromium
  // apps have a transparent child over their content).
  static IntPtr Deepest(IntPtr top, int x, int y) {
    if (!IsWindow(top)) throw new Exception("That window is gone");
    IntPtr cur = top;
    for (int depth = 0; depth < 32; depth++) {
      IntPtr child = ChildWindowFromPointEx(cur, Local(cur, x, y, false), 1 | 2 | 4);
      if (child == IntPtr.Zero || child == cur) break;
      cur = child;
    }
    return cur;
  }

  static IntPtr Pack(POINT p) { return new IntPtr((p.Y << 16) | (p.X & 0xFFFF)); }

  static void Post(IntPtr hwnd, uint msg, int wParam, POINT p) {
    if (PostMessage(hwnd, msg, new IntPtr(wParam), Pack(p))) return;
    int error = Marshal.GetLastWin32Error();
    if (error == 5) throw new Exception("Windows blocked the click (the window may be running as administrator)");
    throw new Exception("The click could not be delivered (error " + error + ")");
  }

  const uint WM_MOUSEMOVE = 0x200;

  // Windows whose content ignores mouse messages posted to them, taking only the real mouse:
  // UWP and WinUI apps, XAML islands inside Win32 apps (File Explorer's bars, the Windows 11
  // taskbar, Notepad's menus and tabs), and WPF. Checked from the window under the point up to top.
  static bool IgnoresPosted(IntPtr top, IntPtr hwnd) {
    for (IntPtr w = hwnd; w != IntPtr.Zero; w = GetAncestor(w, 1)) {
      string cls = Text(w, true);
      if (cls.StartsWith("Windows.UI.") || cls.StartsWith("Microsoft.UI.") || cls.StartsWith("HwndWrapper[") || cls == "XamlExplorerHostIslandWindow") return true;
      if (w == top) break;
    }
    return false;
  }

  // A click: posted to the window ("post"), unless its content takes only the real mouse ("auto",
  // when the user lets the pointer be borrowed), or the real pointer is asked for ("pointer").
  // Says what it landed on, as UI Automation names it, so the model hears when it aimed wrong.
  static string ClickVia(IntPtr top, int x, int y, string which, int count, string mode) {
    if (!IsWindow(top)) throw new Exception("That window is gone");
    bool ignores = IgnoresPosted(top, Deepest(top, x, y));
    string on = ElementAt(top, x, y);
    string reply = ",\"ignores\":" + (ignores ? "true" : "false") + ",\"on\":" + Esc(on);
    if (mode == "pointer" || (mode == "auto" && ignores)) {
      RealClick(top, x, y, which, count);
      return "\"done\":true,\"via\":\"pointer\"" + reply;
    }
    Click(top, x, y, which, count);
    return "\"done\":true,\"via\":\"posted\"" + reply;
  }

  // --- What is at a point, by UI Automation ------------------------------------------------

  // UI Automation loading, from the start (see Run): a first look at the same time came back empty.
  static System.Threading.Tasks.Task warming;

  // The element of window top at a physical point, as "button \"Export\"", or "" when UI
  // Automation can't say in time (an app that's busy or hung must not hold a click up), or finds
  // something of another app there: an overlay over it, chat-v2's own included, which takes the
  // mouse while the user points at its Stop button.
  static string ElementAt(IntPtr top, int x, int y) {
    try {
      if (warming != null && !warming.Wait(1500)) return "";
      uint want;
      GetWindowThreadProcessId(top, out want);
      // A Store app's window belongs to its frame host; the app inside is another process.
      uint hosted = HostedPid(top, want);
      var task = System.Threading.Tasks.Task.Run(() => {
        var el = System.Windows.Automation.AutomationElement.FromPoint(new System.Windows.Point(x, y));
        if (el == null) return "";
        var info = el.Current;
        if (info.ProcessId != (int)want && (hosted == 0 || info.ProcessId != (int)hosted)) return "";
        string kind = KindOf(info.ControlType == null ? "" : info.ControlType.ProgrammaticName);
        string name = (info.Name ?? "").Trim();
        // An escape: PowerShell reads the script file as ANSI, so a literal ellipsis would garble.
        if (name.Length > 60) name = name.Substring(0, 60) + "…";
        return name.Length > 0 ? kind + " \"" + name + "\"" : kind;
      });
      return task.Wait(400) ? task.Result : "";
    } catch (Exception) { return ""; }
  }

  // "ControlType.TabItem" as "tab", "ControlType.SplitButton" as "split button".
  static string KindOf(string programmatic) {
    string t = programmatic.Replace("ControlType.", "");
    switch (t) {
      case "Edit": return "text field";
      case "Hyperlink": return "link";
      case "TabItem": return "tab";
      case "Custom": case "": return "element";
    }
    var b = new StringBuilder();
    foreach (char c in t) { if (char.IsUpper(c) && b.Length > 0) b.Append(' '); b.Append(char.ToLowerInvariant(c)); }
    return b.ToString();
  }

  static void Click(IntPtr top, int x, int y, string which, int count) {
    IntPtr hwnd = Deepest(top, x, y);
    POINT p = Local(hwnd, x, y, false);
    // The button's down message (up is +1, double-click +2), and its flag in wParam while held.
    uint down = which == "right" ? 0x204u : which == "middle" ? 0x207u : 0x201u;
    int held = which == "right" ? 0x2 : which == "middle" ? 0x10 : 0x1;
    bool dblclks = (GetClassLongPtr(hwnd, -26).ToInt64() & 0x8) != 0;
    Post(hwnd, WM_MOUSEMOVE, 0, p);
    for (int n = 0; n < Math.Max(1, count); n++) {
      // The second press of a double-click, for windows that ask for them.
      Post(hwnd, n == 1 && dblclks ? down + 2 : down, held, p);
      System.Threading.Thread.Sleep(30);
      Post(hwnd, down + 1, 0, p);
      if (n + 1 < count) System.Threading.Thread.Sleep(40);
    }
  }

  static void Hover(IntPtr top, int x, int y) {
    IntPtr hwnd = Deepest(top, x, y);
    Post(hwnd, WM_MOUSEMOVE, 0, Local(hwnd, x, y, false));
  }

  // The window pressed on keeps the whole drag, as it would with the mouse captured.
  static void Drag(IntPtr top, int x0, int y0, int x1, int y1) {
    IntPtr hwnd = Deepest(top, x0, y0);
    Post(hwnd, WM_MOUSEMOVE, 0, Local(hwnd, x0, y0, false));
    Post(hwnd, 0x201, 0x1, Local(hwnd, x0, y0, false));
    const int steps = 14;
    for (int i = 1; i <= steps; i++) {
      System.Threading.Thread.Sleep(28);
      Post(hwnd, WM_MOUSEMOVE, 0x1, Local(hwnd, x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, false));
    }
    Post(hwnd, 0x202, 0, Local(hwnd, x1, y1, false));
  }

  // --- Borrowing the pointer ------------------------------------------------------------------

  // An absolute move, in the 0..65535 range SendInput uses over the whole virtual desktop.
  static INPUT MoveTo(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    var i = new INPUT { type = 0 };
    i.U.mi = new MOUSEINPUT {
      dx = (int)(((long)(x - vx) * 65535) / Math.Max(1, vw - 1)),
      dy = (int)(((long)(y - vy) * 65535) / Math.Max(1, vh - 1)),
      dwFlags = 0x0001 | 0x8000 | 0x4000
    };
    return i;
  }

  static INPUT LeftButton(bool down) {
    var i = new INPUT { type = 0 };
    i.U.mi = new MOUSEINPUT { dwFlags = down ? 0x0002u : 0x0004u };
    return i;
  }

  static INPUT Button(uint flags) {
    var i = new INPUT { type = 0 };
    i.U.mi = new MOUSEINPUT { dwFlags = flags };
    return i;
  }

  static void One(INPUT input) { Send(new List<INPUT> { input }); }

  // The real pointer goes only where the window the guard checked is what the mouse would hit:
  // nothing has come up over the point since (a window of the same app, a tooltip say, is fine).
  static void StillThere(IntPtr top, int x, int y) {
    IntPtr at = WindowFromPoint(new POINT { X = x, Y = y });
    IntPtr root = at == IntPtr.Zero ? IntPtr.Zero : GetAncestor(at, 2);
    if (root == top) return;
    uint want, got = 0;
    GetWindowThreadProcessId(top, out want);
    if (root != IntPtr.Zero) GetWindowThreadProcessId(root, out got);
    if (root == IntPtr.Zero || got != want) throw new Exception("Something else is at that point now");
  }

  // A click with the real pointer: there, down and up in one go, so the user's own mouse moves
  // can't come in between, then back where the user left it.
  static void RealClick(IntPtr top, int x, int y, string which, int count) {
    StillThere(top, x, y);
    POINT home;
    GetCursorPos(out home);
    // Down; up is the next flag.
    uint down = which == "right" ? 0x0008u : which == "middle" ? 0x0020u : 0x0002u;
    var inputs = new List<INPUT> { MoveTo(x, y) };
    for (int n = 0; n < Math.Max(1, count); n++) { inputs.Add(Button(down)); inputs.Add(Button(down << 1)); }
    try {
      Send(inputs);
      // The app reads the click while the pointer is still there: some ask where it is.
      System.Threading.Thread.Sleep(50);
    } finally {
      SetCursorPos(home.X, home.Y);
    }
  }

  // A drag with the real mouse: down, through, up, and the pointer back where it was.
  static void BorrowDrag(IntPtr top, int x0, int y0, int x1, int y1) {
    StillThere(top, x0, y0);
    POINT home;
    GetCursorPos(out home);
    bool held = false;
    try {
      One(MoveTo(x0, y0));
      System.Threading.Thread.Sleep(40);
      One(LeftButton(true));
      held = true;
      System.Threading.Thread.Sleep(90);
      const int steps = 24;
      for (int i = 1; i <= steps; i++) {
        One(MoveTo(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps));
        System.Threading.Thread.Sleep(18);
      }
      // Drop targets light up on hover before they take a drop.
      System.Threading.Thread.Sleep(120);
      One(LeftButton(false));
      held = false;
    } finally {
      if (held) { try { One(LeftButton(false)); } catch (Exception) { } }
      System.Threading.Thread.Sleep(60);
      SetCursorPos(home.X, home.Y);
    }
  }

  // Wheel messages carry screen coordinates, and the distance (120 a notch) in the high word.
  // Content that ignores posted mouse messages ignores posted wheels too: with "auto" (the user
  // lets the pointer be borrowed), the real wheel turns there instead, as RealClick clicks.
  static string Wheel(IntPtr top, int x, int y, int dx, int dy, string mode) {
    IntPtr hwnd = Deepest(top, x, y);
    bool ignores = IgnoresPosted(top, hwnd);
    if (mode == "auto" && ignores) {
      RealWheel(top, x, y, dx, dy);
      return "\"done\":true,\"via\":\"pointer\",\"ignores\":true";
    }
    POINT p = Local(hwnd, x, y, true);
    if (dy != 0) Post(hwnd, 0x20A, dy << 16, p);
    if (dx != 0) Post(hwnd, 0x20E, dx << 16, p);
    return "\"done\":true,\"via\":\"posted\",\"ignores\":" + (ignores ? "true" : "false");
  }

  // The real wheel over a point: the pointer there, the wheel turned, the pointer back.
  static void RealWheel(IntPtr top, int x, int y, int dx, int dy) {
    StillThere(top, x, y);
    POINT home;
    GetCursorPos(out home);
    var inputs = new List<INPUT> { MoveTo(x, y) };
    if (dy != 0) { var i = Button(0x0800); i.U.mi.mouseData = unchecked((uint)dy); inputs.Add(i); }
    if (dx != 0) { var i = Button(0x1000); i.U.mi.mouseData = unchecked((uint)dx); inputs.Add(i); }
    try {
      Send(inputs);
      System.Threading.Thread.Sleep(50);
    } finally {
      SetCursorPos(home.X, home.Y);
    }
  }

  static bool Extended(int vk) {
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0xA3 || vk == 0xA5 || vk == 0x6F || vk == 0x90;
  }

  // With each key's scan code as well as its virtual key: apps that read the physical key (web
  // apps' KeyboardEvent.code, VS Code's shortcuts, games, remote desktops) got none and missed it.
  static void Keys(string csv) {
    var vks = new List<int>();
    foreach (var p in csv.Split(',')) if (p.Length > 0) vks.Add(int.Parse(p));
    var inputs = new List<INPUT>();
    foreach (var vk in vks) inputs.Add(Key((ushort)vk, (ushort)MapVirtualKey((uint)vk, 0), Extended(vk) ? 1u : 0u));
    for (int n = vks.Count - 1; n >= 0; n--) inputs.Add(Key((ushort)vks[n], (ushort)MapVirtualKey((uint)vks[n], 0), (Extended(vks[n]) ? 1u : 0u) | 2u));
    Send(inputs);
  }

  static void TypeText(string text) {
    var inputs = new List<INPUT>();
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { inputs.Add(Key(0x0D, 0, 0)); inputs.Add(Key(0x0D, 0, 2)); continue; }
      inputs.Add(Key(0, c, 4));
      inputs.Add(Key(0, c, 4 | 2));
    }
    // Small batches, so a long text doesn't overrun the app's input queue.
    for (int i = 0; i < inputs.Count; i += 64) {
      Send(inputs.GetRange(i, Math.Min(64, inputs.Count - i)));
      System.Threading.Thread.Sleep(8);
    }
  }

  static void Focus(IntPtr hwnd) {
    if (!IsWindow(hwnd)) throw new Exception("That window is gone");
    if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
    // Windows only lets the foreground process hand focus over; a lone Alt press counts as input.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
  }

  static IntPtr Hwnd(string s) { return new IntPtr(long.Parse(s)); }

  static string Handle(string[] a) {
    switch (a[1]) {
      case "state": return State();
      case "click": return ClickVia(Hwnd(a[2]), int.Parse(a[3]), int.Parse(a[4]), a[5], int.Parse(a[6]), a.Length > 7 ? a[7] : "post");
      case "hover": Hover(Hwnd(a[2]), int.Parse(a[3]), int.Parse(a[4])); return "\"done\":true";
      case "drag": Drag(Hwnd(a[2]), int.Parse(a[3]), int.Parse(a[4]), int.Parse(a[5]), int.Parse(a[6])); return "\"done\":true";
      case "wheel": return Wheel(Hwnd(a[2]), int.Parse(a[3]), int.Parse(a[4]), int.Parse(a[5]), int.Parse(a[6]), a.Length > 7 ? a[7] : "post");
      case "borrowdrag": BorrowDrag(Hwnd(a[2]), int.Parse(a[3]), int.Parse(a[4]), int.Parse(a[5]), int.Parse(a[6])); return "\"done\":true";
      case "hit": {
        // Read-only: which window a click there would go to, where in it, whether it takes posted
        // clicks, and what the real mouse would hit there.
        IntPtr top = Hwnd(a[2]);
        int x = int.Parse(a[3]), y = int.Parse(a[4]);
        IntPtr hwnd = Deepest(top, x, y);
        POINT p = Local(hwnd, x, y, false);
        IntPtr under = WindowFromPoint(new POINT { X = x, Y = y });
        return "\"hwnd\":" + hwnd.ToInt64() + ",\"cls\":" + Esc(Text(hwnd, true)) + ",\"root\":" + GetAncestor(hwnd, 2).ToInt64() + ",\"x\":" + p.X + ",\"y\":" + p.Y +
          ",\"ignores\":" + (IgnoresPosted(top, hwnd) ? "true" : "false") + ",\"under\":" + (under == IntPtr.Zero ? 0 : GetAncestor(under, 2).ToInt64());
      }
      // Read-only: what UI Automation says is at a point of a window.
      case "element": return "\"on\":" + Esc(ElementAt(Hwnd(a[2]), int.Parse(a[3]), int.Parse(a[4])));
      case "text": TypeText(Encoding.UTF8.GetString(Convert.FromBase64String(a.Length > 2 ? a[2] : ""))); return "\"done\":true";
      case "keys": Keys(a[2]); return "\"done\":true";
      case "focus": Focus(new IntPtr(long.Parse(a[2]))); return "\"done\":true";
      case "affinity": {
        uint v;
        GetWindowDisplayAffinity(new IntPtr(long.Parse(a[2])), out v);
        return "\"affinity\":" + v;
      }
      default: throw new Exception("unknown op " + a[1]);
    }
  }

  public static void Run() {
    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2. If it doesn't take (the process already had a
    // context), cursor positions are scaled on high-DPI screens and every click would miss.
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    bool aware = GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) == 2;
    // UI Automation loads its parts on first use; meanwhile, not on the first click.
    warming = System.Threading.Tasks.Task.Run(() => { try { System.Windows.Automation.AutomationElement.FromPoint(new System.Windows.Point(0, 0)); } catch (Exception) { } });
    Console.OutputEncoding = new UTF8Encoding(false);
    Console.Out.WriteLine("{\"ready\":true,\"dpiAware\":" + (aware ? "true" : "false") + "}");
    Console.Out.Flush();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      var a = line.Trim().Split(' ');
      if (a.Length < 2) continue;
      string reply;
      try { reply = "{\"id\":" + a[0] + ",\"ok\":true," + Handle(a) + "}"; }
      catch (Exception e) { reply = "{\"id\":" + a[0] + ",\"ok\":false,\"error\":" + Esc(e.Message) + "}"; }
      Console.Out.WriteLine(reply);
      Console.Out.Flush();
    }
  }
}
}
`

/** The PowerShell file that compiles and runs the helper. UI Automation and its types come from .NET Framework. */
export const HELPER_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition @'
${HELPER_SOURCE}
'@
[ChatV2.Helper]::Run()
`

/** What UI Automation names that isn't worth telling the model: a surface without a name. */
const UNTOLD = /^(pane|element|group|window|document|image|title bar)$/

/** Starts the helper on first use, and again if it dies. `scriptFile` is where the script is written. */
export const windowsDriver = (scriptFile: string): Driver => {
  let apps: Array<{ name: string; id: string }> | null = null
  const { request, stop, close } = helperProcess(
    () => {
      writeFileSync(scriptFile, HELPER_SCRIPT, 'utf8')
      return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], { windowsHide: true })
    },
    (ready) => (ready.dpiAware === false ? 'the input helper could not read the screen at its real resolution (DPI awareness)' : null)
  )

  return {
    state: async () => {
      const r = await request('state')
      return { cursor: r.cursor as DesktopState['cursor'], foreground: r.foreground as number, windows: r.windows as WindowInfo[] }
    },
    click: async (hwnd, x, y, button, count, opts) => {
      const mode = !opts?.borrow ? 'post' : opts.pointer ? 'pointer' : 'auto'
      const r = await request('click', hwnd, Math.round(x), Math.round(y), button, count, mode)
      // Asked for the pointer, the caller says why it used it.
      const how =
        r.via === 'pointer'
          ? opts?.pointer
            ? ''
            : "This app doesn't take clicks sent in the background, so I clicked with the real pointer, borrowed for a moment and put back."
          : r.ignores
            ? "This app doesn't take clicks sent in the background, and the user has turned off borrowing the real pointer, so the click most likely did nothing. Use the keyboard instead (Tab, Enter, Space, the arrow keys), or ask the user to click it."
            : ''
      // What was under the point, so a click that missed its target says what it hit instead. An
      // unnamed pane or group (all Chromium shows before it builds its tree) says nothing.
      const on = typeof r.on === 'string' && r.on && !UNTOLD.test(r.on) ? `It landed on the ${r.on}.` : ''
      return [how, on].filter(Boolean).join(' ') || null
    },
    hover: async (hwnd, x, y) => void (await request('hover', hwnd, Math.round(x), Math.round(y))),
    drag: async (hwnd, from, to, opts) => {
      if (!opts?.borrow) return void (await request('drag', hwnd, Math.round(from.x), Math.round(from.y), Math.round(to.x), Math.round(to.y)))
      await request('borrowdrag', hwnd, Math.round(from.x), Math.round(from.y), Math.round(to.x), Math.round(to.y))
      return 'Dragged with the real pointer, borrowed for a moment and put back.'
    },
    wheel: async (hwnd, x, y, dx, dy, opts) => {
      const r = await request('wheel', hwnd, Math.round(x), Math.round(y), Math.round(dx * 120), Math.round(dy * 120), opts?.borrow ? 'auto' : 'post')
      if (r.via === 'pointer') return "This app doesn't take scrolling sent in the background, so I scrolled with the real pointer, borrowed for a moment and put back."
      if (r.ignores) return "This app doesn't take scrolling sent in the background, and the user has turned off borrowing the real pointer, so it most likely didn't scroll. Use the keyboard instead (Page Down, Page Up, the arrow keys)."
      return null
    },
    text: async (text) => void (await request('text', Buffer.from(text, 'utf8').toString('base64'))),
    keys: async (vks) => void (await request('keys', vks.join(','))),
    focus: async (hwnd) => void (await request('focus', hwnd)),
    apps: async () => {
      if (apps) return apps
      const out = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress'])
      const list = JSON.parse(out.trim() || '[]') as Array<{ Name: string; AppID: string }> | { Name: string; AppID: string }
      apps = (Array.isArray(list) ? list : [list]).map((a) => ({ name: a.Name, id: a.AppID }))
      // Installs change the list; read it again in a while.
      setTimeout(() => (apps = null), 5 * 60 * 1000).unref()
      return apps
    },
    launch: async (id) => {
      // Opening through the Apps folder works for desktop and Store apps alike; some entries
      // (Steam games) are links instead.
      const target = /^[a-z][\w+.-]*:\/\//i.test(id) ? id : `shell:AppsFolder\\${id}`
      spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    },
    stop,
    close
  }
}
