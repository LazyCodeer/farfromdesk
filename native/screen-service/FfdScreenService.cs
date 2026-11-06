// FarFromDesk Screen Helper: lets the owner's phone see and use the Windows lock screen.
//
// Windows keeps the lock screen (and UAC prompts) on the secure "Winlogon" desktop, which no
// process running as the user can capture or send input to. Remote-desktop tools solve this with
// a service: this is FarFromDesk's. It is installed only when the owner turns it on (one admin
// prompt), lives in Program Files so no user program can replace it, and works like this:
//
//   service mode  (run by Windows as LocalSystem)
//     Serves one named pipe, \\.\pipe\farfromdesk-screen, that only the installing user (and
//     SYSTEM) may open. For each connection it checks the caller is that user, in the active
//     console session, and that the console belongs to that user; then it starts the agent in
//     that session and relays lines between the pipe and the agent until either side closes.
//
//   agent mode    (started by the service, as SYSTEM, inside the owner's console session)
//     Reads one JSON request per line on stdin and answers one JSON line on stdout, the same
//     protocol as native/remote-windows.ps1 (state, capture, mouse, scroll, key, text). Before
//     every request it attaches to whichever desktop has input: the normal desktop, or the lock
//     screen. It refuses everything while a UAC consent prompt is on screen, so the phone can
//     never approve an elevation, and it works only for the console session it was started in.
//
// Built with the C# 5 compiler that ships with .NET Framework 4.x (see prepare_desktop_backend.mjs).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

[assembly: System.Reflection.AssemblyTitle("FarFromDesk Screen Helper")]
[assembly: System.Reflection.AssemblyProduct("FarFromDesk")]

namespace FarFromDesk.Screen {

static class Native {
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll")] public static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQueryUserToken(uint session, out IntPtr token);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool SetTokenInformation(IntPtr token, int infoClass, ref uint info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("userenv.dll", SetLastError = true)] public static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
  [DllImport("userenv.dll")] public static extern bool DestroyEnvironmentBlock(IntPtr env);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, int size);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr process, uint code);

  [StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  public static string TokenUserSid(IntPtr token) {
    using (var id = new WindowsIdentity(token)) return id.User == null ? null : id.User.Value;
  }
  public static string ProcessUserSid(uint pid) {
    IntPtr process = OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid), token;
    if (process == IntPtr.Zero) return null;
    try { if (!OpenProcessToken(process, 0x0008 /* QUERY */, out token)) return null; try { return TokenUserSid(token); } finally { CloseHandle(token); } }
    finally { CloseHandle(process); }
  }
}

// ---------------------------------------------------------------- service mode
class ScreenService : ServiceBase {
  public const string PipeName = "farfromdesk-screen";
  readonly string user;
  Thread loop; volatile bool stopping;
  public ScreenService(string userSid) { user = userSid; ServiceName = "FarFromDeskScreen"; CanStop = true; }

  protected override void OnStart(string[] args) { loop = new Thread(Serve); loop.IsBackground = true; loop.Start(); }
  protected override void OnStop() {
    stopping = true;
    // Unblock WaitForConnection with a throwaway connection of our own.
    try { using (var c = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut)) c.Connect(200); } catch { }
  }

  static void Log(string text, EventLogEntryType type) {
    try { EventLog.WriteEntry("FarFromDeskScreen", text, type); } catch { }
  }

  PipeSecurity Security() {
    var s = new PipeSecurity();
    s.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(user), PipeAccessRights.ReadWrite, AccessControlType.Allow));
    s.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
    return s;
  }

  void Serve() {
    while (!stopping) {
      NamedPipeServerStream pipe = null;
      try {
        pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 1 << 16, 1 << 16, Security());
        pipe.WaitForConnection();
        if (stopping) break;
        string refusal = Check(pipe);
        if (refusal != null) { Write(pipe, "{\"id\":0,\"ok\":false,\"error\":\"" + refusal + "\"}"); continue; }
        Relay(pipe);
      } catch (Exception e) { if (!stopping) { Log("Screen helper connection failed: " + e.Message, EventLogEntryType.Warning); Thread.Sleep(500); } }
      finally { if (pipe != null) { try { pipe.Dispose(); } catch { } } }
    }
  }

  static void Write(Stream s, string line) { var b = Encoding.UTF8.GetBytes(line + "\n"); try { s.Write(b, 0, b.Length); s.Flush(); } catch { } }

  /// Null when the caller may use the screen, else a refusal code.
  string Check(NamedPipeServerStream pipe) {
    uint pid, callerSession; uint console = Native.WTSGetActiveConsoleSessionId();
    if (!Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out pid)) return "CALLER_UNKNOWN";
    if (!string.Equals(Native.ProcessUserSid(pid), user, StringComparison.OrdinalIgnoreCase)) return "CALLER_NOT_OWNER";
    if (!Native.ProcessIdToSessionId(pid, out callerSession) || callerSession != console) return "NOT_CONSOLE_SESSION";
    IntPtr token;
    if (console == 0xFFFFFFFF || !Native.WTSQueryUserToken(console, out token)) return "NO_CONSOLE_USER";
    try { if (!string.Equals(Native.TokenUserSid(token), user, StringComparison.OrdinalIgnoreCase)) return "CONSOLE_NOT_OWNER"; }
    finally { Native.CloseHandle(token); }
    return null;
  }

  /// Starts the agent as SYSTEM inside the console session and pipes lines both ways.
  void Relay(NamedPipeServerStream pipe) {
    uint console = Native.WTSGetActiveConsoleSessionId();
    IntPtr self, token, env = IntPtr.Zero, childIn, ourIn, ourOut, childOut;
    if (!Native.OpenProcessToken(Native.GetCurrentProcess(), 0x000F01FF /* ALL_ACCESS */, out self)) throw new Win32Exception();
    try {
      if (!Native.DuplicateTokenEx(self, 0x02000000 /* MAXIMUM_ALLOWED */, IntPtr.Zero, 2 /* Impersonation */, 1 /* Primary */, out token)) throw new Win32Exception();
    } finally { Native.CloseHandle(self); }
    var sa = new Native.SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(sa); sa.bInheritHandle = true;
    Native.PROCESS_INFORMATION pi = new Native.PROCESS_INFORMATION();
    try {
      if (!Native.SetTokenInformation(token, 12 /* TokenSessionId */, ref console, 4)) throw new Win32Exception();
      if (!Native.CreatePipe(out childIn, out ourIn, ref sa, 0) || !Native.CreatePipe(out ourOut, out childOut, ref sa, 0)) throw new Win32Exception();
      Native.SetHandleInformation(ourIn, 1, 0); Native.SetHandleInformation(ourOut, 1, 0);
      Native.CreateEnvironmentBlock(out env, token, false);
      var si = new Native.STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = "winsta0\\default";
      si.dwFlags = 0x00000100 /* USESTDHANDLES */ | 0x00000001 /* USESHOWWINDOW */; si.wShowWindow = 0;
      si.hStdInput = childIn; si.hStdOutput = childOut; si.hStdError = childOut;
      string exe = Process.GetCurrentProcess().MainModule.FileName;
      var cmd = new StringBuilder("\"" + exe + "\" agent");
      // CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
      if (!Native.CreateProcessAsUser(token, exe, cmd, IntPtr.Zero, IntPtr.Zero, true, 0x08000000 | 0x00000400, env, Path.GetDirectoryName(exe), ref si, out pi)) throw new Win32Exception();
      Native.CloseHandle(childIn); Native.CloseHandle(childOut); Native.CloseHandle(pi.hThread);
      using (var toAgent = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(ourIn, true), FileAccess.Write))
      using (var fromAgent = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(ourOut, true), FileAccess.Read)) {
        var down = new Thread(() => { try { fromAgent.CopyTo(pipe); } catch { } try { pipe.Dispose(); } catch { } });
        down.IsBackground = true; down.Start();
        try { var buffer = new byte[1 << 16]; int n; while ((n = pipe.Read(buffer, 0, buffer.Length)) > 0) { toAgent.Write(buffer, 0, n); toAgent.Flush(); } } catch { }
      }
    } finally {
      if (pi.hProcess != IntPtr.Zero) { Native.TerminateProcess(pi.hProcess, 0); Native.CloseHandle(pi.hProcess); }
      if (env != IntPtr.Zero) Native.DestroyEnvironmentBlock(env);
      Native.CloseHandle(token);
    }
  }
}

// ---------------------------------------------------------------- agent mode
static class Agent {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, WHEEL = 0x0800, HWHEEL = 0x1000, ABSOLUTE = 0x8000;
  const uint KEYUP = 0x0002, UNICODE = 0x0004, EXTENDED = 0x0001;

  static IntPtr attached = IntPtr.Zero;
  static uint session;

  /// Attaches this thread to the desktop that has input now; returns its name ("Default", "Winlogon").
  static string Attach() {
    IntPtr desk = OpenInputDesktop(0, false, 0x10000000 /* GENERIC_ALL */);
    if (desk == IntPtr.Zero) throw new InvalidOperationException("DESKTOP_UNAVAILABLE");
    if (!SetThreadDesktop(desk)) { CloseDesktop(desk); throw new InvalidOperationException("DESKTOP_UNAVAILABLE"); }
    if (attached != IntPtr.Zero) CloseDesktop(attached);
    attached = desk;
    var name = new StringBuilder(256); int needed;
    GetUserObjectInformation(desk, 2, name, name.Capacity * 2, out needed);
    return name.ToString();
  }

  /// A UAC consent prompt also shows on the secure desktop. It is never captured or clicked from the phone.
  static bool ConsentPrompt() {
    foreach (var p in Process.GetProcessesByName("consent")) { try { if (p.SessionId == session) return true; } catch { } finally { p.Dispose(); } }
    return false;
  }

  static byte[] Jpeg(Bitmap image, long quality) {
    ImageCodecInfo codec = null;
    foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
    var p = new EncoderParameters(1); p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
    using (var m = new MemoryStream()) { image.Save(m, codec, p); return m.ToArray(); }
  }
  static Size Fit(int w, int h, int max) {
    if (max <= 0 || (w <= max && h <= max)) return new Size(w, h);
    double s = Math.Min((double)max / w, (double)max / h);
    return new Size(Math.Max(1, (int)Math.Round(w * s)), Math.Max(1, (int)Math.Round(h * s)));
  }
  static byte[] Capture(int max, long quality, out int width, out int height) {
    int w = GetSystemMetrics(0), h = GetSystemMetrics(1);
    var size = Fit(w, h, max); width = size.Width; height = size.Height;
    using (var full = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(full)) g.CopyFromScreen(0, 0, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
      if (size.Width == w && size.Height == h) return Jpeg(full, quality);
      using (var scaled = new Bitmap(size.Width, size.Height, PixelFormat.Format24bppRgb)) {
        using (var g = Graphics.FromImage(scaled)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(full, 0, 0, size.Width, size.Height); }
        return Jpeg(scaled, quality);
      }
    }
  }
  static byte[] Notice(string title, string body, int max, long quality, out int width, out int height) {
    var size = Fit(GetSystemMetrics(0), GetSystemMetrics(1), max); width = size.Width; height = size.Height;
    using (var b = new Bitmap(size.Width, size.Height, PixelFormat.Format24bppRgb))
    using (var g = Graphics.FromImage(b))
    using (var t = new Font("Segoe UI", Math.Max(12, size.Height / 18), FontStyle.Bold))
    using (var f = new Font("Segoe UI", Math.Max(9, size.Height / 34)))
    using (var center = new StringFormat()) {
      g.Clear(Color.FromArgb(16, 18, 22)); center.Alignment = StringAlignment.Center; center.LineAlignment = StringAlignment.Center;
      g.DrawString(title, t, Brushes.White, new RectangleF(0, 0, size.Width, size.Height * 0.9f), center);
      g.DrawString(body, f, Brushes.Gainsboro, new RectangleF(0, size.Height * 0.18f, size.Width, size.Height * 0.9f), center);
      return Jpeg(b, quality);
    }
  }

  static INPUT Mouse(uint flags, int dx, int dy, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags; return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.vk = vk; i.u.ki.scan = scan; i.u.ki.flags = flags; return i; }
  static void Send(INPUT[] inputs) { if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new InvalidOperationException("INPUT_BLOCKED"); }
  static int Abs(double v) { return (int)Math.Round(Math.Min(1, Math.Max(0, v)) * 65535); }
  static bool Extended(int vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B; }

  static void Click(double x, double y, bool right, int count) {
    int dx = Abs(x), dy = Abs(y);
    Send(new[] { Mouse(MOVE | ABSOLUTE, dx, dy, 0) });
    for (int n = 0; n < Math.Max(1, Math.Min(3, count)); n++)
      Send(new[] { Mouse((right ? RIGHTDOWN : LEFTDOWN) | ABSOLUTE, dx, dy, 0), Mouse((right ? RIGHTUP : LEFTUP) | ABSOLUTE, dx, dy, 0) });
  }
  static void Scroll(double x, double y, string direction, int amount) {
    Send(new[] { Mouse(MOVE | ABSOLUTE, Abs(x), Abs(y), 0) });
    bool horizontal = direction == "left" || direction == "right";
    int delta = (direction == "up" || direction == "right" ? 120 : -120) * Math.Max(1, Math.Min(20, amount));
    Send(new[] { Mouse((horizontal ? HWHEEL : WHEEL) | ABSOLUTE, Abs(x), Abs(y), unchecked((uint)delta)) });
  }
  static void Press(int vk, int[] modifiers) {
    var seq = new List<INPUT>();
    foreach (int m in modifiers) seq.Add(Key((ushort)m, 0, Extended(m) ? EXTENDED : 0));
    seq.Add(Key((ushort)vk, 0, Extended(vk) ? EXTENDED : 0));
    seq.Add(Key((ushort)vk, 0, KEYUP | (Extended(vk) ? EXTENDED : 0)));
    for (int i = modifiers.Length - 1; i >= 0; i--) seq.Add(Key((ushort)modifiers[i], 0, KEYUP | (Extended(modifiers[i]) ? EXTENDED : 0)));
    Send(seq.ToArray());
  }
  static void Type(string text) { foreach (char c in text) Send(new[] { Key(0, c, UNICODE), Key(0, c, UNICODE | KEYUP) }); }

  static double Num(Dictionary<string, object> r, string k) { object v; return r.TryGetValue(k, out v) && v != null ? Convert.ToDouble(v) : 0; }
  static string Str(Dictionary<string, object> r, string k) { object v; return r.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : ""; }

  public static int Run() {
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { SetProcessDPIAware(); }
    SetThreadExecutionState(0x80000000u | 0x00000001u | 0x00000002u);
    session = (uint)Process.GetCurrentProcess().SessionId;
    var json = new JavaScriptSerializer(); json.MaxJsonLength = int.MaxValue;
    var utf8 = new UTF8Encoding(false);
    var input = new StreamReader(Console.OpenStandardInput(), utf8);
    var output = new StreamWriter(Console.OpenStandardOutput(), utf8); output.AutoFlush = true;
    string line;
    while ((line = input.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      object id = null;
      try {
        var r = json.Deserialize<Dictionary<string, object>>(line);
        r.TryGetValue("id", out id);
        string op = Str(r, "op"), desktop = Attach();
        bool locked = !string.Equals(desktop, "Default", StringComparison.OrdinalIgnoreCase);
        bool secure = locked && ConsentPrompt();
        var answer = new Dictionary<string, object>(); answer["id"] = id; answer["ok"] = true; answer["locked"] = locked; answer["interactive"] = true;
        if (op == "state") { answer["secure"] = secure; }
        else if (op == "capture") {
          int w, h, max = (int)Num(r, "max"); long q = (long)Num(r, "quality");
          byte[] bytes = secure
            ? Notice("A Windows security prompt is open", "Answer it at the PC. The phone cannot see or touch it.", max, q, out w, out h)
            : Capture(max, q, out w, out h);
          answer["width"] = w; answer["height"] = h; answer["jpeg"] = Convert.ToBase64String(bytes);
        } else if (op == "mouse" || op == "scroll" || op == "key" || op == "text") {
          if (secure) throw new InvalidOperationException("SECURE_PROMPT");
          if (op == "mouse") Click(Num(r, "x"), Num(r, "y"), Str(r, "button") == "right", (int)Num(r, "count"));
          else if (op == "scroll") Scroll(Num(r, "x"), Num(r, "y"), Str(r, "direction"), (int)Num(r, "amount"));
          else if (op == "key") {
            var mods = new List<int>(); object m;
            if (r.TryGetValue("modifiers", out m) && m is System.Collections.ArrayList) foreach (var v in (System.Collections.ArrayList)m) mods.Add(Convert.ToInt32(v));
            Press((int)Num(r, "vk"), mods.ToArray());
          } else Type(Str(r, "text"));
        } else throw new InvalidOperationException("UNKNOWN_OP");
        output.WriteLine(json.Serialize(answer));
      } catch (Exception e) {
        string code = e is InvalidOperationException ? e.Message : "HELPER_ERROR";
        var fail = new Dictionary<string, object>(); fail["id"] = id; fail["ok"] = false; fail["error"] = code;
        output.WriteLine(json.Serialize(fail));
      }
    }
    return 0;
  }
}

static class Program {
  static int Main(string[] args) {
    if (args.Length >= 1 && args[0] == "agent") return Agent.Run();
    if (args.Length >= 3 && args[0] == "service" && args[1] == "--user") {
      // Refuse anything but a plain user SID: the pipe is opened to exactly this account.
      var sid = new SecurityIdentifier(args[2]);
      if (!sid.IsAccountSid()) return 2;
      ServiceBase.Run(new ScreenService(sid.Value));
      return 0;
    }
    Console.Error.WriteLine("FarFromDesk Screen Helper runs as a Windows service. Turn it on in FarFromDesk: Settings > Remote control.");
    return 1;
  }
}
}
