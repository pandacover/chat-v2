// The Windows control host, inlined so it ships inside app.asar with no extra resources:
// windows.ts writes both files to %LOCALAPPDATA%/chat-v2/computer-host/<hash>/ and runs host.ps1 from there.
// host.ps1 compiles host.cs once and keeps the DLL beside it.
// Edit the C# here; it must stay C# 5 for the .NET Framework compiler PowerShell uses.

export const HOST_PS1 = String.raw`# chat-v2's Windows control host for computer use: compiles host.cs once (cached by content
# hash), then serves JSON-line requests on stdin until stdin closes.
param([int]$ElectronPid = 0)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

$src = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'host.cs')
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = ([BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($src))) -replace '-', '').Substring(0, 16)
$dll = Join-Path $PSScriptRoot "ChatV2Host-$hash.dll"

if (-not (Test-Path $dll)) {
  # Compile to a private file, then move it into place: two hosts starting at
  # once (a second chat-v2, parallel tests) must not write the same DLL.
  $tmp = Join-Path $PSScriptRoot "ChatV2Host-$hash-$PID.dll"
  Add-Type -TypeDefinition $src -Language CSharp -OutputAssembly $tmp -OutputType Library -ReferencedAssemblies @(
    'System.Drawing', 'System.Data', 'System.Web.Extensions', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'
  )
  try { Move-Item -LiteralPath $tmp -Destination $dll -ErrorAction Stop }
  catch { if (-not (Test-Path $dll)) { throw } }
  Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing, System.Data, System.Web.Extensions
Add-Type -Path $dll

[ChatV2Host]::Init($ElectronPid)
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

# The request loop lives in C# so both lanes can share stdout safely.
[ChatV2Host]::Serve()
`

export const HOST_CS = String.raw`// chat-v2's Windows control host for computer use. Compiled once by host.ps1 (C# 5 / .NET Framework,
// so no string interpolation, no ?. operator, no expression-bodied members).
// Protocol: one JSON request per stdin line {id, method, params}; one JSON
// response per stdout line {id, ok, result | error}. Responses can arrive out
// of order (see Serve), so callers match them by id.
//
// Coordinates are PHYSICAL pixels on the virtual desktop: the process opts into
// per-monitor-v2 DPI awareness before touching any window, so capture,
// SetCursorPos and UI Automation rectangles all agree at 125% / 150% scaling.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Data.OleDb;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static class ChatV2Host
{
    // ---------------------------------------------------------------- native
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr tok);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr tok, int cls, out int info, int len, out int retLen);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetWindowRect(IntPtr h, int attr, out RECT v, int size);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr h, POINT p, uint flags);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
    const uint MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4, MOUSEEVENTF_RIGHTDOWN = 0x8, MOUSEEVENTF_RIGHTUP = 0x10,
               MOUSEEVENTF_MIDDLEDOWN = 0x20, MOUSEEVENTF_MIDDLEUP = 0x40, MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_HWHEEL = 0x1000;

    static IntPtr remembered = IntPtr.Zero; // written by "remember" (immediate lane), read everywhere
    static uint ownerPid = 0; // the Electron main process; its windows are chat-v2's
    static Dictionary<int, AutomationElement> elements = new Dictionary<int, AutomationElement>();

    public static void Init(int electronPid)
    {
        ownerPid = (uint)electronPid;
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } // PER_MONITOR_AWARE_V2
    }

    // ---------------------------------------------------------------- serve
    // Requests run in one of two lanes, so a slow call never delays a cheap one:
    //  - serial: input, focus, capture and UI Automation, one at a time and in
    //    order, on the thread that called Serve (the PowerShell main thread);
    //  - immediate: read-only queries (cursor, remember, window list, search)
    //    on the thread pool, answered as soon as they arrive.
    // Responses carry the request id and may come back out of order.
    // "cancel" stops the serial request in progress at its next safe point and
    // fails the ones queued before it with "Cancelled".
    static readonly object outLock = new object();
    static readonly System.Collections.Concurrent.BlockingCollection<Job> serial = new System.Collections.Concurrent.BlockingCollection<Job>();
    static int cancelGen = 0; // bumped by every cancel; read with Gen()
    [ThreadStatic] static int runningGen;

    class Job
    {
        public object Id;
        public string Method;
        public Dictionary<string, object> P;
        public int Gen;
    }

    static readonly HashSet<string> Immediate = new HashSet<string>(new string[] {
        "ping", "cursor", "remember", "foreground", "windows", "sql"
    });

    static JavaScriptSerializer NewJson() { return new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 }; }

    static int Gen() { return System.Threading.Interlocked.CompareExchange(ref cancelGen, 0, 0); }

    /** Throw at a safe point if a cancel arrived after the current serial request was queued. */
    static void CheckCancel()
    {
        if (runningGen != Gen()) throw new OperationCanceledException("Cancelled");
    }

    /** One writer for stdout: responses from both lanes share it. */
    static void Emit(string line)
    {
        lock (outLock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    public static void Serve()
    {
        var reader = new System.Threading.Thread(ReadLoop);
        reader.IsBackground = true;
        reader.Start();
        foreach (var job in serial.GetConsumingEnumerable())
        {
            if (job.Gen != Gen()) { Emit(Fail(job.Id, "Cancelled")); continue; }
            runningGen = job.Gen;
            Emit(Run(job));
        }
    }

    static void ReadLoop()
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                Job job;
                try { job = Parse(line); }
                catch (Exception e) { Emit(Fail(null, e.Message)); continue; }
                if (job.Method == "cancel")
                {
                    System.Threading.Interlocked.Increment(ref cancelGen);
                    Emit(Ok(job.Id, true));
                }
                else if (Immediate.Contains(job.Method))
                {
                    var j = job;
                    System.Threading.ThreadPool.QueueUserWorkItem(delegate (object s) { Emit(Run(j)); });
                }
                else serial.Add(job);
            }
        }
        catch (Exception e) { try { Console.Error.WriteLine("Reader failed: " + e.Message); } catch { } }
        finally { serial.CompleteAdding(); }
    }

    static Job Parse(string line)
    {
        var req = (Dictionary<string, object>)NewJson().DeserializeObject(line);
        var job = new Job();
        job.Id = req.ContainsKey("id") ? req["id"] : null;
        job.Method = req.ContainsKey("method") ? Convert.ToString(req["method"]) : "";
        job.P = req.ContainsKey("params") && req["params"] is Dictionary<string, object>
            ? (Dictionary<string, object>)req["params"] : new Dictionary<string, object>();
        job.Gen = Gen();
        return job;
    }

    static string Ok(object id, object result)
    {
        var ok = new Dictionary<string, object>();
        ok["id"] = id; ok["ok"] = true; ok["result"] = result;
        return NewJson().Serialize(ok);
    }

    static string Fail(object id, string message)
    {
        var err = new Dictionary<string, object>();
        err["id"] = id; err["ok"] = false; err["error"] = message;
        return NewJson().Serialize(err);
    }

    static string Run(Job job)
    {
        try { return Ok(job.Id, Dispatch(job.Method, job.P)); }
        catch (Exception e) { return Fail(job.Id, e.InnerException != null ? e.InnerException.Message : e.Message); }
    }

    // ---------------------------------------------------------------- dispatch
    static object Dispatch(string method, Dictionary<string, object> p)
    {
        switch (method)
        {
            case "ping": return "pong";
            case "sleep": // diagnostics and tests: hold the serial lane, cancellable
                {
                    var until = DateTime.UtcNow.AddMilliseconds(Math.Min(Int(p, "ms", 100), 10000));
                    while (DateTime.UtcNow < until) { CheckCancel(); System.Threading.Thread.Sleep(5); }
                    return true;
                }
            case "remember": remembered = ExternalForeground(); return Describe(remembered);
            case "restoreFocus": return RestoreFocus();
            case "foreground": return Describe(TargetWindow());
            case "windows": return ListWindows();
            case "focusWindow": return FocusWindow(Str(p, "title"));
            case "screenshot": return Screenshot(Int(p, "maxWidth", 1280));
            case "cursor": { POINT pt; GetCursorPos(out pt); return Pt(pt.X, pt.Y); }
            case "move": SetCursorPos(Int(p, "x"), Int(p, "y")); return true;
            case "click": return Click(Int(p, "x"), Int(p, "y"), Str(p, "button", "left"), Int(p, "count", 1));
            case "drag": return Drag(Int(p, "x1"), Int(p, "y1"), Int(p, "x2"), Int(p, "y2"));
            case "scroll": return Scroll(Int(p, "x"), Int(p, "y"), Int(p, "dy", 0), Int(p, "dx", 0));
            case "type": TypeText(Str(p, "text")); return true;
            case "keys": return Keys(Str(p, "combo"));
            case "uiTree": return UiTree(Int(p, "max", 250), Int(p, "budgetMs", 2500), Long(p, "hwnd"));
            case "invoke": return Invoke(Int(p, "id"));
            case "setValue": return SetValue(Int(p, "id"), Str(p, "text"));
            case "elementRect": return ElementRect(Int(p, "id"));
            case "elementAt": return ElementAt(Int(p, "x"), Int(p, "y"));
            case "pointAt": return PointAt(Int(p, "x"), Int(p, "y"), Int(p, "budgetMs", 1500));
            case "sql": return Sql(Str(p, "query"));
            case "open":
                {
                    // Shell-execute: files, folders, URLs, ms-settings: URIs, and apps
                    // registered under App Paths ("chrome", "winword", "notepad").
                    var psi = new ProcessStartInfo(Str(p, "target"));
                    psi.UseShellExecute = true;
                    Process.Start(psi);
                    return true;
                }
            case "reveal":
                Process.Start("explorer.exe", "/select,\"" + Str(p, "path").Replace("\"", "") + "\"");
                return true;
            default: throw new Exception("Unknown method " + method);
        }
    }

    // ---------------------------------------------------------------- windows
    static bool IsOwn(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;
        uint pid; GetWindowThreadProcessId(h, out pid);
        return ownerPid != 0 && pid == ownerPid;
    }

    /**
     * The foreground window, ignoring chat-v2's own windows. The user types requests into
     * chat-v2, so it is usually in front: then the app they were in is the topmost app window
     * under it, which is where Windows keeps the window that was in front before.
     */
    static IntPtr ExternalForeground()
    {
        var fg = GetForegroundWindow();
        if (fg != IntPtr.Zero && !IsOwn(fg) && !IsShell(fg)) return fg;
        var top = TopAppWindow();
        return top != IntPtr.Zero ? top : remembered;
    }

    /** The desktop, taskbars, Start and the task switcher take the foreground but aren't the user's app. */
    static readonly HashSet<string> ShellClasses = new HashSet<string>(new string[] {
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "XamlExplorerHostIslandWindow",
        "MultitaskingViewFrame", "ForegroundStaging", "TaskSwitcherWnd", "Windows.UI.Core.CoreWindow", "NotifyIconOverflowWindow"
    });

    static bool IsShell(IntPtr h)
    {
        var cls = new StringBuilder(256);
        GetClassName(h, cls, 256);
        return ShellClasses.Contains(cls.ToString());
    }

    /** The first visible, titled, non-minimized app window in z-order (top first) that isn't chat-v2's. */
    static IntPtr TopAppWindow()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h) || IsIconic(h) || IsOwn(h) || IsShell(h)) return true;
            if (Title(h).Length == 0) return true;
            if ((GetWindowLong(h, -20) & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
            int cloaked; // suspended UWP apps and windows on other virtual desktops
            if (DwmGetWindowAttribute(h, 14 /* DWMWA_CLOAKED */, out cloaked, 4) == 0 && cloaked != 0) return true;
            found = h;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    /** The window the agent is working in: the remembered one when chat-v2 is in front. */
    static IntPtr TargetWindow()
    {
        var fg = GetForegroundWindow();
        if (fg != IntPtr.Zero && !IsOwn(fg)) return fg;
        return (remembered != IntPtr.Zero && IsWindow(remembered)) ? remembered : fg;
    }

    static string Title(IntPtr h)
    {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }

    static object Describe(IntPtr h)
    {
        var d = new Dictionary<string, object>();
        if (h == IntPtr.Zero) { d["title"] = ""; d["process"] = ""; return d; }
        uint pid; GetWindowThreadProcessId(h, out pid);
        string proc = "";
        try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
        d["hwnd"] = h.ToInt64();
        d["title"] = Title(h);
        d["process"] = proc;
        d["elevated"] = IsElevated(pid);
        d["hostElevated"] = IsElevated((uint)Process.GetCurrentProcess().Id);
        d["monitor"] = MonitorRect(h);
        return d;
    }

    static bool IsElevated(uint pid)
    {
        IntPtr proc = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (proc == IntPtr.Zero) return true; // access denied: almost always an elevated process
        IntPtr tok;
        bool elevated = false;
        if (OpenProcessToken(proc, 0x8, out tok))
        {
            int val, len;
            if (GetTokenInformation(tok, 20, out val, 4, out len)) elevated = val != 0; // TokenElevation
            CloseHandle(tok);
        }
        CloseHandle(proc);
        return elevated;
    }

    static Dictionary<string, object> MonitorRect(IntPtr h)
    {
        var mon = MonitorFromWindow(h, 2); // MONITOR_DEFAULTTONEAREST
        var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        GetMonitorInfo(mon, ref mi);
        return Rect(mi.rcMonitor.Left, mi.rcMonitor.Top, mi.rcMonitor.Right - mi.rcMonitor.Left, mi.rcMonitor.Bottom - mi.rcMonitor.Top);
    }

    static object ListWindows()
    {
        var list = new List<object>();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h) || IsOwn(h)) return true;
            var t = Title(h);
            if (t.Length == 0) return true;
            if ((GetWindowLong(h, -20) & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
            uint pid; GetWindowThreadProcessId(h, out pid);
            string proc = "";
            try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
            var d = new Dictionary<string, object>();
            d["title"] = t; d["process"] = proc; d["minimized"] = IsIconic(h);
            list.Add(d);
            return list.Count < 40;
        }, IntPtr.Zero);
        return list;
    }

    static bool Activate(IntPtr h)
    {
        if (h == IntPtr.Zero || !IsWindow(h)) return false;
        if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
        uint pid;
        uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        uint me = GetCurrentThreadId();
        // Any injected input makes us "the process that received the last input",
        // which lifts the foreground lock. F24 is a key no app binds; Alt would
        // open the target's menu bar.
        KeyTap(0x87);
        AttachThreadInput(me, fgThread, true);
        BringWindowToTop(h);
        bool ok = SetForegroundWindow(h);
        AttachThreadInput(me, fgThread, false);
        return ok;
    }

    static object RestoreFocus()
    {
        var fg = GetForegroundWindow();
        if (!IsOwn(fg)) return Describe(fg);
        if (remembered != IntPtr.Zero) Activate(remembered);
        return Describe(GetForegroundWindow());
    }

    static object FocusWindow(string title)
    {
        IntPtr found = IntPtr.Zero;
        string needle = title.ToLowerInvariant();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h) || IsOwn(h)) return true;
            var t = Title(h);
            uint pid; GetWindowThreadProcessId(h, out pid);
            string proc = "";
            try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
            if (t.Length > 0 && (t.ToLowerInvariant().Contains(needle) || proc.ToLowerInvariant() == needle)) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) throw new Exception("No open window matches \"" + title + "\"");
        Activate(found);
        remembered = found;
        return Describe(found);
    }

    // ---------------------------------------------------------------- capture
    static object Screenshot(int maxWidth)
    {
        var target = TargetWindow();
        var m = MonitorRect(target);
        int x = (int)m["x"], y = (int)m["y"], w = (int)m["width"], h = (int)m["height"];
        using (var full = new Bitmap(w, h, PixelFormat.Format24bppRgb))
        {
            using (var g = Graphics.FromImage(full)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            double scale = w > maxWidth ? (double)maxWidth / w : 1.0;
            int ow = (int)Math.Round(w * scale), oh = (int)Math.Round(h * scale);
            using (var outBmp = new Bitmap(ow, oh, PixelFormat.Format24bppRgb))
            {
                using (var g2 = Graphics.FromImage(outBmp))
                {
                    g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g2.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g2.DrawImage(full, 0, 0, ow, oh);
                }
                POINT cur; GetCursorPos(out cur);
                var jpeg = GetEncoder(ImageFormat.Jpeg);
                var ps = new EncoderParameters(1);
                ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 78L);
                using (var ms = new MemoryStream())
                {
                    outBmp.Save(ms, jpeg, ps);
                    var d = new Dictionary<string, object>();
                    d["data"] = Convert.ToBase64String(ms.ToArray());
                    d["mime"] = "image/jpeg";
                    d["imageWidth"] = ow; d["imageHeight"] = oh;
                    d["screen"] = m;
                    d["window"] = Describe(target);
                    return d;
                }
            }
        }
    }

    static ImageCodecInfo GetEncoder(ImageFormat f)
    {
        foreach (var c in ImageCodecInfo.GetImageDecoders()) if (c.FormatID == f.Guid) return c;
        return null;
    }

    // ---------------------------------------------------------------- input
    static void Send(params INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

    static INPUT Mouse(uint flags, uint data)
    {
        var i = new INPUT(); i.type = INPUT_MOUSE; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i;
    }

    static INPUT Key(ushort vk, ushort scan, uint flags)
    {
        var i = new INPUT(); i.type = INPUT_KEYBOARD; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i;
    }

    static void KeyTap(ushort vk) { Send(Key(vk, 0, 0), Key(vk, 0, KEYEVENTF_KEYUP)); }

    static object Click(int x, int y, string button, int count)
    {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(30);
        uint down = MOUSEEVENTF_LEFTDOWN, up = MOUSEEVENTF_LEFTUP;
        if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
        else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
        for (int i = 0; i < Math.Max(1, count); i++)
        {
            CheckCancel();
            Send(Mouse(down, 0), Mouse(up, 0));
            System.Threading.Thread.Sleep(45);
        }
        return Pt(x, y);
    }

    static object Drag(int x1, int y1, int x2, int y2)
    {
        SetCursorPos(x1, y1); System.Threading.Thread.Sleep(40);
        CheckCancel();
        Send(Mouse(MOUSEEVENTF_LEFTDOWN, 0));
        try
        {
            for (int s = 1; s <= 12; s++)
            {
                CheckCancel();
                SetCursorPos(x1 + (x2 - x1) * s / 12, y1 + (y2 - y1) * s / 12);
                System.Threading.Thread.Sleep(15);
            }
        }
        finally { Send(Mouse(MOUSEEVENTF_LEFTUP, 0)); } // never leave the button held
        return Pt(x2, y2);
    }

    static object Scroll(int x, int y, int dy, int dx)
    {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(20);
        if (dy != 0) Send(Mouse(MOUSEEVENTF_WHEEL, unchecked((uint)(-dy * 120))));
        if (dx != 0) Send(Mouse(MOUSEEVENTF_HWHEEL, unchecked((uint)(dx * 120))));
        return true;
    }

    static void TypeText(string text)
    {
        foreach (char c in text)
        {
            CheckCancel(); // each character is a complete down+up, so stopping here leaves no key held
            if (c == '\r') continue;
            if (c == '\n') { KeyTap(0x0D); continue; }
            if (c == '\t') { KeyTap(0x09); continue; }
            Send(Key(0, c, KEYEVENTF_UNICODE), Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            System.Threading.Thread.Sleep(4);
        }
    }

    static readonly Dictionary<string, ushort> Vk = BuildVk();
    static readonly HashSet<ushort> Extended = new HashSet<ushort>(new ushort[] { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C });

    static Dictionary<string, ushort> BuildVk()
    {
        var m = new Dictionary<string, ushort>();
        m["ctrl"] = 0x11; m["control"] = 0x11; m["shift"] = 0x10; m["alt"] = 0x12; m["option"] = 0x12;
        m["win"] = 0x5B; m["windows"] = 0x5B; m["meta"] = 0x5B; m["super"] = 0x5B; m["cmd"] = 0x11; m["command"] = 0x11;
        m["enter"] = 0x0D; m["return"] = 0x0D; m["esc"] = 0x1B; m["escape"] = 0x1B; m["tab"] = 0x09; m["space"] = 0x20;
        m["backspace"] = 0x08; m["delete"] = 0x2E; m["del"] = 0x2E; m["insert"] = 0x2D;
        m["up"] = 0x26; m["down"] = 0x28; m["left"] = 0x25; m["right"] = 0x27;
        m["home"] = 0x24; m["end"] = 0x23; m["pageup"] = 0x21; m["pagedown"] = 0x22;
        m["printscreen"] = 0x2C; m["capslock"] = 0x14; m["menu"] = 0x5D;
        m["plus"] = 0xBB; m["minus"] = 0xBD; m["comma"] = 0xBC; m["period"] = 0xBE; m["slash"] = 0xBF;
        for (int i = 1; i <= 24; i++) m["f" + i] = (ushort)(0x6F + i);
        for (char c = 'a'; c <= 'z'; c++) m[c.ToString()] = (ushort)char.ToUpperInvariant(c);
        for (char c = '0'; c <= '9'; c++) m[c.ToString()] = (ushort)c;
        return m;
    }

    static List<ushort> ParseCombo(string combo)
    {
        var parts = combo.ToLowerInvariant().Replace(" ", "").Split('+');
        var vks = new List<ushort>();
        foreach (var part in parts)
        {
            if (part.Length == 0) continue;
            ushort vk;
            if (!Vk.TryGetValue(part, out vk)) throw new Exception("Unknown key \"" + part + "\" in " + combo);
            vks.Add(vk);
        }
        return vks;
    }

    static object Keys(string combo)
    {
        var vks = ParseCombo(combo);
        var seq = new List<INPUT>();
        foreach (var vk in vks) seq.Add(Key(vk, 0, Extended.Contains(vk) ? KEYEVENTF_EXTENDEDKEY : 0));
        for (int i = vks.Count - 1; i >= 0; i--) seq.Add(Key(vks[i], 0, KEYEVENTF_KEYUP | (Extended.Contains(vks[i]) ? KEYEVENTF_EXTENDEDKEY : 0)));
        Send(seq.ToArray());
        return true;
    }

    // ---------------------------------------------------------------- UI Automation
    static readonly HashSet<ControlType> Interactive = new HashSet<ControlType>(new ControlType[] {
        ControlType.Button, ControlType.CheckBox, ControlType.ComboBox, ControlType.Edit, ControlType.Hyperlink,
        ControlType.ListItem, ControlType.MenuItem, ControlType.RadioButton, ControlType.Slider, ControlType.Spinner,
        ControlType.TabItem, ControlType.TreeItem, ControlType.SplitButton, ControlType.DataItem, ControlType.MenuBar,
        ControlType.Document
    });

    static Condition treeCondition, snapCondition; // built on first use (serial lane only)

    /** Not offscreen AND one of the control types we report, so UI Automation filters before marshalling. */
    static Condition TypeCondition(bool withText, bool snapOnly)
    {
        var types = new List<Condition>();
        foreach (var ct in Interactive)
        {
            if (snapOnly && (ct == ControlType.Document || ct == ControlType.MenuBar)) continue;
            types.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, ct));
        }
        if (withText) types.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text));
        return new AndCondition(new PropertyCondition(AutomationElement.IsOffscreenProperty, false), new OrCondition(types.ToArray()));
    }

    /**
     * Search under "root" for "cond", one top-level branch at a time: the tree
     * walker steps from branch to branch, and FindAll searches inside each
     * (a single call for native UIA providers such as Chromium, WPF and XAML,
     * where a manual walk costs 2-3x more). Stops between branches once
     * "budgetMs" has passed (the first branch is always searched) or when
     * "visit" returns false. Call with "cr" active. True when it stopped early.
     * Measured on legacy MSAA-proxied trees (WinForms, Win32), each node costs
     * ~15 ms whichever way it is read, so only a budget keeps those bounded.
     */
    static bool FindInBranches(AutomationElement root, Condition cond, CacheRequest cr, int budgetMs, Func<AutomationElement, bool> visit)
    {
        var clock = Stopwatch.StartNew();
        var walker = TreeWalker.ControlViewWalker;
        AutomationElement branch = null;
        try { branch = walker.GetFirstChild(root, cr); } catch { }
        bool first = true;
        while (branch != null)
        {
            CheckCancel();
            if (!first && clock.ElapsedMilliseconds > budgetMs) return true;
            first = false;
            AutomationElementCollection found = null;
            try { found = branch.FindAll(TreeScope.Subtree, cond); } catch { } // the branch went away mid-walk
            if (found != null)
                foreach (AutomationElement el in found)
                    if (!visit(el)) return true;
            try { branch = walker.GetNextSibling(branch, cr); } catch { branch = null; }
        }
        return false;
    }

    /**
     * Interactive controls (then short text labels) of the target window, up to
     * "max", within about "budgetMs" (see FindInBranches); the result says
     * "truncated" when either limit cut the search short.
     */
    static object UiTree(int max, int budgetMs, long hwnd)
    {
        elements.Clear();
        var target = hwnd != 0 ? new IntPtr(hwnd) : TargetWindow();
        if (target == IntPtr.Zero) throw new Exception("No foreground window");
        if (treeCondition == null) treeCondition = TypeCondition(true, false);
        var clock = Stopwatch.StartNew();
        var root = AutomationElement.FromHandle(target);
        var cr = new CacheRequest();
        cr.Add(AutomationElement.NameProperty);
        cr.Add(AutomationElement.ControlTypeProperty);
        cr.Add(AutomationElement.BoundingRectangleProperty);
        cr.Add(AutomationElement.IsEnabledProperty);
        cr.TreeScope = TreeScope.Element;
        var outList = new List<object>();
        var texts = new List<object>();
        int nextId = 1;
        bool truncated = false;
        using (cr.Activate())
        {
            truncated = FindInBranches(root, treeCondition, cr, budgetMs, delegate (AutomationElement el)
            {
                ControlType ct;
                string name;
                System.Windows.Rect r;
                try { ct = el.Cached.ControlType; name = el.Cached.Name ?? ""; r = el.Cached.BoundingRectangle; }
                catch { return true; }
                if (r.IsEmpty || r.Width < 2 || r.Height < 2) return true;
                bool interactive = Interactive.Contains(ct);
                bool label = ct == ControlType.Text && name.Length > 0 && name.Length < 80;
                if (!interactive && !label) return true;
                if (!interactive && texts.Count > max / 3) return true;
                int id = nextId++;
                elements[id] = el;
                var d = new Dictionary<string, object>();
                d["id"] = id;
                d["type"] = ct.ProgrammaticName.Replace("ControlType.", "");
                d["name"] = name.Length > 120 ? name.Substring(0, 120) : name;
                d["x"] = (int)r.X; d["y"] = (int)r.Y; d["width"] = (int)r.Width; d["height"] = (int)r.Height;
                bool enabled = true; try { enabled = el.Cached.IsEnabled; } catch { }
                if (!enabled) d["disabled"] = true;
                if (interactive) outList.Add(d); else texts.Add(d);
                return outList.Count + texts.Count < max;
            });
        }
        outList.AddRange(texts);
        var res = new Dictionary<string, object>();
        res["window"] = Describe(target);
        res["elements"] = outList;
        if (truncated) res["truncated"] = true;
        res["ms"] = clock.ElapsedMilliseconds;
        return res;
    }

    static AutomationElement Element(int id)
    {
        AutomationElement el;
        if (!elements.TryGetValue(id, out el)) throw new Exception("Element " + id + " is stale; call ui_tree again");
        return el;
    }

    static object ElementRect(int id)
    {
        var r = Element(id).Current.BoundingRectangle;
        return Rect((int)r.X, (int)r.Y, (int)r.Width, (int)r.Height);
    }

    /** A control a highlight can snap to: interactive, not a whole document, containing the point, not huge. */
    static bool Snappable(AutomationElement el, int x, int y, double limit, out System.Windows.Rect r)
    {
        r = System.Windows.Rect.Empty;
        ControlType ct;
        try { ct = el.Cached.ControlType; r = el.Cached.BoundingRectangle; } catch { return false; }
        if (!Interactive.Contains(ct) || ct == ControlType.Document || ct == ControlType.MenuBar) return false;
        if (r.IsEmpty || r.Width < 4 || r.Height < 4 || !r.Contains(x, y)) return false;
        return r.Width * r.Height <= limit;
    }

    /**
     * The control under a screen point, for snapping a pixel-targeted highlight
     * onto the real control: the smallest interactive control containing it.
     * Fast path: UIA's FromPoint, then walk up to the first such control. Many
     * apps answer FromPoint with the top-level pane or a big layout group; then
     * search the window under the point the way ui_elements does, with the
     * control-type filter inside UIA. Null for nothing sensible, for big
     * containers, and for chat-v2's own windows.
     * Leaves the ui_elements id cache untouched.
     */
    static object ElementAt(int x, int y)
    {
        var pt = new POINT { X = x, Y = y };
        var hwnd = GetAncestor(WindowFromPoint(pt), 2 /* GA_ROOT */);
        if (hwnd == IntPtr.Zero) return null;
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        if (pid == ownerPid) return null;
        AutomationElement found;
        System.Windows.Rect r;
        if (!SnapIn(hwnd, x, y, 1500, out found, out r)) return null;
        return Rect((int)r.X, (int)r.Y, (int)r.Width, (int)r.Height);
    }

    /**
     * The smallest interactive control of window "hwnd" containing the point (see ElementAt),
     * with its name and type in the element's cache. A fallback search of the window stops
     * after about "budgetMs".
     */
    static bool SnapIn(IntPtr hwnd, int x, int y, int budgetMs, out AutomationElement found, out System.Windows.Rect rect)
    {
        found = null;
        rect = System.Windows.Rect.Empty;
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        var mon = MonitorRect(hwnd);
        double limit = Convert.ToDouble(mon["width"]) * Convert.ToDouble(mon["height"]) * 0.2;
        if (snapCondition == null) snapCondition = TypeCondition(false, true);
        var cr = new CacheRequest();
        cr.Add(AutomationElement.ControlTypeProperty);
        cr.Add(AutomationElement.BoundingRectangleProperty);
        cr.Add(AutomationElement.ProcessIdProperty);
        cr.Add(AutomationElement.NameProperty);
        cr.TreeScope = TreeScope.Element;
        System.Windows.Rect r;
        using (cr.Activate())
        {
            AutomationElement hit = null;
            try { hit = AutomationElement.FromPoint(new System.Windows.Point(x, y)); } catch { }
            if (hit != null)
            {
                // FromPoint doesn't skip click-through overlays the way WindowFromPoint
                // does (and lands in another process for UWP frames): only trust a hit
                // from the window's own process, else search that window below.
                int hitPid = 0; try { hitPid = hit.Cached.ProcessId; } catch { }
                if (hitPid != (int)pid) hit = null;
            }
            // Something else covers the point (the Point overlay takes the mouse): start from the
            // deepest child window there, which in Win32 apps is often the control itself.
            AutomationElement under = null;
            if (hit == null)
            {
                var child = DeepestChild(hwnd, x, y);
                if (child != hwnd) try { under = AutomationElement.FromHandle(child).GetUpdatedCache(cr); } catch { }
                hit = under;
            }
            if (hit != null)
            {
                var walker = TreeWalker.ControlViewWalker;
                var el = hit;
                for (int depth = 0; el != null && depth < 30; depth++)
                {
                    if (Snappable(el, x, y, limit, out r)) { found = el; rect = r; return true; }
                    ControlType ct = null; System.Windows.Rect er = System.Windows.Rect.Empty;
                    try { ct = el.Cached.ControlType; er = el.Cached.BoundingRectangle; } catch { }
                    // Ancestors only get bigger: past the window or the size limit nothing can qualify.
                    if (ct == ControlType.Window || (!er.IsEmpty && er.Width * er.Height > limit)) break;
                    try { el = walker.GetParent(el, cr); } catch { el = null; }
                }
            }
            // FromPoint stopped at something that isn't a control (Chromium can answer
            // with a big layout group that doesn't even hold the control on top):
            // search the window (or the child window under the point) with the filter inside UIA.
            System.Windows.Rect best = System.Windows.Rect.Empty;
            AutomationElement bestEl = null;
            double bestArea = double.MaxValue;
            AutomationElement root = under;
            if (root == null) root = AutomationElement.FromHandle(hwnd);
            FindInBranches(root, snapCondition, cr, budgetMs, delegate (AutomationElement el)
            {
                System.Windows.Rect er;
                if (Snappable(el, x, y, limit, out er) && er.Width * er.Height < bestArea) { best = er; bestEl = el; bestArea = er.Width * er.Height; }
                return true;
            });
            if (best.IsEmpty) return false;
            found = bestEl;
            rect = best;
            return true;
        }
    }

    /** The deepest visible child window of "hwnd" under a screen point. */
    static IntPtr DeepestChild(IntPtr hwnd, int x, int y)
    {
        var h = hwnd;
        for (int i = 0; i < 32; i++)
        {
            var pt = new POINT { X = x, Y = y };
            if (!ScreenToClient(h, ref pt)) return h;
            var c = ChildWindowFromPointEx(h, pt, 1 | 4 /* CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT */);
            if (c == IntPtr.Zero || c == h) return h;
            h = c;
        }
        return h;
    }

    /**
     * For the user's Point: the app window under a screen point, and the control there if
     * there is a sensible one. Unlike ElementAt it looks past chat-v2's own windows, since the
     * Point overlay covers the screen and takes the mouse while the user points. Null when no
     * window is there.
     */
    static object PointAt(int x, int y, int budgetMs)
    {
        IntPtr hwnd = IntPtr.Zero;
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h) || IsIconic(h) || IsOwn(h)) return true;
            if ((GetWindowLong(h, -20) & 0x20) != 0) return true; // WS_EX_TRANSPARENT: other apps' click-through overlays
            int cloaked; // suspended UWP apps and windows on other virtual desktops
            if (DwmGetWindowAttribute(h, 14 /* DWMWA_CLOAKED */, out cloaked, 4) == 0 && cloaked != 0) return true;
            RECT wr;
            // The visible frame, without the invisible resize borders GetWindowRect counts.
            if (DwmGetWindowRect(h, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out wr, Marshal.SizeOf(typeof(RECT))) != 0 && !GetWindowRect(h, out wr)) return true;
            if (x < wr.Left || x >= wr.Right || y < wr.Top || y >= wr.Bottom) return true;
            hwnd = h;
            return false;
        }, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) return null;
        var res = new Dictionary<string, object>();
        res["window"] = Describe(hwnd);
        AutomationElement el;
        System.Windows.Rect r;
        if (SnapIn(hwnd, x, y, budgetMs, out el, out r))
        {
            var c = Rect((int)r.X, (int)r.Y, (int)r.Width, (int)r.Height);
            string type = "", name = "";
            try { type = el.Cached.ControlType.ProgrammaticName.Replace("ControlType.", ""); } catch { }
            try { name = el.Cached.Name ?? ""; } catch { }
            c["type"] = type;
            c["name"] = name.Length > 120 ? name.Substring(0, 120) : name;
            res["control"] = c;
        }
        else res["control"] = null;
        return res;
    }

    static object Invoke(int id)
    {
        var el = Element(id);
        object pat;
        if (el.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) { ((InvokePattern)pat).Invoke(); return "invoked"; }
        if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pat)) { ((TogglePattern)pat).Toggle(); return "toggled"; }
        if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) { ((SelectionItemPattern)pat).Select(); return "selected"; }
        if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat))
        {
            var ec = (ExpandCollapsePattern)pat;
            if (ec.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) ec.Expand(); else ec.Collapse();
            return "expanded/collapsed";
        }
        var r = el.Current.BoundingRectangle;
        Click((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2), "left", 1);
        return "clicked";
    }

    static object SetValue(int id, string text)
    {
        var el = Element(id);
        object pat;
        if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) { ((ValuePattern)pat).SetValue(text); return "set"; }
        el.SetFocus();
        TypeText(text);
        return "typed";
    }

    // ---------------------------------------------------------------- Windows Search
    static object Sql(string query)
    {
        var rows = new List<object>();
        using (var conn = new OleDbConnection("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';"))
        {
            conn.Open();
            using (var cmd = new OleDbCommand(query, conn))
            using (var rd = cmd.ExecuteReader())
            {
                while (rd.Read())
                {
                    var d = new Dictionary<string, object>();
                    for (int i = 0; i < rd.FieldCount; i++)
                    {
                        var v = rd.IsDBNull(i) ? null : rd.GetValue(i);
                        if (v is DateTime) v = ((DateTime)v).ToUniversalTime().ToString("o");
                        else if (v is decimal || v is ulong || v is long) v = Convert.ToDouble(v);
                        else if (v is string[]) v = string.Join(";", (string[])v);
                        else if (v is Array) v = null;
                        d[rd.GetName(i)] = v;
                    }
                    rows.Add(d);
                }
            }
        }
        return rows;
    }

    // ---------------------------------------------------------------- helpers
    static Dictionary<string, object> Rect(int x, int y, int w, int h)
    {
        var d = new Dictionary<string, object>(); d["x"] = x; d["y"] = y; d["width"] = w; d["height"] = h; return d;
    }
    static Dictionary<string, object> Pt(int x, int y)
    {
        var d = new Dictionary<string, object>(); d["x"] = x; d["y"] = y; return d;
    }
    static string Str(Dictionary<string, object> p, string k, string def = "")
    {
        return p.ContainsKey(k) && p[k] != null ? Convert.ToString(p[k]) : def;
    }
    static int Int(Dictionary<string, object> p, string k, int def = 0)
    {
        return p.ContainsKey(k) && p[k] != null ? (int)Math.Round(Convert.ToDouble(p[k])) : def;
    }
    static long Long(Dictionary<string, object> p, string k)
    {
        return p.ContainsKey(k) && p[k] != null ? Convert.ToInt64(p[k]) : 0;
    }
}
`
