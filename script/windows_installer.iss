; Per-user installer. Account data lives outside {app} and survives uninstall.
[Setup]
AppId={{DF168D57-418A-4924-B435-BF904833EF76}
AppName=FarFromDesk
AppVersion={#AppVersion}
AppPublisher=Codecy Labs
AppPublisherURL=https://ffd.codecylabs.com
DefaultDirName={localappdata}\Programs\FarFromDesk
DefaultGroupName=FarFromDesk
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=FarFromDesk-{#AppVersion}-windows-x64-setup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\farfromdesk.exe
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "windows_stop_backend.ps1"; Flags: dontcopy

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Icons]
Name: "{group}\FarFromDesk"; Filename: "{app}\farfromdesk.exe"
Name: "{autodesktop}\FarFromDesk"; Filename: "{app}\farfromdesk.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\farfromdesk.exe"; Description: "Open FarFromDesk"; Flags: nowait postinstall skipifsilent

[Code]
// Background forwarding keeps node.exe running after the window closes, and
// Restart Manager cannot close a windowless process. Stop only our own copy.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  ExtractTemporaryFile('windows_stop_backend.ps1');
  if Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{tmp}\windows_stop_backend.ps1') + '" -App "' + ExpandConstant('{app}') + '"',
      '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code <> 0) then
    Result := 'FarFromDesk is still running in the background. Quit it from the system tray, then run Setup again.';
end;
