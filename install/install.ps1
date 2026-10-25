# FarFromDesk per-user Windows desktop installer. Run with PowerShell 5.1+.
[CmdletBinding()]
param([string]$Version = '0.7.1', [string]$ReleaseBase = '', [switch]$NoLaunch, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($Version -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid release version.' }
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'This release supports Windows x64. Native ARM64 packaging is pending.' }
if (-not $ReleaseBase) { $ReleaseBase = "https://github.com/LazyCodeer/farfromdesk/releases/download/v$Version" }
if (([Uri]$ReleaseBase).Scheme -ne 'https') { throw 'Release base must use HTTPS.' }
$asset = "FarFromDesk-$Version-windows-x64.zip"
if ($DryRun) { Write-Output "$ReleaseBase/$asset"; return }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('farfromdesk-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $archive = Join-Path $temp $asset
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/$asset" -OutFile $archive
    Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/$asset.sha256" -OutFile (Join-Path $temp 'checksum')
  } catch { throw 'Release download failed. It may be unpublished or be temporarily unavailable. No app was installed.' }
  $expected = ((Get-Content -LiteralPath (Join-Path $temp 'checksum') -Raw).Trim() -split '\s+')[0]
  if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash -ne $expected) { throw 'Checksum verification failed. Installation stopped.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try { foreach ($entry in $zip.Entries) { if ($entry.FullName -match '(^[/\\]|(^|[/\\])\.\.([/\\]|$)|:)') { throw 'Unsafe archive path.' } } } finally { $zip.Dispose() }
  $unpack = Join-Path $temp 'unpack'
  Expand-Archive -LiteralPath $archive -DestinationPath $unpack
  $source = Join-Path $unpack 'FarFromDesk'
  if (-not (Test-Path -LiteralPath (Join-Path $source 'farfromdesk.exe') -PathType Leaf)) { throw 'Invalid desktop bundle.' }
  $root = Join-Path $env:LOCALAPPDATA 'Programs\FarFromDesk'
  $target = Join-Path $root $Version
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  if (Test-Path -LiteralPath $target) { throw 'This version is already installed. Open FarFromDesk from Start.' }
  Move-Item -LiteralPath $source -Destination $target
  $exe = Join-Path $target 'farfromdesk.exe'
  $linkPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'FarFromDesk.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($linkPath)
  $shortcut.TargetPath = $exe; $shortcut.WorkingDirectory = $target; $shortcut.Description = 'FarFromDesk — your work, within reach'; $shortcut.Save()
  Write-Output "Installed FarFromDesk at $target. Open it from Start to pair WhatsApp."
  if (-not $NoLaunch) { Start-Process -FilePath $exe }
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
