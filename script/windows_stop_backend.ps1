# Stops only this installation's background service before Setup replaces its files.
# Asks it to shut down first; force-stops only processes running this folder's node.exe.
param([Parameter(Mandatory=$true)][string]$App)
$ErrorActionPreference = 'Stop'
$node = [IO.Path]::GetFullPath((Join-Path $App 'backend\runtime\node.exe'))
function Ours { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $node) }) }
if ((Ours).Count -eq 0) { exit 0 }
try {
  $state = if ($env:WSB_STATE_DIR) { $env:WSB_STATE_DIR } else { Join-Path $env:LOCALAPPDATA 'FarFromDesk' }
  $port = if ($env:WSB_PORT) { $env:WSB_PORT } else { '47831' }
  $token = (Get-Content -Raw (Join-Path $state 'admin-token')).Trim()
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/shutdown" -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
} catch {}
for ($i = 0; $i -lt 30 -and (Ours).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }
Ours | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
if ((Ours).Count -gt 0) { exit 1 }
exit 0
