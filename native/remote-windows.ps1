# Phone screen control on Windows: one long-lived helper per remote session.
#
# Reads one JSON request per line on stdin and answers one JSON line on stdout:
#   {"id":1,"op":"state"}                                  -> {"id":1,"ok":true,"locked":false}
#   {"id":2,"op":"capture","max":1400,"quality":60}        -> {"id":2,"ok":true,"width":..,"height":..,"jpeg":"<base64>"}
#   {"id":3,"op":"mouse","x":0.5,"y":0.5,"button":"left","count":1}
#   {"id":4,"op":"scroll","x":0.5,"y":0.5,"direction":"down","amount":3}
#   {"id":5,"op":"key","vk":13,"modifiers":[17]}
#   {"id":6,"op":"text","text":"hello"}
# A refusal is {"id":n,"ok":false,"error":"CODE"}. The C# below is compiled once, so a frame
# costs a screen copy and a JPEG encode, not a new PowerShell.
#
# Windows keeps the lock screen on a separate secure desktop that no user process can
# capture or type into, so while the PC is locked capture returns a plain placeholder frame
# and every input is refused with PC_LOCKED.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class FFDRemote {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }

  const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, WHEEL = 0x0800, HWHEEL = 0x1000, ABSOLUTE = 0x8000;
  const uint KEYUP = 0x0002, UNICODE = 0x0004, EXTENDED = 0x0001;

  public static void Init() {
    // Per-monitor aware (v2), so the screen is read and clicked in real pixels at 125-200% scaling.
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { SetProcessDPIAware(); }
    // Keep the display and the system awake while the phone is connected; released when this process exits.
    SetThreadExecutionState(0x80000000u | 0x00000001u | 0x00000002u);
  }

  /// The input desktop is "Default" while signed in and unlocked; the lock screen is "Winlogon",
  /// and while it shows a user process cannot even open the input desktop.
  public static bool Locked() {
    IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
    if (desktop == IntPtr.Zero) return true;
    try {
      StringBuilder name = new StringBuilder(256); int needed;
      if (!GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed)) return true;
      return !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
    } finally { CloseDesktop(desktop); }
  }

  static byte[] Jpeg(Bitmap image, long quality) {
    ImageCodecInfo codec = null;
    foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
    EncoderParameters p = new EncoderParameters(1);
    p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
    using (MemoryStream m = new MemoryStream()) { image.Save(m, codec, p); return m.ToArray(); }
  }

  static Size Fit(int w, int h, int max) {
    if (max <= 0 || (w <= max && h <= max)) return new Size(w, h);
    double s = Math.Min((double)max / w, (double)max / h);
    return new Size(Math.Max(1, (int)Math.Round(w * s)), Math.Max(1, (int)Math.Round(h * s)));
  }

  /// The primary display, the one absolute mouse input addresses, scaled to fit max.
  public static byte[] Capture(int max, long quality, out int width, out int height) {
    int w = GetSystemMetrics(0), h = GetSystemMetrics(1);
    Size size = Fit(w, h, max); width = size.Width; height = size.Height;
    using (Bitmap full = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(0, 0, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
      if (size.Width == w && size.Height == h) return Jpeg(full, quality);
      using (Bitmap scaled = new Bitmap(size.Width, size.Height, PixelFormat.Format24bppRgb)) {
        using (Graphics g = Graphics.FromImage(scaled)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(full, 0, 0, size.Width, size.Height); }
        return Jpeg(scaled, quality);
      }
    }
  }

  /// What the phone shows while Windows is locked: the real lock screen cannot be captured.
  public static byte[] LockedFrame(int max, long quality, out int width, out int height) {
    Size size = Fit(GetSystemMetrics(0), GetSystemMetrics(1), max); width = size.Width; height = size.Height;
    using (Bitmap b = new Bitmap(size.Width, size.Height, PixelFormat.Format24bppRgb))
    using (Graphics g = Graphics.FromImage(b))
    using (Font title = new Font("Segoe UI", Math.Max(12, size.Height / 18), FontStyle.Bold))
    using (Font body = new Font("Segoe UI", Math.Max(9, size.Height / 34)))
    using (StringFormat center = new StringFormat()) {
      g.Clear(Color.FromArgb(16, 18, 22));
      g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
      center.Alignment = StringAlignment.Center; center.LineAlignment = StringAlignment.Center;
      g.DrawString("This PC is locked", title, Brushes.White, new RectangleF(0, 0, size.Width, size.Height * 0.9f), center);
      g.DrawString("Unlock it at the PC. This view comes back by itself.", body, Brushes.Gainsboro, new RectangleF(0, size.Height * 0.18f, size.Width, size.Height * 0.9f), center);
      return Jpeg(b, quality);
    }
  }

  static INPUT Mouse(uint flags, int dx, int dy, uint data) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags; return i;
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.vk = vk; i.u.ki.scan = scan; i.u.ki.flags = flags; return i;
  }
  static void Send(INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    // Windows blocks input into apps running as administrator from a normal process (UIPI).
    if (sent != inputs.Length) throw new InvalidOperationException("INPUT_BLOCKED");
  }
  static int Abs(double v) { return (int)Math.Round(Math.Min(1, Math.Max(0, v)) * 65535); }

  public static void Click(double x, double y, bool right, int count) {
    int dx = Abs(x), dy = Abs(y);
    Send(new INPUT[] { Mouse(MOVE | ABSOLUTE, dx, dy, 0) });
    for (int n = 0; n < Math.Max(1, Math.Min(3, count)); n++)
      Send(new INPUT[] { Mouse((right ? RIGHTDOWN : LEFTDOWN) | ABSOLUTE, dx, dy, 0), Mouse((right ? RIGHTUP : LEFTUP) | ABSOLUTE, dx, dy, 0) });
  }

  public static void Scroll(double x, double y, string direction, int amount) {
    Send(new INPUT[] { Mouse(MOVE | ABSOLUTE, Abs(x), Abs(y), 0) });
    int notches = Math.Max(1, Math.Min(20, amount));
    bool horizontal = direction == "left" || direction == "right";
    // Wheel up and wheel right are positive.
    int delta = (direction == "up" || direction == "right" ? 120 : -120) * notches;
    Send(new INPUT[] { Mouse((horizontal ? HWHEEL : WHEEL) | ABSOLUTE, Abs(x), Abs(y), unchecked((uint)delta)) });
  }

  static bool Extended(int vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B; }

  public static void Press(int vk, int[] modifiers) {
    int count = modifiers.Length * 2 + 2, at = 0;
    INPUT[] seq = new INPUT[count];
    foreach (int m in modifiers) seq[at++] = Key((ushort)m, 0, Extended(m) ? EXTENDED : 0);
    seq[at++] = Key((ushort)vk, 0, Extended(vk) ? EXTENDED : 0);
    seq[at++] = Key((ushort)vk, 0, KEYUP | (Extended(vk) ? EXTENDED : 0));
    for (int i = modifiers.Length - 1; i >= 0; i--) seq[at++] = Key((ushort)modifiers[i], 0, KEYUP | (Extended(modifiers[i]) ? EXTENDED : 0));
    Send(seq);
  }

  /// Unicode typing: any character the phone keyboard produces, independent of the PC's keyboard layout.
  public static void Type(string text) {
    foreach (char c in text) Send(new INPUT[] { Key(0, c, UNICODE), Key(0, c, UNICODE | KEYUP) });
  }
}
'@

[FFDRemote]::Init()
# UTF-8 both ways, read straight from the pipes: [Console]::In decodes with the console code page
# (437 here), which turned a typed check mark into three other characters (test/remote-windows-live.test.ts).
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
function Answer([hashtable]$value) { $stdout.WriteLine(($value | ConvertTo-Json -Compress -Depth 4)) }

while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $r = $line | ConvertFrom-Json
    $id = $r.id
    $locked = [FFDRemote]::Locked()
    $op = [string]$r.op
    if ($op -eq 'state') {
      Answer @{ id = $id; ok = $true; locked = $locked }
    } elseif ($op -eq 'capture') {
      $w = 0; $h = 0
      $max = [int]$r.max; $q = [long]$r.quality
      $bytes = if ($locked) { [FFDRemote]::LockedFrame($max, $q, [ref]$w, [ref]$h) } else { [FFDRemote]::Capture($max, $q, [ref]$w, [ref]$h) }
      # Built by hand: ConvertTo-Json is slow on a large base64 string.
      $stdout.WriteLine('{"id":' + [int]$id + ',"ok":true,"locked":' + $locked.ToString().ToLower() + ',"width":' + $w + ',"height":' + $h + ',"jpeg":"' + [Convert]::ToBase64String($bytes) + '"}')
    } elseif ($op -notin @('mouse', 'scroll', 'key', 'text')) {
      Answer @{ id = $id; ok = $false; error = 'UNKNOWN_OP' }
    } elseif ($locked) {
      Answer @{ id = $id; ok = $false; error = 'PC_LOCKED' }
    } else {
      if ($op -eq 'mouse') { [FFDRemote]::Click([double]$r.x, [double]$r.y, ([string]$r.button -eq 'right'), [int]$r.count) }
      elseif ($op -eq 'scroll') { [FFDRemote]::Scroll([double]$r.x, [double]$r.y, [string]$r.direction, [int]$r.amount) }
      elseif ($op -eq 'key') { [FFDRemote]::Press([int]$r.vk, [int[]]@($r.modifiers | Where-Object { $null -ne $_ })) }
      else { [FFDRemote]::Type([string]$r.text) }
      Answer @{ id = $id; ok = $true }
    }
  } catch {
    $message = $_.Exception.InnerException.Message
    if (-not $message) { $message = $_.Exception.Message }
    $code = if ($message -match 'INPUT_BLOCKED') { 'INPUT_BLOCKED' } else { 'HELPER_ERROR' }
    Answer @{ id = $id; ok = $false; error = $code; detail = [string]$message }
  }
}
