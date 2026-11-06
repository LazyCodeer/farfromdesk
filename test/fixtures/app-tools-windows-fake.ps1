# Fake Outlook, OneNote and media controls for test/app-tools-windows.test.ts.
#
# Dot-sourced by native/app-tools-windows.ps1 when a test passes -Fake. It replaces the COM and
# WinRT entry points with small objects holding made-up data, so the real script logic runs on any
# Windows machine without touching the owner's Outlook, OneNote or player. Every write is appended
# to the file named by FFD_FAKE_LOG so a test can see exactly what would have been saved.
# FFD_FAKE_SCENARIO picks a failure: outlook-missing, no-profile, no-account, onenote-missing,
# no-media.

$FakeScenario = "$env:FFD_FAKE_SCENARIO"
function Fake-Log([string]$line) { if ($env:FFD_FAKE_LOG) { Add-Content -LiteralPath $env:FFD_FAKE_LOG -Value $line -Encoding UTF8 } }

function Test-OutlookInstalled { $FakeScenario -ne 'outlook-missing' }
function Test-OutlookProfile { $FakeScenario -ne 'no-profile' }
function Test-OneNoteInstalled { $FakeScenario -ne 'onenote-missing' }

$script:FakeIds = 0
function Fake-Id { $script:FakeIds++; "ID$($script:FakeIds)" }

function New-FakeItems($folder) {
  $o = [pscustomobject]@{ List = (New-Object System.Collections.ArrayList); Pos = 0; IncludeRecurrences = $false; Folder = $folder }
  $o | Add-Member ScriptMethod GetFirst { $this.Pos = 0; $this.GetNext() }
  $o | Add-Member ScriptMethod GetNext { if ($this.Pos -ge $this.List.Count) { return $null }; $x = $this.List[$this.Pos]; $this.Pos = $this.Pos + 1; $x }
  $o | Add-Member ScriptMethod Sort { param($p, $d) Fake-Log "sort $p" }
  $o | Add-Member ScriptMethod Restrict { param($f) Fake-Log "restrict $f"; $copy = New-FakeItems $this.Folder; foreach ($x in $this.List) { [void]$copy.List.Add($x) }; $copy }
  $o | Add-Member ScriptMethod Add { param($t) $item = if ([int]$t -eq 3) { New-FakeTask $this.Folder 'new' $null $false } else { New-FakeEvent $this.Folder 'new' (Get-Date) (Get-Date) }; Fake-Log "add $t to $($this.Folder.Name)"; $item }
  $o
}
function New-FakeFolder([string]$name, [int]$type) {
  $f = [pscustomobject]@{ Name = $name; DefaultItemType = $type; Folders = (New-Object System.Collections.ArrayList); Items = $null; EntryID = (Fake-Id); FolderPath = "\\$name" }
  $f.Items = New-FakeItems $f
  $f
}
function New-FakeEvent($folder, [string]$subject, [datetime]$start, [datetime]$end) {
  $e = [pscustomobject]@{ Subject = $subject; Start = $start; End = $end; Location = ''; Body = ''; AllDayEvent = $false; IsRecurring = $false; MeetingStatus = 0; Recipients = @(); EntryID = (Fake-Id); Parent = $folder; Class = 26 }
  $e | Add-Member ScriptMethod Save { if (-not $this.Parent.Items.List.Contains($this)) { [void]$this.Parent.Items.List.Add($this) }; Fake-Log "save event $($this.Subject) | $($this.Start.ToString('yyyy-MM-dd HH:mm:ss')) | $($this.End.ToString('yyyy-MM-dd HH:mm:ss')) | $($this.Location) | in $($this.Parent.Name)" }
  $e | Add-Member ScriptMethod Delete { $this.Parent.Items.List.Remove($this); Fake-Log "delete event $($this.Subject)" }
  $e
}
function New-FakeTask($folder, [string]$subject, $due, [bool]$complete) {
  $t = [pscustomobject]@{ Subject = $subject; DueDate = $(if ($due) { [datetime]$due } else { [datetime]'4501-01-01' }); StartDate = [datetime]'4501-01-01'; Complete = $complete; DateCompleted = [datetime]'4501-01-01'; Importance = 1; Body = ''; EntryID = (Fake-Id); Parent = $folder; Class = 48 }
  $t | Add-Member ScriptMethod Save { if (-not $this.Parent.Items.List.Contains($this)) { [void]$this.Parent.Items.List.Add($this) }; Fake-Log "save task $($this.Subject) | due $($this.DueDate.ToString('yyyy-MM-dd')) | complete $($this.Complete) | importance $($this.Importance) | in $($this.Parent.Name)" }
  $t | Add-Member ScriptMethod MarkComplete { $this.Complete = $true; $this.DateCompleted = (Get-Date) }
  $t | Add-Member ScriptMethod Delete { $this.Parent.Items.List.Remove($this); Fake-Log "delete task $($this.Subject)" }
  $t
}
function New-FakeMail($folder, [string]$from, [string]$address, [string]$subject, [string]$body, [datetime]$when) {
  $m = [pscustomobject]@{ SenderName = $from; SenderEmailAddress = $address; SenderEmailType = 'SMTP'; Subject = $subject; Body = $body; ReceivedTime = $when; To = ''; EntryID = (Fake-Id); Parent = $folder; Class = 43 }
  $m | Add-Member ScriptMethod Save { if (-not $this.Parent.Items.List.Contains($this)) { [void]$this.Parent.Items.List.Add($this) }; Fake-Log "save mail to $($this.To) | $($this.Subject) | in $($this.Parent.Name)" }
  $m | Add-Member ScriptMethod Send { Fake-Log 'SEND CALLED' }
  $m
}
function New-FakeStore([string]$display) {
  $s = [pscustomobject]@{ DisplayName = $display; FilePath = ''; Defaults = @{}; Root = (New-FakeFolder "Top of $display" 0) }
  $s | Add-Member ScriptMethod GetDefaultFolder { param($k) if ($this.Defaults.ContainsKey([int]$k)) { $this.Defaults[[int]$k] } else { throw 'no such folder' } }
  $s | Add-Member ScriptMethod GetRootFolder { $this.Root }
  $s
}

function New-OutlookApp {
  $today = (Get-Date).Date
  $personal = New-FakeStore 'Personal'
  $cal = New-FakeFolder 'Calendar' 1
  $family = New-FakeFolder 'Family' 1
  [void]$cal.Folders.Add($family)
  $tasks = New-FakeFolder 'Tasks' 3
  $shopping = New-FakeFolder 'Shopping' 3
  [void]$tasks.Folders.Add($shopping)
  $inbox = New-FakeFolder 'Inbox' 0
  $drafts = New-FakeFolder 'Drafts' 0
  $receipts = New-FakeFolder 'Receipts' 0
  foreach ($f in $inbox, $drafts, $receipts, $cal, $tasks) { [void]$personal.Root.Folders.Add($f) }
  $personal.Defaults[9] = $cal; $personal.Defaults[13] = $tasks; $personal.Defaults[6] = $inbox; $personal.Defaults[16] = $drafts

  $standup = New-FakeEvent $cal 'Standup' $today.AddHours(9) $today.AddHours(9.25)
  $sync = New-FakeEvent $cal 'Team sync' $today.AddDays(1).AddHours(10) $today.AddDays(1).AddHours(11)
  $sync.MeetingStatus = 1
  $sync.Recipients = @([pscustomobject]@{ Name = 'Alex Example'; MeetingResponseStatus = 3 }, [pscustomobject]@{ Name = 'Sam Example'; MeetingResponseStatus = 0 })
  $gym = New-FakeEvent $cal 'Gym' $today.AddDays(2).AddHours(18) $today.AddDays(2).AddHours(19)
  $gym.IsRecurring = $true
  $old = New-FakeEvent $cal 'Old review' $today.AddDays(-40).AddHours(9) $today.AddDays(-40).AddHours(10)
  $dentist = New-FakeEvent $cal 'Dentist' $today.AddDays(3).AddHours(15) $today.AddDays(3).AddHours(16)
  $dentist.Location = 'Main Street clinic'; $dentist.Body = 'Bring the referral letter.'
  foreach ($e in $standup, $sync, $gym, $old, $dentist) { [void]$cal.Items.List.Add($e) }
  [void]$family.Items.List.Add((New-FakeEvent $family 'Dinner' $today.AddDays(2).AddHours(19) $today.AddDays(2).AddHours(21)))

  foreach ($t in (New-FakeTask $tasks 'Buy milk' $today.AddDays(1) $false), (New-FakeTask $tasks 'Pay rent' $today $true), (New-FakeTask $tasks 'Call plumber' $null $false)) { [void]$tasks.Items.List.Add($t) }
  [void]$shopping.Items.List.Add((New-FakeTask $shopping 'Batteries' $null $false))

  $long = ('The statement for your account is ready to view. ' * 20).Trim()
  foreach ($m in (New-FakeMail $inbox 'Bank Alerts' 'alerts@bank.example' 'Statement ready' $long $today.AddHours(-1)), (New-FakeMail $inbox 'Pat Plumber' 'pat@plumbing.example' 'Boiler visit' 'I can come on Tuesday at 10.' $today.AddHours(-3)), (New-FakeMail $inbox 'News Weekly' 'news@weekly.example' 'This week' 'Headlines.' $today.AddDays(-1))) { [void]$inbox.Items.List.Add($m) }
  [void]$receipts.Items.List.Add((New-FakeMail $receipts 'Shop' 'orders@shop.example' 'Your receipt' 'Total 12.00' $today.AddDays(-2)))

  $work = New-FakeStore 'Work'
  $workCal = New-FakeFolder 'Calendar' 1
  $work.Defaults[9] = $workCal
  [void]$workCal.Items.List.Add((New-FakeEvent $workCal 'Standup' $today.AddDays(1).AddHours(9) $today.AddDays(1).AddHours(9.25)))

  $ns = [pscustomobject]@{ Accounts = [pscustomobject]@{ Count = $(if ($FakeScenario -eq 'no-account') { 0 } else { 2 }) }; Stores = @($personal, $work); Drafts = $drafts; Personal = $personal }
  $ns | Add-Member ScriptMethod GetDefaultFolder { param($k) $this.Personal.GetDefaultFolder($k) }
  $ns | Add-Member ScriptMethod GetItemFromID { param($id) foreach ($x in $this.Drafts.Items.List) { if ($x.EntryID -eq $id) { return $x } }; throw 'not found' }
  $app = [pscustomobject]@{ NS = $ns }
  $app | Add-Member ScriptMethod GetNamespace { param($n) $this.NS }
  $app | Add-Member ScriptMethod CreateItem { param($t) Fake-Log "create item $t"; New-FakeMail $this.NS.Drafts '' '' '' '' (Get-Date) }
  $app
}

$script:FakePages = [ordered]@{
  'P1' = @{ name = 'Roof'; section = 'Home'; book = 'Personal'; changed = '2026-11-01T10:00:00.000Z'; body = @('The roof is leaking near the chimney.', 'Call the builder & ask for a quote <soon>.') }
  'P2' = @{ name = 'Shopping'; section = 'Home'; book = 'Personal'; changed = '2026-11-03T10:00:00.000Z'; body = @('Milk', 'Bread') }
  'P3' = @{ name = 'Ideas'; section = 'Work'; book = 'Work notes'; changed = '2026-10-20T10:00:00.000Z'; body = @('A plumber directory.') }
  'P4' = @{ name = 'Ideas'; section = 'Archive'; book = 'Work notes'; changed = '2026-09-20T10:00:00.000Z'; body = @('Old ideas.') }
}
$script:FakeBin = @{ 'P9' = @{ name = 'Deleted page'; body = @('gone') } }
$OneUri = 'http://schemas.microsoft.com/office/onenote/2013/onenote'
function Fake-Esc([string]$s) { [System.Security.SecurityElement]::Escape($s) }
function Fake-Hierarchy {
  $books = [ordered]@{}
  foreach ($id in $script:FakePages.Keys) { $p = $script:FakePages[$id]; if (-not $books.Contains($p.book)) { $books[$p.book] = [ordered]@{} }; if (-not $books[$p.book].Contains($p.section)) { $books[$p.book][$p.section] = @() }; $books[$p.book][$p.section] += $id }
  $x = "<one:Notebooks xmlns:one=`"$OneUri`">"
  foreach ($b in $books.Keys) {
    $x += "<one:Notebook name=`"$(Fake-Esc $b)`" ID=`"NB-$(Fake-Esc $b)`">"
    foreach ($s in $books[$b].Keys) {
      $x += "<one:Section name=`"$(Fake-Esc $s)`" ID=`"S-$(Fake-Esc $s)`">"
      foreach ($id in $books[$b][$s]) { $p = $script:FakePages[$id]; $x += "<one:Page ID=`"$id`" name=`"$(Fake-Esc $p.name)`" lastModifiedTime=`"$($p.changed)`"/>" }
      $x += '</one:Section>'
    }
    if ($b -eq 'Personal') { $x += '<one:SectionGroup name="OneNote_RecycleBin" isRecycleBin="true"><one:Section name="Deleted Pages" isDeletedPages="true" isInRecycleBin="true"><one:Page ID="P9" name="Deleted page" lastModifiedTime="2026-11-05T10:00:00.000Z" isInRecycleBin="true"/></one:Section></one:SectionGroup>' }
    $x += '</one:Notebook>'
  }
  $x + '</one:Notebooks>'
}
function New-OneNoteApp {
  $one = [pscustomobject]@{ Next = 100 }
  $one | Add-Member ScriptMethod GetHierarchy { param($start, $scope, [ref]$xml) $xml.Value = Fake-Hierarchy }
  $one | Add-Member ScriptMethod GetPageContent { param($id, [ref]$xml, $info)
    $p = $script:FakePages[$id]; if (-not $p) { throw 'no page' }
    $outline = ($p.body | ForEach-Object { "<one:OE><one:T><![CDATA[$([System.Net.WebUtility]::HtmlEncode($_))]]></one:T></one:OE>" }) -join ''
    $xml.Value = "<one:Page xmlns:one=`"$OneUri`" ID=`"$id`" name=`"$(Fake-Esc $p.name)`"><one:Title><one:OE><one:T><![CDATA[$(Fake-Esc $p.name)]]></one:T></one:OE></one:Title><one:Outline><one:Position x=`"36.0`" y=`"86.4`" z=`"0`"/><one:Size width=`"300.0`" height=`"40.0`"/><one:OEChildren>$outline</one:OEChildren></one:Outline></one:Page>" }
  $one | Add-Member ScriptMethod FindPages { param($start, $q, [ref]$xml)
    $hits = @($script:FakePages.Keys | Where-Object { ($script:FakePages[$_].body -join ' ').IndexOf($q, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    $xml.Value = "<one:Notebooks xmlns:one=`"$OneUri`">" + (($hits | ForEach-Object { "<one:Page ID=`"$_`" name=`"x`"/>" }) -join '') + '</one:Notebooks>' }
  $one | Add-Member ScriptMethod GetSpecialLocation { param($kind, [ref]$path) $path.Value = 'C:\Fake\Personal\Quick Notes.one' }
  $one | Add-Member ScriptMethod OpenHierarchy { param($path, $rel, [ref]$id, $create) Fake-Log "open hierarchy $path create $create"; $id.Value = 'S-Quick Notes' }
  $one | Add-Member ScriptMethod CreateNewPage { param($section, [ref]$id, $style) $new = "P$($this.Next)"; $this.Next = $this.Next + 1; $script:FakePages[$new] = @{ name = 'Untitled'; section = 'Quick Notes'; book = 'Personal'; changed = '2026-11-06T10:00:00.000Z'; body = @() }; Fake-Log "create page $new in $section"; $id.Value = $new }
  $one | Add-Member ScriptMethod UpdatePageContent { param($xml)
    Fake-Log "update $xml"
    $doc = [xml]$xml; $ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable); $ns.AddNamespace('one', $OneUri)
    $id = $doc.DocumentElement.GetAttribute('ID'); $p = $script:FakePages[$id]
    $title = $doc.SelectSingleNode('//one:Title//one:T', $ns); if ($title) { $p.name = [System.Net.WebUtility]::HtmlDecode($title.InnerText) }
    foreach ($t in $doc.SelectNodes('//one:Outline//one:T', $ns)) { $p.body += [System.Net.WebUtility]::HtmlDecode($t.InnerText) } }
  $one | Add-Member ScriptMethod DeleteHierarchy { param($id) Fake-Log "delete page $id"; $script:FakePages.Remove($id) }
  $one
}

function Get-MediaSession {
  if ($FakeScenario -eq 'no-media') { return $null }
  $s = [pscustomobject]@{ Status = 'Playing'; Track = 1 }
  $s | Add-Member ScriptMethod Info { [ordered]@{ title = "Song $($this.Track)"; artist = 'The Examples'; album = 'Fixtures'; app = 'Spotify.exe'; status = $this.Status } }
  $s | Add-Member ScriptMethod Toggle { Fake-Log 'media toggle'; $this.Status = $(if ($this.Status -eq 'Playing') { 'Paused' } else { 'Playing' }); $true }
  $s | Add-Member ScriptMethod Next { Fake-Log 'media next'; $this.Track = $this.Track + 1; $true }
  $s | Add-Member ScriptMethod Previous { Fake-Log 'media previous'; $this.Track = [Math]::Max(1, $this.Track - 1); $true }
  $s
}
