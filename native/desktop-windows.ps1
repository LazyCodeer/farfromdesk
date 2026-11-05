# FarFromDesk desktop control for Windows, over UI Automation.
#
# One action per run: list, read, click, type, key, screenshot. Arguments arrive as
# base64 JSON in the second argument and the answer is one JSON object on stdout:
# {"ok":true,...} or {"ok":false,"error":"CODE: sentence"}.
#
# Runs in Windows PowerShell 5.1, which every supported Windows ships, with only the
# .NET assemblies Windows includes (UIAutomationClient, System.Windows.Forms,
# System.Drawing). Windows asks for no permission here, so the app's own policy layer
# is the only gate. UIPI still stops a normal process from driving an elevated
# (administrator) window; that is reported, never worked around.
param([string]$Action = '', [string]$Payload = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Send($value) { [Console]::Out.Write(($value | ConvertTo-Json -Depth 6 -Compress)); exit 0 }
function Fail([string]$code, [string]$message) { Send @{ ok = $false; error = "${code}: $message" } }

try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class FfdUser32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
}
'@
  [void][FfdUser32]::SetProcessDPIAware()
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

function Describe($el) {
  $c = $el.Current
  $role = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  $value = ''
  $pattern = $null
  if (-not $c.IsPassword -and $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $value = Clip $pattern.Current.Value }
  $name = Clip $c.Name
  [pscustomobject]@{ role = $role; name = $name; value = $(if ($value -ne $name) { $value } else { '' }) }
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

function Front($win) {
  $h = [IntPtr][long]$win.id
  if ([FfdUser32]::IsIconic($h)) { [void][FfdUser32]::ShowWindow($h, 9) }
  [void][FfdUser32]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 150
}

function Keys([string]$text) {
  # SendKeys treats + ^ % ~ ( ) { } [ ] as commands, so each goes in braces.
  ($text.ToCharArray() | ForEach-Object {
    switch -Regex ([string]$_) { '[+^%~(){}\[\]]' { "{$_}" } "`n" { '{ENTER}' } "`t" { '{TAB}' } "`r" { '' } default { [string]$_ } }
  }) -join ''
}

function Screenshot {
  $png = New-Object IO.MemoryStream; $window = $null
  if ($A.app) {
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
  $bmp.Save($png, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Send @{ ok = $true; pngBase64 = [Convert]::ToBase64String($png.ToArray()); window = $window; scope = $(if ($window) { 'window' } else { 'screen' }) }
}

try {
  switch ($Action) {
    'list' { Send @{ ok = $true; windows = @(Get-Windows | ForEach-Object { Public $_ }); session = 'windows' } }
    'read' {
      $win = Find-Window
      $all = New-Object System.Collections.ArrayList
      Walk $win.node 0 $all 4000
      $items = @(); $total = 0
      foreach ($el in $all) {
        try { if ($el.Current.IsOffscreen) { continue }; $d = Describe $el } catch { continue }
        if (-not $d.name -and -not $d.value) { continue }
        $total++; if ($items.Count -lt 250) { $items += $d }
      }
      Send @{ ok = $true; app = $win.app; window = $win.title; elements = $items; truncated = ($total -gt $items.Count) }
    }
    'click' {
      $win = Find-Window; $el = Find-Control $win $false; $p = $null; $mode = 'pattern'
      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke() }
      elseif ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle() }
      elseif ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select() }
      elseif ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand() }
      else {
        # No pattern to call: click its centre like the owner's own mouse would.
        $r = $el.Current.BoundingRectangle; Front $win
        [void][FfdUser32]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
        [FfdUser32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [FfdUser32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); $mode = 'pointer'
      }
      Send @{ ok = $true; app = $win.app; window = $win.title; control = (Describe $el); mode = $mode }
    }
    'type' {
      $win = Find-Window
      if ($A.name -or $A.role) {
        $el = Find-Control $win $true; $p = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p) -and -not $p.Current.IsReadOnly) { $p.SetValue("$($A.text)"); $mode = 'set' }
        else { $el.SetFocus(); [Windows.Forms.SendKeys]::SendWait((Keys "$($A.text)")); $mode = 'keystrokes' }
        Send @{ ok = $true; app = $win.app; window = $win.title; field = $el.Current.Name; mode = $mode }
      }
      Front $win
      [Windows.Forms.SendKeys]::SendWait((Keys "$($A.text)"))
      Send @{ ok = $true; app = $win.app; window = $win.title; mode = 'keystrokes' }
    }
    'key' {
      $win = Find-Window; Front $win
      $names = @{ return = '{ENTER}'; tab = '{TAB}'; escape = '{ESC}'; up = '{UP}'; down = '{DOWN}'; left = '{LEFT}'; right = '{RIGHT}'; space = ' '; delete = '{BACKSPACE}' }
      $k = if ($names.ContainsKey("$($A.key)")) { $names["$($A.key)"] } else { "$($A.key)" }
      # Command on a Mac is Control here, so "cmd+c" still copies.
      $mods = @{ ctrl = '^'; cmd = '^'; shift = '+'; option = '%' }
      $prefix = (@($A.modifiers) | Where-Object { $_ } | ForEach-Object { $mods["$_"] }) -join ''
      [Windows.Forms.SendKeys]::SendWait("$prefix$k")
      Send @{ ok = $true; app = $win.app; window = $win.title }
    }
    'screenshot' { Screenshot }
    default { Fail 'UNSUPPORTED_ACTION' "Unknown action $Action." }
  }
} catch [System.UnauthorizedAccessException] {
  Fail 'ELEVATED_TARGET' 'That window runs as administrator, and Windows does not let FarFromDesk drive it.'
} catch {
  Fail 'DESKTOP_NATIVE_FAILED' (Clip $_.Exception.Message)
}
