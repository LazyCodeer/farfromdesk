# FarFromDesk app tools for Windows: Outlook (calendar, tasks, mail), OneNote pages and the
# system media controls.
#
# One operation per run. The operation is the first argument and its arguments arrive as base64
# JSON in the second, so no owner text is ever parsed by a shell. The answer is one JSON object on
# stdout, written as UTF-8: {"ok":true,"text":"..."} or {"ok":true,"data":...} on success, and
# {"ok":false,"error":"CODE: sentence"} when the request cannot be carried out. A sentence after a
# code other than INTERNAL is written for the owner and is shown to them as it is.
#
# Why one process per call (and not a long-lived helper like remote-windows.ps1): Outlook and
# OneNote stay running in the background for as long as a COM client holds them, so a resident
# helper would keep both alive all day, and one COM call that hangs would block every later one.
# A call that ends releases everything; the caller's timeout and Stop button kill a stuck call.
#
# Calendar and Reminders answer the EventKit helper's command line (native/eventkit-helper.swift)
# with the same JSON, so the macOS packs and their formatters are reused unchanged: Reminders are
# Outlook tasks. Nothing here ever sends mail or meeting invitations: a draft is saved, never sent,
# and events with other people on them, or that repeat, are refused for change and delete.
#
# Windows PowerShell 5.1, ASCII only. Tests pass -Fake <script> to dot-source fake COM objects in
# place of Outlook, OneNote and the media controls; production never passes it.
param([string]$Op = '', [string]$Payload = '', [string]$Fake = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Utf8 = New-Object System.Text.UTF8Encoding($false)
function Send($value) {
  $json = ConvertTo-Json -InputObject $value -Depth 8 -Compress
  $bytes = $Utf8.GetBytes($json)
  $out = [Console]::OpenStandardOutput()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
  exit 0
}
function Say([string]$text) { Send ([ordered]@{ ok = $true; text = $text }) }
function Answer($value) { Send ([ordered]@{ ok = $true; data = $value }) }
function Fail([string]$code, [string]$message) { Send ([ordered]@{ ok = $false; error = "${code}: $message" }) }
function Refuse([string]$message) { Fail 'REFUSED' $message }

$A = New-Object psobject
if ($Payload) {
  try { $A = $Utf8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json }
  catch { Fail 'INTERNAL' 'The request arguments could not be read.' }
}
function Arg([string]$name) { $v = $A.$name; if ($null -eq $v) { '' } else { [string]$v } }
function ArgInt([string]$name, [int]$fallback) { $v = $A.$name; if ($null -eq $v -or "$v" -eq '') { $fallback } else { [int]$v } }

# ---------------------------------------------------------------------------------------------
# The COM and WinRT entry points. A test's -Fake script redefines these.

function Test-OutlookInstalled { Test-Path 'Registry::HKEY_CLASSES_ROOT\Outlook.Application\CLSID' }
function Test-OutlookProfile {
  foreach ($v in '16.0', '15.0') {
    $k = "HKCU:\Software\Microsoft\Office\$v\Outlook\Profiles"
    if ((Test-Path $k) -and @(Get-ChildItem $k -ErrorAction SilentlyContinue).Count -gt 0) { return $true }
  }
  $false
}
function New-OutlookApp { New-Object -ComObject Outlook.Application }
function Test-OneNoteInstalled { Test-Path 'Registry::HKEY_CLASSES_ROOT\OneNote.Application\CLSID' }
function New-OneNoteApp { New-Object -ComObject OneNote.Application }

# The current media session as a small object with Info(), Toggle(), Next() and Previous(), or
# $null when nothing is playing. WinRT async calls are awaited through AsTask.
function Get-MediaSession {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $await = { param($op, [Type]$type) $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); if (-not $task.Wait(8000)) { throw 'The media controls did not answer in time.' }; $task.Result }.GetNewClosure()
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = & $await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $session = $manager.GetCurrentSession()
  if ($null -eq $session) { return $null }
  $wrap = New-Object psobject
  $wrap | Add-Member -NotePropertyName Session -NotePropertyValue $session
  $wrap | Add-Member -NotePropertyName Await -NotePropertyValue $await
  $wrap | Add-Member ScriptMethod Info {
    $p = & $this.Await ($this.Session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    [ordered]@{ title = "$($p.Title)"; artist = "$($p.Artist)"; album = "$($p.AlbumTitle)"; app = "$($this.Session.SourceAppUserModelId)"; status = "$($this.Session.GetPlaybackInfo().PlaybackStatus)" }
  }
  $wrap | Add-Member ScriptMethod Toggle { [bool](& $this.Await ($this.Session.TryTogglePlayPauseAsync()) ([bool])) }
  $wrap | Add-Member ScriptMethod Next { [bool](& $this.Await ($this.Session.TrySkipNextAsync()) ([bool])) }
  $wrap | Add-Member ScriptMethod Previous { [bool](& $this.Await ($this.Session.TrySkipPreviousAsync()) ([bool])) }
  $wrap
}

if ($Fake) { . $Fake }

# ---------------------------------------------------------------------------------------------
# Shared helpers.

$Invariant = [Globalization.CultureInfo]::InvariantCulture
function Stamp($date) { ([datetime]$date).ToString('yyyy-MM-dd HH:mm:ss', $Invariant) }
function Clip([string]$s, [int]$n) { if ($null -eq $s) { return '' }; if ($s.Length -gt $n) { $s.Substring(0, $n) } else { $s } }
function Tidy([string]$s) { if ($null -eq $s) { return '' }; (($s -replace "`r`n", "`n") -replace "`n{3,}", "`n`n").Trim() }
function Same([string]$a, [string]$b) { [string]::Equals("$a".Trim(), "$b".Trim(), [StringComparison]::OrdinalIgnoreCase) }
function Has([string]$hay, [string]$needle) { "$hay".IndexOf("$needle", [StringComparison]::OrdinalIgnoreCase) -ge 0 }

# ---------------------------------------------------------------------------------------------
# Outlook.

$script:App = $null; $script:NS = $null; $script:TestStore = $null
function Open-Outlook {
  if (-not (Test-OutlookInstalled)) { Fail 'OUTLOOK_UNAVAILABLE' 'Classic Outlook is not installed on this PC, and the new Outlook app cannot be reached by other programs. Install Outlook from Microsoft 365, or use Outlook on the web for now.' }
  $testPst = "$env:FFD_OUTLOOK_TEST_PST"
  if (-not $testPst -and -not (Test-OutlookProfile)) { Fail 'OUTLOOK_NO_ACCOUNT' 'Outlook on this PC has no email account set up yet. Open Outlook, add your account, then ask me again.' }
  try { $script:App = New-OutlookApp; $script:NS = $script:App.GetNamespace('MAPI') }
  catch { Fail 'OUTLOOK_UNAVAILABLE' ('Outlook did not start, so I could not reach it: ' + (Clip $_.Exception.Message 200)) }
  if ($testPst) {
    # Opt-in live tests only: a throwaway data file the test created, attached for this call.
    $script:NS.AddStoreEx($testPst, 2)
    foreach ($s in $script:NS.Stores) { if ($s.FilePath -and (Same $s.FilePath $testPst)) { $script:TestStore = $s } }
    if (-not $script:TestStore) { Fail 'INTERNAL' 'The test data file did not open.' }
    return
  }
  $accounts = 0
  try { $accounts = $script:NS.Accounts.Count } catch {}
  if ($accounts -lt 1) { Fail 'OUTLOOK_NO_ACCOUNT' 'Outlook on this PC has no email account set up yet. Open Outlook, add your account, then ask me again.' }
}
function Close-Outlook {
  if ($script:TestStore) { try { $script:NS.RemoveStore($script:TestStore.GetRootFolder()) } catch {} }
}
function Stores { if ($script:TestStore) { @($script:TestStore) } else { @($script:NS.Stores) } }
function Default-Folder([int]$kind) {
  if ($script:TestStore) { return $script:TestStore.GetDefaultFolder($kind) }
  $script:NS.GetDefaultFolder($kind)
}

# Every folder of one kind (9 calendar, 13 tasks) in every store, with a label that names the
# account only when two folders share a name. A store that will not open is skipped.
function Kind-Folders([int]$kind, [int]$itemType) {
  $found = @()
  foreach ($store in (Stores)) {
    $root = $null
    try { $root = $store.GetDefaultFolder($kind) } catch { continue }
    if ($null -eq $root) { continue }
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($root)
    $seen = 0
    while ($queue.Count -gt 0 -and $seen -lt 200) {
      $f = $queue.Dequeue(); $seen++
      $found += [pscustomobject]@{ folder = $f; name = "$($f.Name)"; store = "$($store.DisplayName)" }
      try { foreach ($child in $f.Folders) { if ($child.DefaultItemType -eq $itemType) { $queue.Enqueue($child) } } } catch {}
    }
  }
  foreach ($row in $found) {
    $twins = @($found | Where-Object { Same $_.name $row.name }).Count
    $label = if ($twins -gt 1 -and $row.store) { "$($row.name) ($($row.store))" } else { $row.name }
    $row | Add-Member -NotePropertyName label -NotePropertyValue $label
  }
  $found
}
function Find-KindFolder([int]$kind, [int]$itemType, [string]$name, [string]$noun) {
  foreach ($row in (Kind-Folders $kind $itemType)) { if ((Same $row.name $name) -or (Same $row.label $name)) { return $row } }
  Refuse "There is no $noun called `"$name`"."
}

# Items of one folder, read with GetFirst/GetNext: with recurrences included, Count is meaningless.
function Each-Item($items, [int]$cap) {
  $out = New-Object System.Collections.ArrayList
  $item = $items.GetFirst()
  while ($null -ne $item -and $out.Count -lt $cap) { [void]$out.Add($item); $item = $items.GetNext() }
  $out
}
function Restricted($folder, [string]$filter, [bool]$recurrences) {
  $items = $folder.Items
  if ($recurrences) { $items.IncludeRecurrences = $true; $items.Sort('[Start]') }
  try { return $items.Restrict($filter) }
  catch {
    # A filter Outlook will not take (a locale it cannot parse) falls back to the plain items;
    # every caller filters again by date and title, so the answer stays right, only slower.
    $plain = $folder.Items
    return $plain
  }
}
function Jet([datetime]$d) { $d.ToString('g') }
function Quote([string]$s) { "'" + ($s -replace "'", "''") + "'" }

# --- argument parsing, matching eventkit-helper's -------------------------------------------

function Parse-Argv($argv) {
  $list = @($argv)
  if ($list.Count -lt 1) { Refuse 'I need a command.' }
  $name = [string]$list[0]
  $booleans = @{ reminders = @('--completed'); create = @('--all-day') }
  $flags = @{}
  $i = 1
  while ($i -lt $list.Count) {
    $token = [string]$list[$i]
    if (-not $token.StartsWith('--')) { Refuse "I did not understand `"$token`". Every option starts with --." }
    if ($booleans.ContainsKey($name) -and $booleans[$name] -contains $token) { $flags[$token] = ''; $i++; continue }
    if ($i + 1 -ge $list.Count) { Refuse "$token needs a value straight after it." }
    $flags[$token] = [string]$list[$i + 1]; $i += 2
  }
  [pscustomobject]@{ name = $name; flags = $flags }
}
function Allow($flags, [string[]]$allowed, [string]$command) {
  foreach ($k in $flags.Keys) { if ($allowed -notcontains $k) { Refuse "I do not know the option `"$k`" for $command." } }
}
function Need($flags, [string]$name, [string]$command) {
  if (-not $flags.ContainsKey($name) -or "$($flags[$name])".Trim() -eq '') { Refuse "$command needs $name followed by its value." }
  [string]$flags[$name]
}
function Parse-When([string]$value, [string]$label) {
  $d = [datetime]::MinValue
  if ([datetime]::TryParseExact($value, 'yyyy-MM-dd HH:mm:ss', $Invariant, [Globalization.DateTimeStyles]::AssumeLocal, [ref]$d)) { return [pscustomobject]@{ date = $d; day = $false } }
  if ([datetime]::TryParseExact($value, 'yyyy-MM-dd', $Invariant, [Globalization.DateTimeStyles]::AssumeLocal, [ref]$d)) { return [pscustomobject]@{ date = $d; day = $true } }
  Refuse "$label must look like `"2026-04-30 14:30:00`" or `"2026-04-30`", but it was `"$value`"."
}
function Parse-Limit([string]$value, [int]$fallback, [int]$cap) {
  if ($value -eq '') { return $fallback }
  $n = 0
  if (-not [int]::TryParse($value, [ref]$n) -or $n -lt 1) { Refuse "--limit needs a whole number, but it was `"$value`"." }
  [Math]::Min($n, $cap)
}

# --- calendar ---------------------------------------------------------------------------------

$ResponseWords = @{ 0 = 'no reply'; 1 = 'organizer'; 2 = 'tentative'; 3 = 'accepted'; 4 = 'declined'; 5 = 'no reply' }
function Is-Meeting($item) { try { [int]$item.MeetingStatus -ne 0 } catch { $false } }
function Event-Json($item, [string]$label) {
  $o = [ordered]@{
    id = "$($item.EntryID)"; title = "$($item.Subject)"; startDate = (Stamp $item.Start); endDate = (Stamp $item.End)
    calendar = $label; isAllDay = [bool]$item.AllDayEvent
  }
  $notes = Tidy "$($item.Body)"
  if ($notes) { $o.notes = Clip $notes 4000 }
  if ("$($item.Location)".Trim()) { $o.location = "$($item.Location)" }
  if (Is-Meeting $item) {
    $people = @()
    foreach ($r in $item.Recipients) {
      $status = 'no reply'; try { $status = $ResponseWords[[int]$r.MeetingResponseStatus] } catch {}
      $people += [ordered]@{ name = "$($r.Name)"; url = ''; status = "$status" }
    }
    if ($people.Count -eq 0) { $people = @([ordered]@{ name = 'someone'; url = ''; status = 'no reply' }) }
    $o.attendees = $people
  }
  if ([bool]$item.IsRecurring) { $o.recurrenceRules = @('repeats') }
  $o
}
function Events-Between([datetime]$from, [datetime]$to, $rows, [int]$cap) {
  $hits = New-Object System.Collections.ArrayList
  $filter = "[Start] < " + (Quote (Jet $to)) + " AND [End] > " + (Quote (Jet $from))
  foreach ($row in $rows) {
    $items = Restricted $row.folder $filter $true
    foreach ($item in (Each-Item $items 2000)) {
      try { $start = [datetime]$item.Start; $end = [datetime]$item.End } catch { continue }
      if ($start -lt $to -and $end -gt $from) { [void]$hits.Add([pscustomobject]@{ item = $item; label = $row.label; start = $start }) }
    }
  }
  $hits | Sort-Object start | Select-Object -First $cap
}
function Match-Events([string]$title, $start) {
  $rows = Kind-Folders 9 1
  $found = @()
  if ($null -ne $start) {
    foreach ($hit in (Events-Between $start.date.AddDays(-1) $start.date.AddDays(1) $rows 2000)) {
      if ((Same $hit.item.Subject $title) -and [Math]::Abs(($hit.start - $start.date).TotalSeconds) -le 90) { $found += $hit }
    }
  } else {
    foreach ($row in $rows) {
      $items = Restricted $row.folder ("[Subject] = " + (Quote $title)) $false
      foreach ($item in (Each-Item $items 2000)) { if (Same $item.Subject $title) { $found += [pscustomobject]@{ item = $item; label = $row.label; start = [datetime]$item.Start } } }
    }
  }
  $found
}

function Run-EventKit {
  $command = Parse-Argv $A.argv
  $f = $command.flags
  switch ($command.name) {
    'calendars' {
      Allow $f @() 'calendars'
      Answer @(Kind-Folders 9 1 | ForEach-Object { [ordered]@{ id = "$($_.folder.EntryID)"; title = $_.label } })
    }
    'events' {
      Allow $f @('--from', '--to', '--calendar', '--limit') 'events'
      $from = Parse-When (Need $f '--from' 'events') '--from'
      $to = Parse-When (Need $f '--to' 'events') '--to'
      if ($to.date -le $from.date) { Refuse '--to must be later than --from.' }
      $limit = Parse-Limit "$($f['--limit'])" 300 300
      $rows = if ($f.ContainsKey('--calendar')) { @(Find-KindFolder 9 1 $f['--calendar'] 'calendar') } else { Kind-Folders 9 1 }
      Answer @(Events-Between $from.date $to.date $rows $limit | ForEach-Object { Event-Json $_.item $_.label })
    }
    'event-by-title' {
      Allow $f @('--title', '--start') 'event-by-title'
      $title = Need $f '--title' 'event-by-title'
      $start = if ($f.ContainsKey('--start')) { Parse-When $f['--start'] '--start' } else { $null }
      $found = @(Match-Events $title $start)
      if ($found.Count -eq 0) { Refuse "There is no event called `"$title`" at that time." }
      if ($found.Count -gt 1) { Refuse "More than one event matches `"$title`", so nothing was changed." }
      Answer (Event-Json $found[0].item $found[0].label)
    }
    'create' {
      Allow $f @('--title', '--start', '--end', '--calendar', '--location', '--notes', '--all-day') 'create'
      $title = Need $f '--title' 'create'
      $start = Parse-When (Need $f '--start' 'create') '--start'
      $end = Parse-When (Need $f '--end' 'create') '--end'
      $allDay = $f.ContainsKey('--all-day')
      if ($allDay -and -not ($start.day -and $end.day)) { Refuse 'With --all-day, --start and --end must be days like "2026-04-30".' }
      if (-not $allDay -and ($start.day -or $end.day)) { Refuse 'Without --all-day, --start and --end must include a time, like "2026-04-30 14:30:00".' }
      if ($end.date -le $start.date) { Refuse 'The end time must be after the start time.' }
      $row = if ($f.ContainsKey('--calendar')) { Find-KindFolder 9 1 $f['--calendar'] 'calendar' } else { $d = Default-Folder 9; [pscustomobject]@{ folder = $d; label = "$($d.Name)" } }
      $item = $row.folder.Items.Add(1)
      $item.Subject = $title
      if ($allDay) { $item.AllDayEvent = $true }
      $item.Start = $start.date
      $item.End = $end.date
      if ($f.ContainsKey('--location')) { $item.Location = $f['--location'] }
      if ($f.ContainsKey('--notes')) { $item.Body = $f['--notes'] }
      try { $item.Save() } catch { Refuse 'Outlook would not save the new event.' }
      Answer (Event-Json $item $row.label)
    }
    'update' {
      Allow $f @('--title', '--start', '--new-title', '--new-start', '--new-end', '--location', '--notes') 'update'
      $title = Need $f '--title' 'update'
      $start = Parse-When (Need $f '--start' 'update') '--start'
      $newStart = if ($f.ContainsKey('--new-start')) { (Parse-When $f['--new-start'] '--new-start').date } else { $null }
      $newEnd = if ($f.ContainsKey('--new-end')) { (Parse-When $f['--new-end'] '--new-end').date } else { $null }
      $found = @(Match-Events $title $start)
      if ($found.Count -eq 0) { Refuse "There is no event called `"$title`" near that time." }
      if ($found.Count -gt 1) { Refuse "More than one event is called `"$title`" near that time, so I did not change anything." }
      $item = $found[0].item
      if ([bool]$item.IsRecurring) { Refuse 'That event repeats, so I did not change it. Change it in Outlook instead.' }
      if (Is-Meeting $item) { Refuse 'Other people are on that event, so I did not change it. Change it in Outlook instead.' }
      $finalStart = if ($null -ne $newStart) { $newStart } else { [datetime]$item.Start }
      $finalEnd = if ($null -ne $newEnd) { $newEnd } elseif ($null -ne $newStart) { $newStart + ([datetime]$item.End - [datetime]$item.Start) } else { [datetime]$item.End }
      if ($finalEnd -le $finalStart) { Refuse 'The end time must be after the start time.' }
      if ($f.ContainsKey('--new-title')) { $item.Subject = $f['--new-title'] }
      # Start first: Outlook keeps the length when the start moves, then the end is set exactly.
      if ($null -ne $newStart) { $item.Start = $finalStart }
      $item.End = $finalEnd
      if ($f.ContainsKey('--location')) { $item.Location = $f['--location'] }
      if ($f.ContainsKey('--notes')) { $item.Body = $f['--notes'] }
      try { $item.Save() } catch { Refuse 'Outlook would not save the change.' }
      Answer (Event-Json $item $found[0].label)
    }
    'delete' {
      Allow $f @('--title', '--start', '--confirm') 'delete'
      $title = Need $f '--title' 'delete'
      $start = Parse-When (Need $f '--start' 'delete') '--start'
      $found = @(Match-Events $title $start)
      if ($found.Count -eq 0) { Refuse "There is no event called `"$title`" near that time." }
      if ($found.Count -gt 1) { Refuse "More than one event is called `"$title`" near that time, so I did not change anything." }
      if ("$($f['--confirm'])" -cne $title) { Refuse "To delete `"$title`" I need --confirm to say exactly `"$title`". Nothing was deleted." }
      $item = $found[0].item
      if ([bool]$item.IsRecurring) { Refuse 'That event repeats, so I did not delete it. Delete it in Outlook instead.' }
      if (Is-Meeting $item) { Refuse 'Other people are on that event, so I did not delete it. Delete it in Outlook instead.' }
      $json = Event-Json $item $found[0].label
      try { $item.Delete() } catch { Refuse 'Outlook would not delete the event.' }
      Answer $json
    }
    'lists' {
      Allow $f @() 'lists'
      Answer @(Kind-Folders 13 3 | ForEach-Object { [ordered]@{ id = "$($_.folder.EntryID)"; title = $_.label } })
    }
    'reminders' {
      Allow $f @('--list', '--limit', '--completed') 'reminders'
      $limit = Parse-Limit "$($f['--limit'])" 200 200
      $done = $f.ContainsKey('--completed')
      $rows = if ($f.ContainsKey('--list')) { @(Find-KindFolder 13 3 $f['--list'] 'list') } else { Kind-Folders 13 3 }
      $tasks = @()
      foreach ($row in $rows) { foreach ($t in (Each-Item $row.folder.Items 2000)) { if ([bool]$t.Complete -eq $done) { $tasks += [pscustomobject]@{ item = $t; label = $row.label; due = (Due $t); title = "$($t.Subject)" } } } }
      $ordered = @($tasks | Sort-Object @{ Expression = { if ($null -eq $_.due) { [datetime]::MaxValue } else { $_.due } } }, title)
      Answer @($ordered | Select-Object -First $limit | ForEach-Object { Task-Json $_.item $_.label })
    }
    'reminder' {
      Allow $f @('--title', '--list') 'reminder'
      $title = Need $f '--title' 'reminder'
      $found = @(Match-Tasks $title $f)
      if ($found.Count -eq 0) { Refuse "There is no reminder called `"$title`"." }
      if ($found.Count -gt 1) { Refuse "More than one reminder is called `"$title`", so I did not change anything." }
      Answer (Task-Json $found[0].item $found[0].label)
    }
    'reminder-create' {
      Allow $f @('--title', '--list', '--due', '--notes', '--priority') 'reminder-create'
      $title = Need $f '--title' 'reminder-create'
      $due = if ($f.ContainsKey('--due')) { Parse-When $f['--due'] '--due' } else { $null }
      $priority = if ($f.ContainsKey('--priority')) { Parse-Priority $f['--priority'] } else { $null }
      $row = if ($f.ContainsKey('--list')) { Find-KindFolder 13 3 $f['--list'] 'list' } else { $d = Default-Folder 13; [pscustomobject]@{ folder = $d; label = "$($d.Name)" } }
      $t = $row.folder.Items.Add(3)
      $t.Subject = $title
      if ($null -ne $due) { $t.DueDate = $due.date.Date }
      if ($f.ContainsKey('--notes')) { $t.Body = $f['--notes'] }
      if ($null -ne $priority) { $t.Importance = Importance $priority }
      try { $t.Save() } catch { Refuse 'Outlook would not save the new task.' }
      Answer (Task-Json $t $row.label)
    }
    'reminder-update' {
      Allow $f @('--title', '--list', '--new-title', '--due', '--notes', '--priority', '--completed') 'reminder-update'
      $title = Need $f '--title' 'reminder-update'
      $clearDue = $f.ContainsKey('--due') -and (Same $f['--due'] 'none')
      $due = if ($f.ContainsKey('--due') -and -not $clearDue) { Parse-When $f['--due'] '--due' } else { $null }
      $priority = if ($f.ContainsKey('--priority')) { Parse-Priority $f['--priority'] } else { $null }
      $completed = $null
      if ($f.ContainsKey('--completed')) {
        if ($f['--completed'] -eq 'yes') { $completed = $true } elseif ($f['--completed'] -eq 'no') { $completed = $false } else { Refuse "--completed must be yes or no, but it was `"$($f['--completed'])`"." }
      }
      $found = @(Match-Tasks $title $f)
      if ($found.Count -eq 0) { Refuse "There is no reminder called `"$title`"." }
      if ($found.Count -gt 1) { Refuse "More than one reminder is called `"$title`", so I did not change anything." }
      $t = $found[0].item
      if ($f.ContainsKey('--new-title')) { $t.Subject = $f['--new-title'] }
      if ($clearDue) { $t.DueDate = [datetime]'4501-01-01' } elseif ($null -ne $due) { $t.DueDate = $due.date.Date }
      if ($f.ContainsKey('--notes')) { $t.Body = $f['--notes'] }
      if ($null -ne $priority) { $t.Importance = Importance $priority }
      if ($completed -eq $true) { $t.MarkComplete() } elseif ($completed -eq $false) { $t.Complete = $false }
      try { $t.Save() } catch { Refuse 'Outlook would not save the change.' }
      Answer (Task-Json $t $found[0].label)
    }
    'reminder-delete' {
      Allow $f @('--title', '--list', '--confirm') 'reminder-delete'
      $title = Need $f '--title' 'reminder-delete'
      if ("$($f['--confirm'])" -cne $title) { Refuse "To delete `"$title`" I need --confirm to say exactly `"$title`". Nothing was deleted." }
      $found = @(Match-Tasks $title $f)
      if ($found.Count -eq 0) { Refuse "There is no reminder called `"$title`"." }
      if ($found.Count -gt 1) { Refuse "More than one reminder is called `"$title`", so I did not change anything." }
      $json = Task-Json $found[0].item $found[0].label
      try { $found[0].item.Delete() } catch { Refuse 'Outlook would not delete the task.' }
      Answer $json
    }
    default { Refuse "`"$($command.name)`" is not a command I know." }
  }
}

# --- tasks ------------------------------------------------------------------------------------

function Due($task) { try { $d = [datetime]$task.DueDate; if ($d.Year -ge 4500) { $null } else { $d } } catch { $null } }
function Parse-Priority([string]$value) {
  $n = 0
  if (-not [int]::TryParse($value, [ref]$n) -or $n -lt 0 -or $n -gt 9) { Refuse "--priority must be a whole number from 0 to 9, but it was `"$value`"." }
  $n
}
# EventKit priority 1-4 is high, 5 medium, 6-9 low and 0 none; Outlook has low, normal and high.
function Importance([int]$p) { if ($p -ge 1 -and $p -le 4) { 2 } elseif ($p -ge 6) { 0 } else { 1 } }
function Task-Json($task, [string]$label) {
  $importance = 1; try { $importance = [int]$task.Importance } catch {}
  $o = [ordered]@{
    id = "$($task.EntryID)"; title = "$($task.Subject)"; list = $label; isCompleted = [bool]$task.Complete
    priority = $(if ($importance -eq 2) { 1 } elseif ($importance -eq 0) { 9 } else { 0 })
  }
  $due = Due $task
  if ($null -ne $due) { $o.dueDate = Stamp $due }
  try { $s = [datetime]$task.StartDate; if ($s.Year -lt 4500) { $o.startDate = Stamp $s } } catch {}
  if ([bool]$task.Complete) { try { $c = [datetime]$task.DateCompleted; if ($c.Year -lt 4500) { $o.completionDate = Stamp $c } } catch {} }
  $notes = Tidy "$($task.Body)"
  if ($notes) { $o.notes = Clip $notes 4000 }
  $o
}
function Match-Tasks([string]$title, $flags) {
  $rows = if ($flags.ContainsKey('--list')) { @(Find-KindFolder 13 3 $flags['--list'] 'list') } else { Kind-Folders 13 3 }
  $found = @()
  foreach ($row in $rows) { foreach ($t in (Each-Item $row.folder.Items 2000)) { if (Same $t.Subject $title) { $found += [pscustomobject]@{ item = $t; label = $row.label } } } }
  $found
}

# --- mail -------------------------------------------------------------------------------------

function Mail-Folder([string]$name) {
  $inbox = Default-Folder 6
  if (-not $name -or (Same $name 'inbox')) { return [pscustomobject]@{ folder = $inbox; label = 'Inbox' } }
  $queue = New-Object System.Collections.Queue
  foreach ($store in (Stores)) { try { $queue.Enqueue($store.GetRootFolder()) } catch {} }
  $seen = 0
  while ($queue.Count -gt 0 -and $seen -lt 1000) {
    $f = $queue.Dequeue(); $seen++
    if ((Same $f.Name $name) -and ($f.DefaultItemType -eq 0)) { return [pscustomobject]@{ folder = $f; label = "$($f.Name)" } }
    try { foreach ($child in $f.Folders) { $queue.Enqueue($child) } } catch {}
  }
  Say "I could not find a mail folder called $name in Outlook."
}
function Newest($folder, [int]$cap) {
  $items = $folder.Items
  $items.Sort('[ReceivedTime]', $true)
  Each-Item $items $cap
}
function Sender($m) {
  $name = "$($m.SenderName)"
  $address = ''
  try { if ("$($m.SenderEmailType)" -eq 'SMTP') { $address = "$($m.SenderEmailAddress)" } } catch {}
  if ($address -and -not (Same $address $name)) { "$name <$address>" } elseif ($name) { $name } else { $address }
}
function Subject($m) { $s = "$($m.Subject)"; if ($s.Trim()) { $s } else { '(no subject)' } }
function Received($m) { try { Stamp $m.ReceivedTime } catch { '' } }

function Run-Mail {
  switch ($Op) {
    'mail-recent' {
      $limit = ArgInt 'limit' 10; $slice = ArgInt 'slice' 400; $scan = ArgInt 'scan' 300
      $box = Mail-Folder (Arg 'folder')
      $blocks = @()
      foreach ($m in (Newest $box.folder $scan)) {
        if ($blocks.Count -ge $limit) { break }
        $text = Tidy "$($m.Body)"
        $cut = $text.Length -gt $slice
        $block = "- from: $(Sender $m)`n  subject: $(Subject $m)`n  text: $(Clip $text $slice)"
        if ($cut) { $block += ' [cut off here: the message continues]' }
        $blocks += $block
      }
      if ($blocks.Count -eq 0) { Say "There are no messages in $($box.label) in Outlook." }
      Say ("Showing $($blocks.Count) newest message(s) in $($box.label), with the sender, the subject and the start of each message text:`n" + ($blocks -join "`n"))
    }
    'mail-find' {
      $q = Arg 'query'; $scan = ArgInt 'scan' 300; $max = ArgInt 'max' 12
      $box = Mail-Folder (Arg 'folder')
      $lines = @(); $seen = 0
      foreach ($m in (Newest $box.folder $scan)) {
        $seen++
        $who = Sender $m
        if ((Has $m.Subject $q) -or (Has $who $q)) { $lines += "- from: $who | subject: $(Subject $m) | date: $(Received $m)" }
        if ($lines.Count -ge $max) { break }
      }
      if ($lines.Count -eq 0) { Say "No message in $($box.label) had $q in its subject or its sender, after looking at $seen message(s)." }
      Say ("Found $($lines.Count) message(s) with $q in the subject or the sender, after looking at $seen message(s); the sender, subject and date only:`n" + ($lines -join "`n"))
    }
    'mail-read' {
      $subject = Arg 'subject'; $sender = Arg 'sender'; $chars = ArgInt 'chars' 4000; $scan = ArgInt 'scan' 300
      $box = Mail-Folder ''
      $hits = @(); $seen = 0
      foreach ($m in (Newest $box.folder $scan)) {
        $seen++
        if ((Same $m.Subject $subject) -and (Has (Sender $m) $sender)) { $hits += $m }
        if ($hits.Count -ge 2) { break }
      }
      if ($hits.Count -eq 0) { Say "No message in the inbox has the subject $subject from a sender matching $sender, after looking at $seen message(s)." }
      if ($hits.Count -gt 1) { Say "More than one message in the inbox has the subject $subject and a sender matching $sender, so I did not guess: name the sender more exactly." }
      $m = $hits[0]
      $text = Tidy "$($m.Body)"
      $lead = "The message $(Subject $m) from $(Sender $m)"
      if ($text.Length -eq 0) { Say "$lead is empty: it has no text." }
      if ($text.Length -gt $chars) { Say "$lead has $($text.Length) characters; the first $chars are:`n$($text.Substring(0, $chars))" }
      Say "$lead has $($text.Length) characters:`n$text"
    }
    'mail-draft' {
      if ($script:TestStore) { Refuse 'Drafts are not part of the test data file.' }
      $m = $script:App.CreateItem(0)
      $m.To = Arg 'to'
      $m.Subject = Arg 'subject'
      $m.Body = Arg 'body'
      # Saved, never sent: there is no Send call anywhere in this file.
      $m.Save()
      $words = @((Arg 'body') -split '\s+' | Where-Object { $_ }).Count
      try {
        $back = $script:NS.GetItemFromID($m.EntryID)
        $where = "$($back.Parent.Name)"
        $seenWords = @("$($back.Body)" -split '\s+' | Where-Object { $_ }).Count
        Say "Created a draft in Outlook and it was not sent: the $where folder now holds the subject $($back.Subject) with $seenWords word(s) in its body, so the draft is really there."
      } catch {
        Say "Created a draft in Outlook with the subject $(Arg 'subject') and $words word(s) in its body, and it was not sent, but I could not read it back from the Drafts folder yet, so I cannot prove it saved."
      }
    }
  }
}

# ---------------------------------------------------------------------------------------------
# OneNote.

$script:One = $null
function Open-OneNote {
  if (-not (Test-OneNoteInstalled)) { Fail 'ONENOTE_UNAVAILABLE' 'OneNote for Windows (the desktop app from Microsoft 365) is not installed on this PC, so I cannot reach your notes. Sticky Notes cannot be read by other programs.' }
  try { $script:One = New-OneNoteApp }
  catch { Fail 'ONENOTE_UNAVAILABLE' ('OneNote did not start, so I could not reach your notes: ' + (Clip $_.Exception.Message 200)) }
}
function Xml-Of([string]$text) {
  $doc = New-Object System.Xml.XmlDocument
  $doc.LoadXml($text)
  $ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
  $ns.AddNamespace('one', $doc.DocumentElement.NamespaceURI)
  [pscustomobject]@{ doc = $doc; ns = $ns; uri = $doc.DocumentElement.NamespaceURI }
}
# Every page outside the recycle bins, with its notebook and section, newest first.
function Pages {
  $xml = ''
  $script:One.GetHierarchy('', 4, [ref]$xml)
  $h = Xml-Of $xml
  $pages = @()
  foreach ($p in $h.doc.SelectNodes('//one:Page', $h.ns)) {
    if ($p.GetAttribute('isInRecycleBin') -eq 'true') { continue }
    $section = $p.ParentNode
    if ($section.GetAttribute('isInRecycleBin') -eq 'true' -or $section.GetAttribute('isDeletedPages') -eq 'true') { continue }
    $bin = $false; $book = ''
    for ($n = $section.ParentNode; $null -ne $n -and $n.NodeType -eq 'Element'; $n = $n.ParentNode) {
      if ($n.GetAttribute('isRecycleBin') -eq 'true') { $bin = $true }
      if ($n.LocalName -eq 'Notebook') { $book = $n.GetAttribute('name') }
    }
    if ($bin) { continue }
    $changed = [datetime]::MinValue
    [void][datetime]::TryParse($p.GetAttribute('lastModifiedTime'), $Invariant, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$changed)
    $pages += [pscustomobject]@{ id = $p.GetAttribute('ID'); name = $p.GetAttribute('name'); where = "$book > $($section.GetAttribute('name'))"; changed = $changed.ToLocalTime() }
  }
  $pages | Sort-Object changed -Descending
}
# A page's text: its title, then each paragraph, as plain text.
function Page-Text([string]$id) {
  $xml = ''
  $script:One.GetPageContent($id, [ref]$xml, 0)
  $h = Xml-Of $xml
  $lines = @()
  foreach ($t in $h.doc.SelectNodes('//one:Outline//one:T', $h.ns)) {
    $plain = [System.Net.WebUtility]::HtmlDecode(($t.InnerText -replace '<[^>]+>', ''))
    if ($plain.Trim()) { $lines += $plain.TrimEnd() }
  }
  ($lines -join "`n")
}
function One-Page([string]$name) {
  $hits = @(Pages | Where-Object { Same $_.name $name })
  if ($hits.Count -eq 0) { Say "I could not find a note called $name in OneNote." }
  if ($hits.Count -gt 1) { Say ("More than one note is called $name in OneNote, so I did not guess. Their ids: " + (($hits | ForEach-Object { $_.id }) -join ', ')) }
  $hits[0]
}
# An OE (paragraph) per line, the text escaped for OneNote's HTML-ish T element.
function Add-Lines($h, $parent, [string[]]$lines) {
  foreach ($line in $lines) {
    $oe = $h.doc.CreateElement('one', 'OE', $h.uri)
    $t = $h.doc.CreateElement('one', 'T', $h.uri)
    $escaped = [System.Net.WebUtility]::HtmlEncode($line)
    [void]$t.AppendChild($h.doc.CreateCDataSection($escaped))
    [void]$oe.AppendChild($t)
    [void]$parent.AppendChild($oe)
  }
}
function New-PageXml([string]$id) {
  $h = Xml-Of '<one:Page xmlns:one="http://schemas.microsoft.com/office/onenote/2013/onenote"/>'
  $h.doc.DocumentElement.SetAttribute('ID', $id)
  $h
}

function Run-OneNote {
  switch ($Op) {
    'notes-recent' {
      $limit = ArgInt 'limit' 20; $budget = ArgInt 'budget' 60000
      $pages = @(Pages)
      if ($pages.Count -eq 0) { Say 'There are no notes in OneNote.' }
      $blocks = @(); $used = 0; $stopped = $false
      foreach ($p in ($pages | Select-Object -First $limit)) {
        $text = Page-Text $p.id
        if ($used + $text.Length -gt $budget -and $blocks.Count -gt 0) { $stopped = $true; break }
        $used += $text.Length
        $blocks += "- name: $($p.name)`n  where: $($p.where)`n  changed: $(Stamp $p.changed)`n  text: $text"
      }
      $head = "Showing $($blocks.Count) of $($pages.Count) note(s) in OneNote, newest first"
      if ($stopped) { $head += ", stopping early because the text was getting long" }
      Say ("${head}:`n" + ($blocks -join "`n"))
    }
    'notes-read' {
      $chars = ArgInt 'chars' 4000
      $id = Arg 'id'
      $page = if ($id) { $all = @(Pages); $one = @($all | Where-Object { $_.id -eq $id }); if ($one.Count -eq 0) { Say 'I could not find a note with that id in OneNote.' }; $one[0] } else { One-Page (Arg 'name') }
      $text = Page-Text $page.id
      if ($text.Length -eq 0) { Say "The note $($page.name) is empty: it has no text." }
      if ($text.Length -gt $chars) { Say "The note $($page.name) has $($text.Length) characters; the first $chars are:`n$($text.Substring(0, $chars))" }
      Say "The note $($page.name) has $($text.Length) characters:`n$text"
    }
    'notes-find' {
      $q = Arg 'query'; $max = ArgInt 'max' 8
      $pages = @(Pages)
      $ids = @{}
      try {
        $xml = ''
        $script:One.FindPages('', $q, [ref]$xml)
        $h = Xml-Of $xml
        foreach ($p in $h.doc.SelectNodes('//one:Page', $h.ns)) { $ids[$p.GetAttribute('ID')] = $true }
      } catch {}
      $hits = @($pages | Where-Object { $ids.ContainsKey($_.id) -or (Has $_.name $q) })
      if ($hits.Count -eq 0) { Say "No note in OneNote mentions $q, after looking at $($pages.Count) note(s)." }
      $shown = @($hits | Select-Object -First $max)
      Say ("Found $($hits.Count) note(s) mentioning $q; the titles only:`n" + (($shown | ForEach-Object { "- $($_.name) ($($_.where)) [id $($_.id)]" }) -join "`n"))
    }
    'notes-create' {
      $body = Arg 'body'
      $lines = @($body -split "`r?`n")
      $first = 0
      while ($first -lt $lines.Count -and -not $lines[$first].Trim()) { $first++ }
      $title = Clip $lines[$first].Trim() 120
      $rest = @(); if ($first + 1 -lt $lines.Count) { $rest = @($lines[($first + 1)..($lines.Count - 1)]) }
      $path = ''
      try { $script:One.GetSpecialLocation(2, [ref]$path) } catch { Refuse 'OneNote has no place set for quick notes, so I did not create anything. Open OneNote once and pick a default notebook, then ask me again.' }
      $section = ''
      $script:One.OpenHierarchy($path, '', [ref]$section, 3)
      $pageId = ''
      $script:One.CreateNewPage($section, [ref]$pageId, 0)
      $h = New-PageXml $pageId
      $titleNode = $h.doc.CreateElement('one', 'Title', $h.uri)
      Add-Lines $h $titleNode @($title)
      [void]$h.doc.DocumentElement.AppendChild($titleNode)
      if (@($rest | Where-Object { $_.Trim() }).Count -gt 0) {
        $outline = $h.doc.CreateElement('one', 'Outline', $h.uri)
        $children = $h.doc.CreateElement('one', 'OEChildren', $h.uri)
        Add-Lines $h $children $rest
        [void]$outline.AppendChild($children)
        [void]$h.doc.DocumentElement.AppendChild($outline)
      }
      $script:One.UpdatePageContent($h.doc.OuterXml)
      $made = @(Pages | Where-Object { $_.id -eq $pageId })
      $where = if ($made.Count) { $made[0].where } else { 'the quick notes section' }
      Say "Wrote the note $title in $where."
    }
    'notes-append' {
      $page = One-Page (Arg 'name')
      $before = Page-Text $page.id
      $xml = ''
      $script:One.GetPageContent($page.id, [ref]$xml, 0)
      $current = Xml-Of $xml
      # A new block below everything already on the page: existing text, ink and images are never
      # sent back, so nothing on the page can be rewritten or dropped.
      $bottom = 0.0
      foreach ($o in $current.doc.SelectNodes('//one:Outline', $current.ns)) {
        $pos = $o.SelectSingleNode('one:Position', $current.ns); $size = $o.SelectSingleNode('one:Size', $current.ns)
        if ($pos -and $size) { $edge = [double]::Parse($pos.GetAttribute('y'), $Invariant) + [double]::Parse($size.GetAttribute('height'), $Invariant); if ($edge -gt $bottom) { $bottom = $edge } }
      }
      $h = New-PageXml $page.id
      $outline = $h.doc.CreateElement('one', 'Outline', $h.uri)
      $position = $h.doc.CreateElement('one', 'Position', $h.uri)
      $position.SetAttribute('x', '36.0'); $position.SetAttribute('y', ([Math]::Max(86.4, $bottom + 14.4)).ToString('0.0', $Invariant)); $position.SetAttribute('z', '0')
      [void]$outline.AppendChild($position)
      $children = $h.doc.CreateElement('one', 'OEChildren', $h.uri)
      Add-Lines $h $children @((Arg 'text') -split "`r?`n")
      [void]$outline.AppendChild($children)
      [void]$h.doc.DocumentElement.AppendChild($outline)
      $script:One.UpdatePageContent($h.doc.OuterXml)
      $after = Page-Text $page.id
      Say "Added to the note $($page.name): it now has $($after.Length) characters, up from $($before.Length)."
    }
    'notes-delete' {
      $name = Arg 'name'
      if ((Arg 'confirm') -cne $name) { Say 'Nothing was deleted: the confirmation does not match the note name.' }
      $page = One-Page $name
      $length = (Page-Text $page.id).Length
      $script:One.DeleteHierarchy($page.id)
      Say "Deleted the note $($page.name) ($length characters). OneNote keeps it in the notebook's recycle bin."
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Media.

function Player([string]$aumid) {
  $id = ($aumid -split '!')[0]
  $id = ($id -replace '_[a-z0-9]{13}$', '') -replace '\.exe$', ''
  $known = @{ 'Spotify' = 'Spotify'; 'SpotifyAB.SpotifyMusic' = 'Spotify'; 'Microsoft.ZuneMusic' = 'Media Player'; 'chrome' = 'Chrome'; 'msedge' = 'Edge'; 'firefox' = 'Firefox'; 'brave' = 'Brave' }
  if ($known.ContainsKey($id)) { $known[$id] } else { ($id -split '\.')[-1] }
}
function Playing($info) {
  $bits = @()
  if ($info.title) { $bits += "Track: $($info.title)" }
  if ($info.artist) { $bits += "artist: $($info.artist)" }
  if ($info.album) { $bits += "album: $($info.album)" }
  $what = if ($bits.Count) { $bits -join ', ' } else { 'Something with no track details' }
  "$what, in $(Player $info.app) (player state: $("$($info.status)".ToLower()))."
}
function Run-Media {
  $session = $null
  try { $session = Get-MediaSession } catch { Fail 'MEDIA_UNAVAILABLE' ('The Windows media controls did not answer: ' + (Clip $_.Exception.Message 200)) }
  if ($null -eq $session) { Say 'Nothing is playing on this PC just now.' }
  switch ($Op) {
    'media-current' { Say (Playing $session.Info()) }
    default {
      $done = switch ($Op) { 'media-toggle' { $session.Toggle() } 'media-next' { $session.Next() } 'media-previous' { $session.Previous() } }
      if (-not $done) { Say "$(Player $session.Info().app) did not accept that, so nothing changed." }
      Start-Sleep -Milliseconds 600
      Say ('Done. Now: ' + (Playing $session.Info()))
    }
  }
}

# ---------------------------------------------------------------------------------------------

try {
  switch -Regex ($Op) {
    '^eventkit$' { Open-Outlook; try { Run-EventKit } finally { Close-Outlook } }
    '^mail-(recent|find|read|draft)$' { Open-Outlook; try { Run-Mail } finally { Close-Outlook } }
    '^notes-(recent|read|find|create|append|delete)$' { Open-OneNote; Run-OneNote }
    '^media-(current|toggle|next|previous)$' { Run-Media }
    default { Fail 'INTERNAL' "Unknown operation $Op." }
  }
  Fail 'INTERNAL' "Operation $Op gave no answer."
} catch {
  Fail 'INTERNAL' (Clip $_.Exception.Message 300)
}
