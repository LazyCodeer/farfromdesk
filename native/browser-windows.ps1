# FarFromDesk browser tabs on Windows, over UI Automation.
#
# Reads and controls the owner's ALREADY-RUNNING Chromium browsers (Chrome, Edge, Brave,
# Comet) with no setup: no extension, no launch flag, no debugging port. Chrome 136 and
# later ignore --remote-debugging-port on the default profile, so the DevTools protocol
# cannot reach the owner's real tabs; UI Automation can.
#
# What UI Automation gives, measured on Edge and Chrome 156:
# - every tab in the tab strip (a TabItem with a stable runtime id, its title, whether it
#   is selected, and its Close button);
# - for the ACTIVE tab only: the page (a Document with its URL, text, scroll and links).
# So a background tab has a title but no URL until it is selected.
#
# Never types, never moves the pointer, never presses keys. Tabs are selected with
# SelectionItemPattern, links followed with InvokePattern, pages scrolled with
# ScrollPattern, tabs closed with the tab's own Close button (InvokePattern), and new tabs
# opened by handing the URL to the browser's own executable for the same profile.
#
# One action per run. Arguments arrive as base64 JSON in the second argument; the answer
# is one UTF-8 JSON object on stdout: {"ok":true,...} or {"ok":false,"error":"CODE: sentence"}.
param([string]$Action = '', [string]$Payload = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Send($value) {
  $bytes = (New-Object Text.UTF8Encoding $false).GetBytes(($value | ConvertTo-Json -Depth 8 -Compress))
  $out = [Console]::OpenStandardOutput(); $out.Write($bytes, 0, $bytes.Length); $out.Flush(); exit 0
}
function Fail([string]$code, [string]$message) { Send @{ ok = $false; error = "${code}: $message" } }

try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class FfdBrowserUser32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  public class Win { public long Handle; public int Pid; }
  // Visible, titled top-level browser frames on every virtual desktop.
  public static System.Collections.Generic.List<Win> Windows() {
    var list = new System.Collections.Generic.List<Win>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
      var s = new System.Text.StringBuilder(64); GetClassName(h, s, 64);
      var c = s.ToString();
      if (c != "Chrome_WidgetWin_1" && c != "MozillaWindowClass") return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var w = new Win(); w.Handle = h.ToInt64(); w.Pid = (int)pid; list.Add(w);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  // The page surfaces of a Chromium window. Asking UI Automation for one is what makes
  // Chrome switch its web accessibility on (Edge has it on already).
  public static System.Collections.Generic.List<long> Pages(long top) {
    var list = new System.Collections.Generic.List<long>();
    EnumChildWindows(new IntPtr(top), delegate (IntPtr h, IntPtr l) {
      var s = new System.Text.StringBuilder(64); GetClassName(h, s, 64);
      if (s.ToString() == "Chrome_RenderWidgetHostHWND" && IsWindowVisible(h)) list.Add(h.ToInt64());
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@
  [void][FfdBrowserUser32]::SetProcessDPIAware()
} catch { Fail 'BROWSER_HELPER_FAILED' "UI Automation could not load: $($_.Exception.Message)" }

$A = New-Object psobject
if ($Payload) { $A = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json }
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
function Cond($type) { New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type) }
function Clip([string]$s, [int]$n = 300) { if ($null -eq $s) { return '' }; $s = $s.Trim(); if ($s.Length -gt $n) { $s.Substring(0, $n) } else { $s } }

# Process name -> owner-facing name. The first four have a tested adapter; the rest are
# reported as running but unsupported, so the owner hears why their tabs are missing.
$Supported = [ordered]@{ chrome = 'Google Chrome'; msedge = 'Microsoft Edge'; brave = 'Brave'; comet = 'Comet' }
$Unsupported = @{ firefox = 'Firefox'; opera = 'Opera'; vivaldi = 'Vivaldi'; arc = 'Arc'; zen = 'Zen'; floorp = 'Floorp'; waterfox = 'Waterfox' }

function ProcName([int]$id) { try { (Get-Process -Id $id).ProcessName.ToLower() } catch { '' } }

# Top-level browser windows: one row per window, with the process that owns it.
# EnumWindows rather than the UI Automation root: the root lists only the current virtual
# desktop, and a browser on another desktop would read as not running.
$Names = @{}
function Browser-Windows([string]$only, [int]$pidFilter) {
  $rows = @()
  foreach ($w in [FfdBrowserUser32]::Windows()) {
    try {
      if ($pidFilter -gt 0 -and $w.Pid -ne $pidFilter) { continue }
      if (-not $Names.ContainsKey($w.Pid)) { $Names[$w.Pid] = ProcName $w.Pid }
      $name = $Names[$w.Pid]
      if (-not $Supported.Contains($name) -and -not $Unsupported.ContainsKey($name)) { continue }
      if ($only -and $name -ne $only) { continue }
      $rows += [pscustomobject]@{ name = $name; pid = $w.Pid; hwnd = [string]$w.Handle; node = $AE::FromHandle([IntPtr]$w.Handle) }
    } catch {}
  }
  $rows
}

function Tab-Id($tab) { ($tab.GetRuntimeId()) -join '.' }
function Is-Selected($tab) { $p = $null; if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { return [bool]$p.Current.IsSelected }; $false }

# A tab's accessible name carries status after the title ("Inbox - Memory usage - 20 MB",
# "Song - Audio playing"). The active tab's exact title comes from its page instead.
function Clean-Title([string]$name) {
  $s = "$name"
  for ($i = 0; $i -lt 4; $i++) {
    $t = $s -replace ' - (Memory usage - [\d.,]+\s?[KMG]B|Audio playing|Audio muted|Muted|Pinned|Network error|Crashed|Loading|Unresponsive|Camera recording|Microphone recording|Camera and microphone recording|Sharing your screen|Bluetooth device connected|USB device connected|Serial port connected|Sleeping|Group: .*)$', ''
    if ($t -eq $s) { break }; $s = $t
  }
  $s.Trim()
}

$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
# The browser's own interface, never the web page inside it: a page can publish its own
# role="tab" elements, and walking a large page (a mail inbox) is slow. Document subtrees
# are collected as pages and not descended into.
function Browser-Ui($node) {
  $tabs = New-Object System.Collections.ArrayList; $docs = New-Object System.Collections.ArrayList; $omnibox = $null
  $queue = New-Object System.Collections.Queue; $queue.Enqueue(@($node, 0)); $seen = 0
  while ($queue.Count -and $seen -lt 3000) {
    $item = $queue.Dequeue(); $child = $Walker.GetFirstChild($item[0])
    while ($null -ne $child) {
      $seen++
      $type = $child.Current.ControlType
      if ($type -eq $CT::Document) { [void]$docs.Add($child) }
      else {
        if ($type -eq $CT::TabItem) { [void]$tabs.Add($child) }
        elseif ($type -eq $CT::Edit -and -not $omnibox -and $child.Current.ClassName -eq 'OmniboxViewViews') { $omnibox = $child }
        if ($item[1] -lt 25) { $queue.Enqueue(@($child, ($item[1] + 1))) }
      }
      $child = $Walker.GetNextSibling($child)
    }
  }
  @{ tabs = @($tabs); docs = @($docs); omnibox = $omnibox }
}
function Tabs-Of($node) { (Browser-Ui $node).tabs }
# The web page of the window's active tab: the visible Document with a URL.
function Page-Of($node, $ui = $null) {
  if (-not $ui) { $ui = Browser-Ui $node }
  foreach ($d in $ui.docs) {
    try { if ($d.Current.IsOffscreen) { continue }; $v = $null; if ($d.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$v)) { return $d } } catch {}
  }
  $null
}
# The address bar of the window, for the active tab's address when the page itself is not
# readable yet. Not while the owner is typing in it: then it holds their words, not the page.
function Omnibox-Url($ui) {
  $o = $ui.omnibox; $v = $null
  if (-not $o -or $o.Current.HasKeyboardFocus -or -not $o.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$v)) { return '' }
  $u = "$($v.Current.Value)".Trim()
  if ($u -match '^(https?|file|about|data|chrome|edge|brave)://|^about:|^data:') { return $u }
  # Chrome and Edge hide "https://" in the address bar ("github.com/owner/repo"); a bare host
  # with an optional port and path is that https address. Search text and anything else is not a URL.
  if ($u -match '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(:\d{1,5})?(/\S*)?$') { return "https://$u" }
  if ($u -match '^localhost(:\d{1,5})?(/\S*)?$') { return "http://$u" }
  ''
}
function Page-Url($doc) { if (-not $doc) { return '' }; $v = $null; if ($doc.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$v)) { "$($v.Current.Value)" } else { '' } }

# Chrome keeps its web accessibility off until a client asks a page surface for it; one
# request turns it on (measured on Chrome 156: no flag and no restart needed).
function Wake-Pages($row) {
  $woke = $false
  foreach ($h in [FfdBrowserUser32]::Pages([long]$row.hwnd)) { try { [void]$AE::FromHandle([IntPtr]$h).Current.Name; $woke = $true } catch {} }
  $woke
}
function Describe-Window($row) {
  $ui = Browser-Ui $row.node; $tabs = $ui.tabs
  if (-not $tabs.Count) { return $null }
  $doc = Page-Of $row.node $ui
  if (-not $doc -and (Wake-Pages $row)) { for ($i = 0; $i -lt 8 -and -not $doc; $i++) { Start-Sleep -Milliseconds 150; $doc = Page-Of $row.node } }
  $url = Page-Url $doc; if (-not $url) { $url = Omnibox-Url $ui }; $docTitle = if ($doc) { "$($doc.Current.Name)" } else { '' }
  $active = ''; $list = @()
  foreach ($t in $tabs) {
    $id = Tab-Id $t; $sel = Is-Selected $t
    if ($sel) { $active = $id }
    $title = if ($sel -and $docTitle) { $docTitle } else { Clean-Title $t.Current.Name }
    $list += [pscustomobject]@{ tab_id = $id; title = (Clip $title 500); url = $(if ($sel) { $url } else { '' }); active = $sel }
  }
  $r = $row.node.Current.BoundingRectangle
  [pscustomobject]@{ window_id = $row.hwnd; pid = $row.pid; browser = $row.name; active_tab_id = $active; bounds = @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }; tabs = $list }
}

function Need-Browser {
  $b = "$($A.browser)".ToLower()
  if (-not $Supported.Contains($b)) { Fail 'BROWSER_ACTION_UNSUPPORTED' "Existing tabs can be read in Chrome, Edge, Brave and Comet on this PC." }
  $b
}
function Find-Window {
  $b = Need-Browser
  $row = @(Browser-Windows $b ([int]$A.pid) | Where-Object { $_.hwnd -eq "$($A.window_id)" })
  if (-not $row.Count) { Fail 'BROWSER_TAB_GONE' 'That browser window is no longer open. List the tabs again.' }
  $row[0]
}
function Find-Tab($row) {
  foreach ($t in (Tabs-Of $row.node)) { if ((Tab-Id $t) -eq "$($A.tab_id)") { return $t } }
  Fail 'BROWSER_TAB_GONE' 'That tab is no longer open. List the tabs again.'
}
# The URL is checked only when it was known (the tab was active when listed). A background
# tab has no readable URL, so its identity is its runtime id alone.
function Check-Expected($row, $tab) {
  if ("$($A.expected_url)" -and (Is-Selected $tab)) {
    $now = Page-Url (Page-Of $row.node)
    if ($now -and $now -ne "$($A.expected_url)") { Fail 'BROWSER_TAB_GONE' 'That tab has moved to another page since it was listed. List the tabs again.' }
  }
}
function Select-Tab($row, $tab) {
  $p = $null
  if (-not $tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { Fail 'BROWSER_HELPER_FAILED' 'This tab cannot be selected through UI Automation.' }
  if (-not $p.Current.IsSelected) { $p.Select() }
  for ($i = 0; $i -lt 20 -and -not (Is-Selected $tab); $i++) { Start-Sleep -Milliseconds 50 }
  if (-not (Is-Selected $tab)) { Fail 'BROWSER_FOCUS_UNVERIFIED' 'The tab did not come to the front. List the tabs again before trying anything else.' }
}
# The selected tab's page appears a moment after the switch.
function Wait-Page($row, [string]$title) {
  for ($i = 0; $i -lt 40; $i++) {
    $doc = Page-Of $row.node
    if (-not $doc -and $i -eq 0) { [void](Wake-Pages $row) }
    if ($doc -and (-not $title -or "$($doc.Current.Name)" -eq $title -or $i -gt 20)) { return $doc }
    Start-Sleep -Milliseconds 100
  }
  Page-Of $row.node
}

function Visible-Links($doc, [int]$limit) {
  $links = @(); $i = 0
  foreach ($l in $doc.FindAll($Scope::Descendants, (Cond $CT::Hyperlink))) {
    if ($links.Count -ge $limit) { break }
    try {
      $c = $l.Current
      if ($c.IsOffscreen) { continue }
      $v = $null; $href = ''
      if ($l.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$v)) { $href = "$($v.Current.Value)" }
      if (-not $href) { continue }
      $r = $c.BoundingRectangle
      $links += [pscustomobject]@{ id = [string]$i; label = (Clip $c.Name 180); href = $href; x = [int]$r.X; y = [int]$r.Y; node = $l }
      $i++
    } catch {}
  }
  $links
}

function Page-Text($doc, [bool]$visibleOnly, [int]$limit) {
  $tp = $null
  if (-not $doc.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { return '' }
  if ($visibleOnly) { (@($tp.GetVisibleRanges() | ForEach-Object { $_.GetText($limit) }) -join "`n") }
  else { $tp.DocumentRange.GetText($limit + 1) }
}

function Screenshot($row) {
  $r = $row.node.Current.BoundingRectangle
  $bmp = New-Object Drawing.Bitmap ([int][Math]::Max(1, $r.Width)), ([int][Math]::Max(1, $r.Height))
  $g = [Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
  # PW_RENDERFULLCONTENT draws the browser even when another window covers it.
  $ok = [FfdBrowserUser32]::PrintWindow([IntPtr][long]$row.hwnd, $dc, 2)
  $g.ReleaseHdc($dc); $g.Dispose()
  if (-not $ok) { $bmp.Dispose(); return $null }
  $png = New-Object IO.MemoryStream; $bmp.Save($png, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  @{ pngBase64 = [Convert]::ToBase64String($png.ToArray()); mimeType = 'image/png'; width = [int]$r.Width; height = [int]$r.Height }
}

# The profile the running browser uses, so a new tab opens in that same browser and profile.
function Launch-Args([int]$browserPid) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$browserPid"
  if (-not $p -or -not $p.ExecutablePath) { Fail 'BROWSER_HELPER_FAILED' 'Could not find where this browser is installed.' }
  $line = "$($p.CommandLine)"; $flags = @()
  foreach ($flag in @('--user-data-dir', '--profile-directory')) {
    $m = [regex]::Match($line, [regex]::Escape($flag) + '=(?:"([^"]*)"|(\S+))')
    if ($m.Success) { $v = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }; $flags += ('"' + $flag + '=' + $v + '"') }
  }
  @{ exe = $p.ExecutablePath; args = $flags }
}

try {
  switch ($Action) {
    'inventory' {
      $seen = @{}; $rows = @()
      foreach ($w in (Browser-Windows '' 0)) {
        $key = "$($w.name):$($w.pid)"; if ($seen.ContainsKey($key)) { continue }; $seen[$key] = $true
        $label = if ($Supported.Contains($w.name)) { $Supported[$w.name] } else { $Unsupported[$w.name] }
        $rows += @{ id = $w.name; name = $label; pid = $w.pid; supported = $Supported.Contains($w.name) }
      }
      Send @{ ok = $true; browsers = @($rows) }
    }
    'tabs' {
      $b = Need-Browser
      $rows = @(Browser-Windows $b ([int]$A.pid))
      if (-not $rows.Count) { Fail 'DESKTOP_BROWSER_NOT_RUNNING' "$($Supported[$b]) is not running." }
      Send @{ ok = $true; windows = @($rows | ForEach-Object { Describe-Window $_ } | Where-Object { $_ }) }
    }
    'focus' {
      $row = Find-Window; $tab = Find-Tab $row; Check-Expected $row $tab
      Select-Tab $row $tab
      $front = $false
      if ($A.foreground) {
        $h = [IntPtr][long]$row.hwnd
        if ([FfdBrowserUser32]::IsIconic($h)) { [void][FfdBrowserUser32]::ShowWindow($h, 9) }
        [void][FfdBrowserUser32]::SetForegroundWindow($h)
        $front = ([FfdBrowserUser32]::GetForegroundWindow() -eq $h)
      }
      $doc = Wait-Page $row ''
      Send @{ ok = $true; window_id = $row.hwnd; tab_id = (Tab-Id $tab); title = $(if ($doc) { "$($doc.Current.Name)" } else { Clean-Title $tab.Current.Name }); url = (Page-Url $doc); foreground = $front }
    }
    'read' {
      $row = Find-Window; $tab = Find-Tab $row
      if (-not (Is-Selected $tab)) { Fail 'BROWSER_TAB_GONE' 'That tab is no longer the selected one. Select it again before reading.' }
      $doc = Wait-Page $row ''
      if (-not $doc) { Fail 'BROWSER_PAGE_UNREADABLE' 'This tab shows no readable page right now (it may still be loading, or be a browser settings page).' }
      $limit = if ($A.limit) { [int]$A.limit } else { 12000 }
      $text = Page-Text $doc ([bool]$A.visible_only) $limit
      $links = @(); if ($A.links) { $links = @(Visible-Links $doc 60 | ForEach-Object { @{ id = $_.id; label = $_.label; href = $_.href; x = $_.x; y = $_.y } }) }
      $r = $doc.Current.BoundingRectangle
      $shot = $null; if ($A.screenshot) { $shot = Screenshot $row }
      Send @{ ok = $true; url = (Page-Url $doc); title = "$($doc.Current.Name)"; text = "$text"; truncated = ("$text".Length -gt $limit); links = $links; viewport = @{ width = [int]$r.Width; height = [int]$r.Height }; screenshot = $shot }
    }
    'scroll' {
      $row = Find-Window; $tab = Find-Tab $row
      if (-not (Is-Selected $tab)) { Fail 'BROWSER_TAB_GONE' 'That tab is no longer the selected one. Select it again first.' }
      $doc = Wait-Page $row ''; $s = $null
      if (-not $doc -or -not $doc.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$s)) { Fail 'BROWSER_ACTION_UNSUPPORTED' 'This page cannot be scrolled through UI Automation.' }
      $amount = if ("$($A.direction)" -eq 'up') { [System.Windows.Automation.ScrollAmount]::LargeDecrement } elseif ("$($A.direction)" -eq 'down') { [System.Windows.Automation.ScrollAmount]::LargeIncrement } else { Fail 'BROWSER_ACTION_UNSUPPORTED' 'Choose up or down.' }
      if ($s.Current.VerticallyScrollable) { $s.ScrollVertical($amount) }
      Send @{ ok = $true; scrolled = [bool]$s.Current.VerticallyScrollable }
    }
    'follow' {
      $row = Find-Window; $tab = Find-Tab $row
      if (-not (Is-Selected $tab)) { Fail 'PAGE_STALE' 'That tab is no longer the selected one.' }
      $doc = Wait-Page $row ''
      if ((Page-Url $doc) -ne "$($A.expected_url)") { Fail 'PAGE_STALE' 'The page changed. Read it again.' }
      $link = @(Visible-Links $doc 60 | Where-Object { $_.id -eq "$($A.link_id)" })
      if (-not $link.Count -or $link[0].href -ne "$($A.href)" -or $link[0].label -ne "$($A.label)") { Fail 'PAGE_STALE' 'The link moved. Read the page again.' }
      if ($link[0].href -notmatch '^https?://') { Fail 'BROWSER_ACTION_UNSUPPORTED' 'Only ordinary web links can be followed.' }
      $p = $null
      if (-not $link[0].node.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { Fail 'BROWSER_ACTION_UNSUPPORTED' 'This link cannot be followed through UI Automation.' }
      $p.Invoke()
      Send @{ ok = $true; navigationRequested = $true }
    }
    'close' {
      $row = Find-Window; $tab = Find-Tab $row; Check-Expected $row $tab
      if ((Tabs-Of $row.node).Count -le 1) { Fail 'BROWSER_ACTION_UNSUPPORTED' 'That is the last tab in its window, so closing it would close the window. I left it open.' }
      $buttons = @($tab.FindAll($Scope::Descendants, (Cond $CT::Button)))
      $p = $null
      if (-not $buttons.Count -or -not $buttons[-1].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { Fail 'BROWSER_ACTION_UNSUPPORTED' 'This tab has no close button UI Automation can press.' }
      $id = Tab-Id $tab
      $p.Invoke()
      for ($i = 0; $i -lt 30; $i++) {
        if (-not @(Tabs-Of $row.node | Where-Object { (Tab-Id $_) -eq $id }).Count) { Send @{ ok = $true; closed = $true; tab_id = $id } }
        Start-Sleep -Milliseconds 100
      }
      Fail 'BROWSER_CLOSE_UNVERIFIED' 'I asked the browser to close the tab but could not confirm it closed. List the tabs to check.'
    }
    'open' {
      $b = Need-Browser
      $url = "$($A.url)"
      if ($url -ne 'about:blank' -and $url -notmatch '^https?://[^\s"]+$') { Fail 'DESKTOP_URL_INVALID' 'Only ordinary web addresses can be opened.' }
      $rows = @(Browser-Windows $b ([int]$A.pid))
      if (-not $rows.Count) { Fail 'DESKTOP_BROWSER_NOT_RUNNING' "$($Supported[$b]) is not running." }
      $before = @{}; foreach ($r in $rows) { foreach ($t in (Tabs-Of $r.node)) { $before[(Tab-Id $t)] = $true } }
      $launch = Launch-Args $rows[0].pid
      # "--" ends the switches, so the address can never be read as a browser flag.
      $argv = @($launch.args) + @('--', $url)
      Start-Process -FilePath $launch.exe -ArgumentList $argv | Out-Null
      for ($i = 0; $i -lt 50; $i++) {
        Start-Sleep -Milliseconds 200
        foreach ($r in @(Browser-Windows $b $rows[0].pid)) {
          foreach ($t in (Tabs-Of $r.node)) {
            if (-not $before.ContainsKey((Tab-Id $t))) {
              Send @{ ok = $true; window_id = $r.hwnd; tab_id = (Tab-Id $t); title = (Clean-Title $t.Current.Name); url = $url }
            }
          }
        }
      }
      Fail 'NEW_TAB_OUTCOME_UNKNOWN' 'The browser was asked to open the page, but no new tab appeared in time. List the tabs to check before trying again.'
    }
    default { Fail 'BROWSER_ACTION_UNSUPPORTED' "Unknown browser action $Action." }
  }
} catch [System.UnauthorizedAccessException] {
  Fail 'ELEVATED_TARGET' 'That browser runs as administrator, and Windows does not let FarFromDesk read it.'
} catch {
  Fail 'BROWSER_HELPER_FAILED' ("The browser could not be read through UI Automation: " + (Clip $_.Exception.Message 200))
}
