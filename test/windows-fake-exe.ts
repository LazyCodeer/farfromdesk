import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// A real Windows program for tests of code that refuses scripts: it reads
// fake.txt beside itself and runs each KEY=VALUE step in order (values expand
// %VARIABLES%). Built once per test process with the .NET compiler that ships
// with Windows, so no tool from the PC is ever run in its place.
const source=String.raw`using System; using System.IO; using System.Text; using System.Threading; using System.Diagnostics;
public static class FakeTool {
  public static int Main(string[] args) {
    string self = Process.GetCurrentProcess().MainModule.FileName;
    if (args.Length == 3 && args[0] == "--orphan") { Thread.Sleep(int.Parse(args[1])); File.WriteAllText(args[2], "late"); return 0; }
    string conf = Path.Combine(Path.GetDirectoryName(self), "fake.txt");
    if (!File.Exists(conf)) return 0;
    int exit = 0;
    foreach (string raw in File.ReadAllLines(conf)) {
      int i = raw.IndexOf('='); if (i < 0) continue;
      string k = raw.Substring(0, i), v = Environment.ExpandEnvironmentVariables(raw.Substring(i + 1));
      if (k == "touch") File.WriteAllText(v, "x");
      else if (k == "log") {
        StringBuilder b = new StringBuilder();
        foreach (string n in new string[] { "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "GH_TOKEN", "PATH", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "UV_NO_CONFIG" }) b.Append(n).Append('=').Append(Environment.GetEnvironmentVariable(n) ?? "").Append('\n');
        b.Append("CWD=").Append(Environment.CurrentDirectory).Append('\n');
        b.Append("ARGS=").Append(string.Join(" ", args)).Append('\n');
        File.WriteAllText(v, b.ToString());
      }
      else if (k == "sleep") Thread.Sleep(int.Parse(v));
      else if (k == "orphan") { string[] p = v.Split('|'); ProcessStartInfo s = new ProcessStartInfo(self, "--orphan " + p[0] + " \"" + p[1] + "\""); s.UseShellExecute = false; s.CreateNoWindow = true; Process.Start(s); }
      else if (k == "install") File.Copy(self, Path.Combine(Environment.GetEnvironmentVariable("UV_TOOL_BIN_DIR"), "agent-reach.exe"));
      else if (k == "partial") File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("UV_TOOL_BIN_DIR"), "agent-reach.exe"), "partial");
      else if (k == "stdout") { Stream o = Console.OpenStandardOutput(); byte[] d = File.ReadAllBytes(v); o.Write(d, 0, d.Length); o.Flush(); }
      else if (k == "zeros") { Stream o = Console.OpenStandardOutput(); byte[] d = new byte[int.Parse(v)]; o.Write(d, 0, d.Length); o.Flush(); }
      else if (k == "exit") exit = int.Parse(v);
    }
    return exit;
  }
}`;

let built:string|undefined;
function build(){
  if(built)return built;
  const dir=mkdtempSync(join(tmpdir(),'ffd-fake-exe-')),out=join(dir,'fake.exe');
  writeFileSync(join(dir,'fake.cs'),source);
  const script=`Add-Type -TypeDefinition ([IO.File]::ReadAllText('${join(dir,'fake.cs')}')) -OutputAssembly '${out}' -OutputType ConsoleApplication`;
  execFileSync(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{stdio:'ignore',windowsHide:true});
  return built=out;
}

/** A fresh folder holding NAME.exe (a copy of the fake program) and its steps. */
export function fakeWindowsProgram(name:string,steps:string[]){
  const dir=mkdtempSync(join(tmpdir(),'ffd-fake-')),file=join(dir,`${name}.exe`);
  mkdirSync(dir,{recursive:true});copyFileSync(build(),file);writeFileSync(join(dir,'fake.txt'),steps.join('\r\n'));
  return {dir,file};
}
