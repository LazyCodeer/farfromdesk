# FarFromDesk desktop control for Windows, over UI Automation and SendInput.
#
# One action per run. Arguments arrive as base64 JSON in the second argument and the
# answer is one JSON object on stdout: {"ok":true,...} or {"ok":false,"error":"CODE: sentence"}.
#
#   list        windows with app, process, title, pid and window handle (id)
#   read        one window's visible controls, each with a runtime id (rid) and a
#               window-local rectangle, so a later call can act on that exact control
#   click/type/key   the owner-brain vocabulary, addressed by app and control name
#   act         one control by rid: click, double, right, scroll, type, key
#   pointer     window-local screenshot pixels: click, double, right, drag, scroll
#   pick        choose a file in an open Windows file dialog (Open / Save As)
#   apps        installed apps matching a query (Start menu, App Paths, Uninstall)
#   launch      start an installed app by its Start menu id or its exe path
#   front       bring a window to the front
#   screenshot  one window (PrintWindow) or the whole desktop
#
# Runs in Windows PowerShell 5.1, which every supported Windows ships, with only the
# .NET assemblies Windows includes (UIAutomationClient, System.Windows.Forms,
# System.Drawing). Windows asks for no permission here, so the app's own policy layer
# is the only gate. UIPI still stops a normal process from driving an elevated
# (administrator) window, and nothing can drive the lock screen; both are reported,
# never worked around. Pointer and keyboard input is real input: the window comes to
# the front first, because Windows has no background delivery for it.
param([string]$Action = '', [string]$Payload = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Send($value) { [Console]::Out.Write(($value | ConvertTo-Json -Depth 6 -Compress)); exit 0 }
function Fail([string]$code, [string]$message) { Send @{ ok = $false; error = "${code}: $message" } }

try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class FfdUser32 {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int cls, out int info, int length, out int returned);

  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }

  const uint MOVE = 0x0001, WHEEL = 0x0800, VIRTUALDESK = 0x4000, ABSOLUTE = 0x8000;
  const uint KEYUP = 0x0002, UNICODE = 0x0004, EXTENDED = 0x0001;

  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);

  /// WM_SETTEXT, which Windows copies across processes; bounded so a hung window cannot hold the helper.
  public static bool SetText(IntPtr h, string text) { IntPtr r; return SendMessageTimeout(h, 0x000C, IntPtr.Zero, text, 0x0002, 3000, out r) != IntPtr.Zero; }
  /// WM_COMMAND as a button sends it to its dialog (BN_CLICKED is 0, so wParam is the control id).
  public static bool Command(IntPtr dialog, int id, IntPtr control) { return PostMessage(dialog, 0x0111, new IntPtr(id), control); }

  public static void Init() {
    // Per-monitor aware (v2): UI Automation rectangles, PrintWindow and SendInput all in real pixels.
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { SetProcessDPIAware(); }
  }

  /// The input desktop is "Default" while signed in and unlocked; no user process can open
  /// or drive the lock screen's desktop.
  public static bool Locked() {
    IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
    if (desktop == IntPtr.Zero) return true;
    try {
      StringBuilder name = new StringBuilder(256); int needed;
      if (!GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed)) return true;
      return !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
    } finally { CloseDesktop(desktop); }
  }

  /// 1 elevated, 0 not, -1 unknown. Task Manager reads the same token field without elevation.
  static int TokenElevated(IntPtr process) {
    IntPtr token;
    if (!OpenProcessToken(process, 0x0008, out token)) return -1;
    try { int value, returned; if (!GetTokenInformation(token, 20, out value, 4, out returned)) return -1; return value != 0 ? 1 : 0; }
    finally { CloseHandle(token); }
  }
  public static int Elevated(int pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return -1;
    try { return TokenElevated(p); } finally { CloseHandle(p); }
  }
  public static bool SelfElevated() { return TokenElevated(GetCurrentProcess()) == 1; }

  /// SetForegroundWindow alone is refused for a process without the last input, which a
  /// background backend never has; sharing the foreground thread's input state lifts that
  /// without sending any key.
  public static bool Front(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    if (GetForegroundWindow() == h) return true;
    IntPtr fg = GetForegroundWindow();
    uint mine = GetCurrentThreadId(), theirs = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, IntPtr.Zero);
    bool attached = theirs != 0 && theirs != mine && AttachThreadInput(mine, theirs, true);
    try { BringWindowToTop(h); SetForegroundWindow(h); }
    finally { if (attached) AttachThreadInput(mine, theirs, false); }
    for (int i = 0; i < 10 && GetForegroundWindow() != h; i++) Thread.Sleep(30);
    return GetForegroundWindow() == h;
  }

  static INPUT Mouse(uint flags, int dx, int dy, uint data) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags; return i;
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.vk = vk; i.u.ki.scan = scan; i.u.ki.flags = flags; return i;
  }
  static void Send(INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new InvalidOperationException("INPUT_BLOCKED");
  }
  /// Absolute coordinates over the whole virtual desktop, so a second monitor works too.
  static INPUT At(uint flags, int x, int y, uint data) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77), w = Math.Max(2, GetSystemMetrics(78)), h = Math.Max(2, GetSystemMetrics(79));
    int dx = (int)Math.Round((double)(x - left) * 65535 / (w - 1)), dy = (int)Math.Round((double)(y - top) * 65535 / (h - 1));
    return Mouse(flags | MOVE | ABSOLUTE | VIRTUALDESK, dx, dy, data);
  }
  static uint Down(string button) { return button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u; }
  static uint Up(string button) { return button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u; }
  static bool Extended(int vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B; }
  static void Mods(int[] mods, bool down) {
    if (mods == null) return;
    if (down) { foreach (int m in mods) Send(new INPUT[] { Key((ushort)m, 0, Extended(m) ? EXTENDED : 0) }); }
    else { for (int i = mods.Length - 1; i >= 0; i--) Send(new INPUT[] { Key((ushort)mods[i], 0, KEYUP | (Extended(mods[i]) ? EXTENDED : 0)) }); }
  }

  public static void Click(int x, int y, string button, int count, int[] mods) {
    Send(new INPUT[] { At(0, x, y, 0) });
    Mods(mods, true);
    try {
      for (int n = 0; n < Math.Max(1, Math.Min(3, count)); n++) Send(new INPUT[] { At(Down(button), x, y, 0), At(Up(button), x, y, 0) });
    } finally { Mods(mods, false); }
  }

  public static void Drag(int x, int y, int toX, int toY, string button, int[] mods) {
    Send(new INPUT[] { At(0, x, y, 0) });
    Mods(mods, true);
    try {
      Send(new INPUT[] { At(Down(button), x, y, 0) });
      // Moved in steps: many apps start a drag only after the pointer travels while held.
      for (int s = 1; s <= 12; s++) { Thread.Sleep(16); Send(new INPUT[] { At(0, x + (toX - x) * s / 12, y + (toY - y) * s / 12, 0) }); }
      Thread.Sleep(30);
      Send(new INPUT[] { At(Up(button), toX, toY, 0) });
    } finally { Mods(mods, false); }
  }

  public static void Wheel(int x, int y, string direction, int amount) {
    Send(new INPUT[] { At(0, x, y, 0) });
    bool horizontal = direction == "left" || direction == "right";
    int delta = (direction == "up" || direction == "right" ? 120 : -120);
    for (int n = 0; n < Math.Max(1, Math.Min(50, amount)); n++) Send(new INPUT[] { At(horizontal ? 0x1000u : WHEEL, x, y, unchecked((uint)delta)) });
  }

  public static void Press(int vk, int[] mods) {
    Mods(mods, true);
    try { Send(new INPUT[] { Key((ushort)vk, 0, Extended(vk) ? EXTENDED : 0), Key((ushort)vk, 0, KEYUP | (Extended(vk) ? EXTENDED : 0)) }); }
    finally { Mods(mods, false); }
  }

  /// Unicode typing, independent of the keyboard layout; a newline is Return and a tab is Tab,
  /// so rows typed into a sheet move between cells the way the owner's own keys would.
  public static void Type(string text) {
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { Press(0x0D, null); continue; }
      if (c == '\t') { Press(0x09, null); continue; }
      Send(new INPUT[] { Key(0, c, UNICODE), Key(0, c, UNICODE | KEYUP) });
    }
  }
}
'@
  [FfdUser32]::Init()
} catch { Fail 'UIA_UNAVAILABLE' "UI Automation could not load: $($_.Exception.Message)" }

$A = @{}
if ($Payload) { $A = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json }
$AE = [System.Windows.Automation.AutomationElement]
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function Clip([string]$s, [int]$n = 300) { if ($null -eq $s) { return '' }; $s = $s.Trim(); if ($s.Length -gt $n) { $s.Substring(0, $n) } else { $s } }

function Get-Windows {
  $rows = @()
  $active = [System.Windows.Automation.AutomationElement]::FocusedElement
  $activePid = if ($active) { $active.Current.ProcessId } else { -1 }
  foreach ($w in $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      $title = $w.Current.Name; $procId = $w.Current.ProcessId
      if (-not $title) { continue }
      $name = ''; $label = ''
      try { $p = Get-Process -Id $procId; $name = $p.ProcessName; $label = $p.MainModule.FileVersionInfo.FileDescription } catch {}
      $rows += [pscustomobject]@{ app = $(if ($label) { $label } else { $name }); process = $name; title = $title; pid = $procId; id = [string]$w.Current.NativeWindowHandle; active = ($procId -eq $activePid); node = $w }
    } catch {}
  }
  $rows
}
function Public($row) { [pscustomobject]@{ app = $row.app; process = $row.process; title = $row.title; pid = $row.pid; id = $row.id; active = $row.active } }

function Find-Window {
  # A window handle from an earlier list is exact; a handle that is gone is stale, never a guess.
  if ($A.hwnd) {
    $hit = @(Get-Windows | Where-Object { $_.id -eq "$($A.hwnd)" })
    if (-not $hit.Count) { Fail 'DESKTOP_WINDOW_STALE' 'That window has closed or changed. List the windows again.' }
    return $hit[0]
  }
  $want = "$($A.app)".ToLower(); $title = "$($A.window)".ToLower()
  $rows = @(Get-Windows | Where-Object { -not $want -or $_.app.ToLower().Contains($want) -or $_.process.ToLower().Contains($want) -or $_.title.ToLower().Contains($want) })
  if ($title) { $named = @($rows | Where-Object { $_.title.ToLower().Contains($title) }); if ($named.Count) { $rows = $named } }
  if (-not $rows.Count) { Fail 'DESKTOP_APP_NOT_RUNNING' "$(if ($A.app) { $A.app } else { 'That app' }) has no open window." }
  ($rows | Sort-Object @{ e = { -not $_.active } })[0]
}

function Walk($node, [int]$depth, [System.Collections.ArrayList]$into, [int]$limit) {
  if ($depth -gt 30 -or $into.Count -ge $limit) { return }
  $child = $Walker.GetFirstChild($node)
  while ($null -ne $child -and $into.Count -lt $limit) {
    [void]$into.Add($child)
    Walk $child ($depth + 1) $into $limit
    $child = $Walker.GetNextSibling($child)
  }
}

function Rid($el) { try { ($el.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.' } catch { '' } }

function Describe($el, $origin) {
  $c = $el.Current
  $role = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  $value = ''
  $pattern = $null
  if (-not $c.IsPassword -and $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $value = Clip $pattern.Current.Value }
  $name = Clip $c.Name
  $d = [ordered]@{ role = $role; name = $name; value = $(if ($value -ne $name) { $value } else { '' }) }
  if ($null -ne $origin) {
    $r = $c.BoundingRectangle
    $d.rid = Rid $el
    $d.enabled = [bool]$c.IsEnabled
    $d.password = [bool]$c.IsPassword
    if (-not $r.IsEmpty) { $d.rect = @([int]($r.X - $origin.X), [int]($r.Y - $origin.Y), [int]$r.Width, [int]$r.Height) }
  }
  [pscustomobject]$d
}

function Find-Control($win, [bool]$editable) {
  $name = "$($A.name)".Trim().ToLower(); $role = "$($A.role)".Trim().ToLower()
  $all = New-Object System.Collections.ArrayList
  Walk $win.node 0 $all 4000
  $exact = @(); $partial = @()
  foreach ($el in $all) {
    try {
      $c = $el.Current
      if (-not $c.IsEnabled -or $c.IsOffscreen) { continue }
      $r = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', '').ToLower()
      if ($role -and -not $r.Contains($role)) { continue }
      if ($editable -and @('edit', 'document', 'combobox') -notcontains $r) { continue }
      $label = "$($c.Name)".Trim().ToLower()
      if ($name -and $label -eq $name) { $exact += $el } elseif ($name -and $label.Contains($name)) { $partial += $el } elseif (-not $name -and $role) { $exact += $el }
    } catch {}
  }
  $found = @($exact + $partial)
  if (-not $found.Count) { Fail 'DESKTOP_CONTROL_NOT_FOUND' "No control named `"$(if ($A.name) { $A.name } else { $A.role })`" in that window." }
  $found[0]
}

# The control a read named by its runtime id, still in the same window, or a stale refusal.
function Find-ById($win) {
  $want = "$($A.rid)"
  if (-not $want) { Fail 'DESKTOP_CONTROL_STALE' 'Read the window again and choose a control from that read.' }
  $all = New-Object System.Collections.ArrayList
  Walk $win.node 0 $all 4000
  foreach ($el in $all) { if ((Rid $el) -eq $want) { return $el } }
  Fail 'DESKTOP_CONTROL_STALE' 'That control is gone from the window. Read it again.'
}

# Real input is refused for an administrator window (UIPI drops it silently) and on the
# lock screen, so both are checked first and said plainly.
function Assert-Input($win) {
  # A caller can forbid real input outright (the live tests do), so a control without a pattern
  # is refused instead of clicked with the pointer.
  if ($A.noInput) { Fail 'DESKTOP_INPUT_REFUSED' 'This call was not allowed to use the pointer or keyboard.' }
  if ([FfdUser32]::Locked()) { Fail 'DESKTOP_PLATFORM_UNSUPPORTED' 'This PC is locked, and Windows lets no app click or type on the lock screen. Unlock it, then ask again.' }
  if (-not [FfdUser32]::SelfElevated() -and [FfdUser32]::Elevated([int]$win.pid) -eq 1) { Fail 'ELEVATED_TARGET' 'That window runs as administrator, and Windows does not let FarFromDesk drive it.' }
}

function Front($win) {
  $ok = [FfdUser32]::Front([IntPtr][long]$win.id)
  Start-Sleep -Milliseconds 120
  $ok
}

$VK = @{ return = 0x0D; enter = 0x0D; tab = 0x09; escape = 0x1B; esc = 0x1B; up = 0x26; down = 0x28; left = 0x25; right = 0x27; space = 0x20; delete = 0x08; backspace = 0x08; forwarddelete = 0x2E; home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22 }
function Key-Code([string]$key) {
  $k = $key.ToLower()
  if ($VK.ContainsKey($k)) { return [int]$VK[$k] }
  if ($k -match '^[a-z0-9]$') { return [int][char]$k.ToUpper() }
  if ($k -match '^f([1-9]|1[0-2])$') { return 0x6F + [int]$Matches[1] }
  Fail 'DESKTOP_KEY_UNSUPPORTED' "The key $key is not one I can press."
}
# Command on a Mac is Control here, so "cmd+c" still copies; option is Alt.
function Mod-Codes($mods) {
  $map = @{ ctrl = 0x11; cmd = 0x11; shift = 0x10; option = 0x12; alt = 0x12 }
  [int[]]@(@($mods) | Where-Object { $_ } | ForEach-Object { $map["$_".ToLower()] } | Where-Object { $_ })
}

function Window-Origin($win) { $win.node.Current.BoundingRectangle }

function Center($el) {
  $r = $el.Current.BoundingRectangle
  if ($r.IsEmpty -or $r.Width -le 0) { Fail 'DESKTOP_CONTROL_NOT_FOUND' 'That control has no place on screen to click.' }
  @([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
}

# A pattern that refuses (a Win32 control in a window that is not active can answer "not
# enabled") leaves the pointer as the fallback, as for a control with no pattern at all.
function Invoke-Control($el) {
  $p = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return $true }
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return $true }
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return $true }
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand(); return $true }
  } catch [System.Windows.Automation.ElementNotEnabledException] {}
  $false
}
function Set-Value($el, [string]$text) {
  $p = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p) -and -not $p.Current.IsReadOnly) { $p.SetValue($text); return $true } }
  catch [System.Windows.Automation.ElementNotEnabledException] {}
  $false
}

function Scroll-Control($el, [string]$direction, [int]$amount) {
  $node = $el; $p = $null
  while ($null -ne $node) {
    if ($node.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$p)) {
      $step = if ($direction -eq 'up' -or $direction -eq 'left') { [System.Windows.Automation.ScrollAmount]::SmallDecrement } else { [System.Windows.Automation.ScrollAmount]::SmallIncrement }
      $none = [System.Windows.Automation.ScrollAmount]::NoAmount
      for ($i = 0; $i -lt [Math]::Max(1, $amount); $i++) {
        if ($direction -eq 'left' -or $direction -eq 'right') { $p.ScrollHorizontal($step) } else { $p.Scroll($none, $step) }
      }
      return $true
    }
    $node = $Walker.GetParent($node)
    if ($null -ne $node -and $node -eq $AE::RootElement) { break }
  }
  $false
}

function Screenshot {
  $png = New-Object IO.MemoryStream; $window = $null; $width = 0; $height = 0
  if ($A.app -or $A.hwnd) {
    $win = Find-Window; $window = $win.title
    $r = $win.node.Current.BoundingRectangle
    $bmp = New-Object Drawing.Bitmap ([int][Math]::Max(1, $r.Width)), ([int][Math]::Max(1, $r.Height))
    $g = [Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
    # PrintWindow with PW_RENDERFULLCONTENT draws the window even when another one covers it.
    $ok = [FfdUser32]::PrintWindow([IntPtr][long]$win.id, $dc, 2)
    $g.ReleaseHdc($dc); $g.Dispose()
    if (-not $ok) { $bmp.Dispose(); Fail 'SCREENSHOT_FAILED' 'Windows could not draw that window.' }
  } else {
    $r = [Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object Drawing.Bitmap $r.Width, $r.Height
    $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.X, $r.Y, 0, 0, $bmp.Size); $g.Dispose()
  }
  $width = $bmp.Width; $height = $bmp.Height
  $bmp.Save($png, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Send @{ ok = $true; pngBase64 = [Convert]::ToBase64String($png.ToArray()); window = $window; width = $width; height = $height; scope = $(if ($window) { 'window' } else { 'screen' }) }
}

# Installed apps: the Start menu's own list (packaged and desktop apps, with the id
# explorer launches them by), then App Paths and Uninstall entries for anything else.
function Installed-Apps([string]$query) {
  $q = $query.Trim().ToLower()
  $rows = New-Object System.Collections.ArrayList; $seen = @{}
  $add = {
    param($name, $appId, $path, $source)
    $n = "$name".Trim(); if (-not $n) { return }
    $key = $n.ToLower(); if ($seen.ContainsKey($key)) { return }
    if ($q -and -not $key.Contains($q) -and -not "$appId".ToLower().Contains($q) -and -not ([IO.Path]::GetFileNameWithoutExtension("$path")).ToLower().Contains($q)) { return }
    $seen[$key] = $true
    [void]$rows.Add([pscustomobject]@{ name = $n; appId = "$appId"; path = "$path"; source = $source })
  }
  try {
    foreach ($item in (New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder').Items()) {
      # Documents and web links pinned in Start (release notes, help pages) are not apps.
      $id = "$($item.Path)"
      if ($id -match '^(file|https?)://' -or $id -match '\.(html?|txt|pdf|url|chm|rtf)$') { continue }
      & $add $item.Name $id '' 'start'
    }
  } catch {}
  foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths')) {
    try {
      foreach ($k in Get-ChildItem $root -ErrorAction SilentlyContinue) {
        $exe = "$($k.GetValue(''))".Trim('"')
        # A packaged app's exe under WindowsApps is listed, and opened, through Start above.
        if ($exe -and $exe.ToLower().EndsWith('.exe') -and $exe -notmatch '\\WindowsApps\\') { & $add ([IO.Path]::GetFileNameWithoutExtension($k.PSChildName)) '' $exe 'app-paths' }
      }
    } catch {}
  }
  foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    try {
      foreach ($e in Get-ItemProperty $root -ErrorAction SilentlyContinue) {
        if (-not $e.DisplayName -or $e.SystemComponent -eq 1) { continue }
        # Installed, but not a way to start it: an entry's icon is often its installer
        # (Package Cache\...\setup.exe), and running that would reinstall instead of open.
        & $add $e.DisplayName '' '' 'uninstall'
      }
    } catch {}
  }
  # Exact names first, then names that start with the query, then the rest.
  @($rows | Sort-Object @{ e = { if ($_.name.ToLower() -eq $q) { 0 } elseif ($_.name.ToLower().StartsWith($q)) { 1 } else { 2 } } }, @{ e = { $_.name.Length } } | Select-Object -First 25)
}

# The Windows file dialog (Open, Save As, Upload) belongs to the app that opened it, as a
# top-level window or nested under its owner, with the dialog class #32770.
function Find-FileDialog($pids) {
  $isDialog = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32770')
  foreach ($w in $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      if ($pids -notcontains $w.Current.ProcessId) { continue }
      if ($w.Current.ClassName -eq '#32770') { return $w }
      $inner = $w.FindFirst([System.Windows.Automation.TreeScope]::Children, $isDialog)
      if ($null -ne $inner) { return $inner }
    } catch {}
  }
  $null
}

function Pick-File {
  $path = "$($A.path)"
  if (-not $path -or $path -match '[\x00-\x1f"<>|*?]' -or -not [IO.Path]::IsPathRooted($path)) { Fail 'DESKTOP_PLATFORM_UNSUPPORTED' 'Give the full path of the file to choose.' }
  $want = "$($A.app)".ToLower()
  $pids = @(Get-Windows | Where-Object { -not $want -or $_.app.ToLower().Contains($want) -or $_.process.ToLower().Contains($want) -or $_.title.ToLower().Contains($want) } | ForEach-Object { $_.pid } | Select-Object -Unique)
  if (-not $pids.Count) { Fail 'DESKTOP_APP_NOT_RUNNING' "$(if ($A.app) { $A.app } else { 'That app' }) has no open window." }
  $dialog = Find-FileDialog $pids
  if ($null -eq $dialog) { Fail 'DESKTOP_CONTROL_NOT_FOUND' "No file picker is open in $($A.app). Click the upload or open button first, then choose the file." }
  if (-not [FfdUser32]::SelfElevated() -and [FfdUser32]::Elevated([int]$dialog.Current.ProcessId) -eq 1) { Fail 'ELEVATED_TARGET' 'That window runs as administrator, and Windows does not let FarFromDesk drive it.' }
  $dialogHwnd = [IntPtr][long]$dialog.Current.NativeWindowHandle
  # The File name box is the Edit with control id 1148 in every Windows file dialog. Windows
  # PowerShell's UI Automation client often sees these classic controls as bare panes with no
  # patterns (measured on Windows 11), so the box is found by id and class, and filled with
  # WM_SETTEXT when it publishes no Value pattern.
  $edit = $null
  foreach ($el in $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, '1148')))) {
    try { if ($el.Current.ClassName -eq 'Edit' -or $el.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) { $edit = $el; break } } catch {}
  }
  if ($null -eq $edit) {
    foreach ($el in $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))) {
      try { if ($el.Current.Name -match '^File name') { $edit = $el; break } } catch {}
    }
  }
  if ($null -eq $edit) { Fail 'DESKTOP_CONTROL_NOT_FOUND' 'The file picker has no File name box I can fill.' }
  $p = $null; $filled = $false
  # The Value pattern, when there is one, can still refuse ("not enabled") on a dialog that is
  # not the active window, so WM_SETTEXT is the fallback either way.
  try { if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p) -and -not $p.Current.IsReadOnly) { $p.SetValue($path); $filled = $true } } catch {}
  if (-not $filled) {
    $editHwnd = [IntPtr][long]$edit.Current.NativeWindowHandle
    if ($editHwnd -eq [IntPtr]::Zero -or -not [FfdUser32]::SetText($editHwnd, $path)) { Fail 'DESKTOP_CONTROL_NOT_FOUND' 'The File name box in the file picker cannot be filled.' }
  }
  # The default button (Open or Save) is control id 1, IDOK. Invoked through its pattern when it
  # has one, else the dialog gets the same command the button sends: no keys, no pointer.
  $button = $null
  foreach ($el in $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, '1')))) {
    try { if ($el.Current.ClassName -eq 'Button' -or $el.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) { $button = $el; break } } catch {}
  }
  $ip = $null; $mode = ''
  try { if ($null -ne $button -and $button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke(); $mode = 'button' } } catch {}
  if (-not $mode) {
    $buttonHwnd = if ($null -ne $button) { [IntPtr][long]$button.Current.NativeWindowHandle } else { [IntPtr]::Zero }
    if (-not [FfdUser32]::Command($dialogHwnd, 1, $buttonHwnd)) { Fail 'DESKTOP_NATIVE_FAILED' 'Windows did not take the Open command.' }
    $mode = 'command'
  }
  # A dialog that closes took the file; one that stays open is showing why it did not.
  $closed = $false
  for ($i = 0; $i -lt 20 -and -not $closed; $i++) {
    Start-Sleep -Milliseconds 150
    if (-not [FfdUser32]::IsWindow($dialogHwnd) -or -not [FfdUser32]::IsWindowVisible($dialogHwnd)) { $closed = $true }
  }
  Send @{ ok = $true; closed = $closed; mode = $mode }
}

try {
  switch ($Action) {
    'list' { Send @{ ok = $true; windows = @(Get-Windows | ForEach-Object { Public $_ }); session = 'windows' } }
    'read' {
      $win = Find-Window
      $all = New-Object System.Collections.ArrayList
      Walk $win.node 0 $all 4000
      $max = if ($A.max) { [Math]::Min(1000, [int]$A.max) } else { 250 }
      # Runtime ids and window-local rectangles only when asked: the brain's read only needs text.
      $origin = if ($A.ids) { Window-Origin $win } else { $null }
      $items = @(); $total = 0
      foreach ($el in $all) {
        try { if ($el.Current.IsOffscreen) { continue }; $d = Describe $el $origin } catch { continue }
        if (-not $d.name -and -not $d.value) { continue }
        $total++; if ($items.Count -lt $max) { $items += $d }
      }
      $o = Window-Origin $win
      Send @{ ok = $true; app = $win.app; window = $win.title; pid = $win.pid; id = $win.id; bounds = @([int]$o.X, [int]$o.Y, [int]$o.Width, [int]$o.Height); elements = $items; truncated = ($total -gt $items.Count) }
    }
    'click' {
      $win = Find-Window; $el = Find-Control $win $false; $mode = 'pattern'
      if (-not (Invoke-Control $el)) {
        # No pattern to call: click its centre like the owner's own mouse would.
        Assert-Input $win; $pt = Center $el; [void](Front $win)
        [FfdUser32]::Click($pt[0], $pt[1], 'left', 1, $null); $mode = 'pointer'
      }
      Send @{ ok = $true; app = $win.app; window = $win.title; control = (Describe $el $null); mode = $mode }
    }
    'type' {
      $win = Find-Window
      if ($A.name -or $A.role) {
        $el = Find-Control $win $true
        if (Set-Value $el "$($A.text)") { $mode = 'set' }
        else { Assert-Input $win; [void](Front $win); $el.SetFocus(); [FfdUser32]::Type("$($A.text)"); $mode = 'keystrokes' }
        Send @{ ok = $true; app = $win.app; window = $win.title; field = $el.Current.Name; mode = $mode }
      }
      Assert-Input $win; [void](Front $win)
      [FfdUser32]::Type("$($A.text)")
      Send @{ ok = $true; app = $win.app; window = $win.title; mode = 'keystrokes' }
    }
    'key' {
      $win = Find-Window; Assert-Input $win; [void](Front $win)
      [FfdUser32]::Press((Key-Code "$($A.key)"), (Mod-Codes $A.modifiers))
      Send @{ ok = $true; app = $win.app; window = $win.title }
    }
    'act' {
      $win = Find-Window; $el = Find-ById $win
      if (-not $el.Current.IsEnabled) { Fail 'DESKTOP_CONTROL_DISABLED' 'That control is disabled.' }
      $op = "$($A.op)"; $mode = 'pattern'
      switch ($op) {
        'click' { if (-not (Invoke-Control $el)) { Assert-Input $win; $pt = Center $el; [void](Front $win); [FfdUser32]::Click($pt[0], $pt[1], 'left', 1, (Mod-Codes $A.modifiers)); $mode = 'pointer' } }
        'double' { Assert-Input $win; $pt = Center $el; [void](Front $win); [FfdUser32]::Click($pt[0], $pt[1], 'left', 2, (Mod-Codes $A.modifiers)); $mode = 'pointer' }
        'right' { Assert-Input $win; $pt = Center $el; [void](Front $win); [FfdUser32]::Click($pt[0], $pt[1], 'right', 1, (Mod-Codes $A.modifiers)); $mode = 'pointer' }
        'scroll' {
          $amount = if ($A.amount) { [int]$A.amount } else { 3 }
          if (-not (Scroll-Control $el "$($A.direction)" $amount)) { Assert-Input $win; $pt = Center $el; [void](Front $win); [FfdUser32]::Wheel($pt[0], $pt[1], "$($A.direction)", $amount); $mode = 'pointer' }
        }
        'type' {
          if (Set-Value $el "$($A.text)") { $mode = 'set' }
          else { Assert-Input $win; [void](Front $win); try { $el.SetFocus() } catch {}; [FfdUser32]::Type("$($A.text)"); $mode = 'keystrokes' }
        }
        'key' { Assert-Input $win; [void](Front $win); try { $el.SetFocus() } catch {}; [FfdUser32]::Press((Key-Code "$($A.key)"), (Mod-Codes $A.modifiers)); $mode = 'keystrokes' }
        default { Fail 'UNSUPPORTED_ACTION' "Unknown control action $op." }
      }
      Send @{ ok = $true; app = $win.app; window = $win.title; mode = $mode }
    }
    'pointer' {
      $win = Find-Window; Assert-Input $win
      $o = Window-Origin $win
      $x = [double]$A.x; $y = [double]$A.y
      $inside = { param($px, $py) $px -ge 0 -and $py -ge 0 -and $px -lt $o.Width -and $py -lt $o.Height }
      if (-not (& $inside $x $y)) { Fail 'DESKTOP_POINT_OUTSIDE' "That point is outside the window, which is $([int]$o.Width) by $([int]$o.Height) pixels." }
      $sx = [int]($o.X + $x); $sy = [int]($o.Y + $y)
      $button = if ($A.button) { "$($A.button)" } else { 'left' }
      $fronted = Front $win
      switch ("$($A.kind)") {
        'click' { [FfdUser32]::Click($sx, $sy, $button, 1, (Mod-Codes $A.modifiers)) }
        'double_click' { [FfdUser32]::Click($sx, $sy, $button, 2, (Mod-Codes $A.modifiers)) }
        'right_click' { [FfdUser32]::Click($sx, $sy, 'right', 1, (Mod-Codes $A.modifiers)) }
        'scroll' { [FfdUser32]::Wheel($sx, $sy, "$($A.direction)", $(if ($A.amount) { [int]$A.amount } else { 3 })) }
        'drag' {
          $tx = [double]$A.toX; $ty = [double]$A.toY
          if (-not (& $inside $tx $ty)) { Fail 'DESKTOP_POINT_OUTSIDE' "The drag ends outside the window, which is $([int]$o.Width) by $([int]$o.Height) pixels." }
          [FfdUser32]::Drag($sx, $sy, [int]($o.X + $tx), [int]($o.Y + $ty), $button, (Mod-Codes $A.modifiers))
        }
        default { Fail 'UNSUPPORTED_ACTION' "Unknown pointer action $($A.kind)." }
      }
      Send @{ ok = $true; app = $win.app; window = $win.title; fronted = [bool]$fronted; mode = 'pointer' }
    }
    'pick' { Pick-File }
    'apps' { Send @{ ok = $true; apps = @(Installed-Apps "$($A.query)") } }
    'launch' {
      $appId = "$($A.appId)"; $path = "$($A.path)"
      if ($appId) {
        if ($appId -match '[\x00-\x1f"]') { Fail 'DESKTOP_PLATFORM_UNSUPPORTED' 'That app id is not one Windows can open.' }
        # The Start menu id opens packaged and desktop apps alike, the way the Start menu does.
        Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList ('shell:AppsFolder\' + $appId)
      } elseif ($path) {
        if (-not $path.ToLower().EndsWith('.exe') -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail 'DESKTOP_CONTROL_NOT_FOUND' 'That app is no longer installed where Windows said it was.' }
        Start-Process -FilePath $path -WorkingDirectory ([IO.Path]::GetDirectoryName($path))
      } else { Fail 'DESKTOP_CONTROL_NOT_FOUND' 'Windows gave no way to start that app.' }
      Send @{ ok = $true; started = $true }
    }
    'front' { $win = Find-Window; Send @{ ok = $true; app = $win.app; window = $win.title; fronted = [bool](Front $win) } }
    'screenshot' { Screenshot }
    default { Fail 'UNSUPPORTED_ACTION' "Unknown action $Action." }
  }
} catch [System.UnauthorizedAccessException] {
  Fail 'ELEVATED_TARGET' 'That window runs as administrator, and Windows does not let FarFromDesk drive it.'
} catch {
  $message = $_.Exception.Message
  if ($_.Exception.InnerException) { $message = $_.Exception.InnerException.Message }
  if ($message -match 'INPUT_BLOCKED') { Fail 'ELEVATED_TARGET' 'Windows blocked that input. The window may run as administrator, or a secure screen is showing.' }
  if ($_.Exception -is [System.Windows.Automation.ElementNotAvailableException]) { Fail 'DESKTOP_CONTROL_STALE' 'That window or control went away while I was using it. Read it again.' }
  Fail 'DESKTOP_NATIVE_FAILED' (Clip $message)
}
