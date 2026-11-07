# Installs or removes the FarFromDesk Screen Helper service. Runs elevated, once, when the owner
# turns "Unlock from your phone" on or off in Settings > Remote control (src/screen-service.ts).
#
# The service runs as LocalSystem, so its program must not stay in a folder the user can write
# (%LOCALAPPDATA%): it is copied into Program Files, and the copy's SHA-256 must match the hash
# this FarFromDesk build recorded. It is registered for exactly one account SID.
param(
  [string]$Source = '',
  [string]$Sha256 = '',
  [string]$UserSid = '',
  [string]$Result = '',
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$name = 'FarFromDeskScreen'
$dir = Join-Path $env:ProgramFiles 'FarFromDesk Screen Helper'
$exe = Join-Path $dir 'ffd-screen-service.exe'
$sc = Join-Path $env:SystemRoot 'System32\sc.exe'

function Finish([hashtable]$value) {
  if ($Result) { [IO.File]::WriteAllText($Result, ($value | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) }
  if ($value.ok) { exit 0 } else { exit 1 }
}
function Exists { [bool](Get-Service -Name $name -ErrorAction SilentlyContinue) }
function Remove-Service {
  if (Exists) {
    & $sc stop $name | Out-Null
    for ($i = 0; $i -lt 50 -and (Get-Service -Name $name).Status -ne 'Stopped'; $i++) { Start-Sleep -Milliseconds 100 }
    & $sc delete $name | Out-Null
    for ($i = 0; $i -lt 50 -and (Exists); $i++) { Start-Sleep -Milliseconds 100 }
  }
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
}

try {
  $admin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) { Finish @{ ok = $false; error = 'NOT_ELEVATED' } }
  if ($Uninstall) { Remove-Service; Finish @{ ok = $true; installed = $false } }

  if ($Sha256 -notmatch '^[0-9a-fA-F]{64}$') { Finish @{ ok = $false; error = 'BAD_HASH' } }
  $sid = New-Object Security.Principal.SecurityIdentifier($UserSid)
  if (-not $sid.IsAccountSid()) { Finish @{ ok = $false; error = 'BAD_USER' } }
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { Finish @{ ok = $false; error = 'SOURCE_MISSING' } }

  Remove-Service
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Copy-Item -LiteralPath $Source -Destination $exe -Force
  # Checked after the copy, on the file Windows will run, not on the user-writable original.
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash -ne $Sha256.ToUpperInvariant()) {
    Remove-Item -Recurse -Force $dir
    Finish @{ ok = $false; error = 'HASH_MISMATCH' }
  }
  $bin = '"' + $exe + '" service --user ' + $sid.Value
  & $sc create $name binPath= $bin start= auto DisplayName= 'FarFromDesk Screen Helper' | Out-Null
  if ($LASTEXITCODE -ne 0) { Finish @{ ok = $false; error = 'CREATE_FAILED' } }
  & $sc description $name 'Lets the FarFromDesk owner see and unlock this PC''s lock screen from their phone. Turn it off in FarFromDesk: Settings > Remote control.' | Out-Null
  & $sc failure $name reset= 86400 actions= restart/5000/restart/5000// | Out-Null
  & $sc start $name | Out-Null
  for ($i = 0; $i -lt 50 -and (Get-Service -Name $name).Status -ne 'Running'; $i++) { Start-Sleep -Milliseconds 100 }
  Finish @{ ok = ((Get-Service -Name $name).Status -eq 'Running'); installed = $true; error = $(if ((Get-Service -Name $name).Status -eq 'Running') { $null } else { 'START_FAILED' }) }
} catch {
  Finish @{ ok = $false; error = 'INSTALL_FAILED'; detail = $_.Exception.Message }
}
