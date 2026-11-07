import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hookEntryText, hookStateDir, hookTroubleLine, installProviderHooks, isBridgeHookCommand, providerHookCommand, providerHookEntry, providerHookState} from '../src/provider-hooks.js';

const dirs: string[] = [];
test.after(() => { for (const dir of dirs) rmSync(dir, {recursive: true, force: true}); });
function temp(prefix: string) { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; }

/** A stand-in for cli.js: records what a real hook run would see. */
function probe(dir: string) {
  const file = join(dir, 'cli.js');
  writeFileSync(file, `const fs=require('fs');let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>fs.writeFileSync(${JSON.stringify(join(dir, 'seen.json'))},JSON.stringify({argv:process.argv.slice(2),state:process.env.WSB_STATE_DIR,port:process.env.WSB_PORT,stdin:d})));`);
  return file;
}
function run(file: string, args: string[], input: string, verbatim = false) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(file, args, {stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, windowsVerbatimArguments: verbatim});
    let err = ''; child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(code) : reject(new Error(`exit ${code}: ${err}`)));
    child.stdin.end(input, 'utf8');
  });
}
const input = JSON.stringify({hook_event_name: 'PermissionRequest', prompt: 'café ü 你好'});

test('macOS and Linux keep the POSIX command word for word', () => {
  const o = {node: '/usr/local/bin/node', cli: "/Apps/Far From Desk/cli.js", stateDir: "/Users/o/It's here", port: 47831, provider: 'claude' as const};
  assert.deepEqual(providerHookEntry(o, 'darwin'), {command: "WSB_STATE_DIR='/Users/o/It'\\''s here' WSB_PORT=47831 '/usr/local/bin/node' '/Apps/Far From Desk/cli.js' hook claude"});
  assert.equal(providerHookCommand(o, 'linux'), providerHookEntry(o, 'darwin').command);
  assert.equal(hookStateDir(providerHookCommand(o, 'darwin')), "/Users/o/It's here");
});

test('the Windows forms are recognised as bridge hooks and name their state', () => {
  const o = {node: 'C:\\Program Files\\FarFromDesk\\node.exe', cli: 'C:\\Program Files\\FarFromDesk\\dist\\cli.js', stateDir: 'C:\\Users\\o\\AppData\\Local\\FarFromDesk', port: 47831};
  const codex = providerHookEntry({...o, provider: 'codex'}, 'win32');
  assert.equal(codex.args, undefined);
  assert.equal(codex.command, 'set "WSB_STATE_DIR=C:\\Users\\o\\AppData\\Local\\FarFromDesk"&& set "WSB_PORT=47831"&& "C:\\Program Files\\FarFromDesk\\node.exe" "C:\\Program Files\\FarFromDesk\\dist\\cli.js" hook codex');
  const claude = providerHookEntry({...o, provider: 'claude'}, 'win32');
  assert.equal(claude.command, o.node);
  assert.deepEqual(claude.args?.slice(-2), ['hook', 'claude']);
  for (const entry of [codex, claude]) {
    assert.ok(isBridgeHookCommand(hookEntryText(entry)));
    assert.equal(hookStateDir(hookEntryText(entry)), o.stateDir);
  }
  // The POSIX form an older build wrote on Windows: the backslash before cli.js hid it, so every
  // start appended another copy.
  const legacy = "WSB_STATE_DIR='C:\\Users\\o\\AppData\\Local\\FarFromDesk' WSB_PORT=47831 'C:\\x\\node.exe' 'C:\\x\\dist\\cli.js' hook codex";
  assert.ok(isBridgeHookCommand(legacy));
  assert.equal(hookStateDir(legacy), 'C:\\Users\\o\\AppData\\Local\\FarFromDesk');
  assert.ok(!isBridgeHookCommand('node other-tool.js hook codex'));
  assert.throws(() => providerHookEntry({...o, stateDir: 'C:\\100%done', provider: 'codex'}, 'win32'), /cmd\.exe cannot carry/);
});

test('the trouble line names the PC on Windows', () => {
  const line = hookTroubleLine([{provider: 'codex', file: 'x', state: 'unavailable', detail: 'why'}]);
  assert.match(line ?? '', process.platform === 'win32' ? /on this PC yet/ : process.platform === 'darwin' ? /on this Mac yet/ : /on this computer yet/);
});

test('Codex runs the Windows command through cmd /C exactly as its hook runner does', {skip: process.platform !== 'win32'}, async () => {
  const dir = temp('ffd-hook-codex-'), cli = probe(dir), state = join(dir, 'st ate & more');
  const {command} = providerHookEntry({node: process.execPath, cli, stateDir: state, port: 48013, provider: 'codex'}, 'win32');
  // codex-rs: Command::new(%COMSPEC%).arg("/C").raw_arg(format!("\"{command_line}\"")).
  await run(process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe', ['/C', `"${command}"`], input, true);
  const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
  assert.deepEqual(seen, {argv: ['hook', 'codex'], state, port: '48013', stdin: input});
});

test('Claude Code runs the Windows exec form with stdin attached', {skip: process.platform !== 'win32'}, async () => {
  const dir = temp('ffd-hook-claude-'), cli = probe(dir), state = join(dir, "it's \"quoted\" state");
  const entry = providerHookEntry({node: process.execPath, cli, stateDir: state, port: 48014, provider: 'claude'}, 'win32');
  await run(entry.command, entry.args!, input);
  const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
  assert.deepEqual(seen, {argv: ['hook', 'claude'], state, port: '48014', stdin: input});
});

test('installing on Windows replaces the old POSIX hooks in place and keeps other tools', () => {
  const home = temp('ffd-hook-install-'), stateDir = 'C:\\FarFromDesk-test-state', o = {node: 'C:\\b\\node.exe', cli: 'C:\\b\\dist\\cli.js', stateDir, port: 47831, home, env: {} as NodeJS.ProcessEnv, platform: 'win32' as const};
  mkdirSync(join(home, '.codex'), {recursive: true});
  const legacy = `WSB_STATE_DIR='${stateDir}' WSB_PORT=47831 'C:\\b\\node.exe' 'C:\\b\\dist\\cli.js' hook codex`;
  const other = {hooks: [{type: 'command', command: 'other-tool --notify'}]};
  writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify({hooks: {Stop: [other, {hooks: [{type: 'command', command: legacy}]}, {hooks: [{type: 'command', command: legacy}]}], PermissionRequest: [{hooks: [{type: 'command', command: legacy}]}]}}));
  assert.equal(installProviderHooks({...o, provider: 'codex'}).state, 'repaired');
  const codex = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
  for (const event of ['Stop', 'PermissionRequest']) {
    const bridge = codex.hooks[event].flatMap((g: any) => g.hooks).filter((h: any) => isBridgeHookCommand(hookEntryText(h)));
    assert.equal(bridge.length, 1, `${event} keeps exactly one bridge hook`);
    assert.match(bridge[0].command, /^set "WSB_STATE_DIR=/);
  }
  assert.deepEqual(codex.hooks.Stop[0], other);
  assert.equal(providerHookState({...o, provider: 'codex'}).state, 'current');

  assert.equal(installProviderHooks({...o, provider: 'claude'}).state, 'installed');
  const claude = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  const handler = claude.hooks.PermissionRequest[0].hooks[0];
  assert.equal(handler.command, 'C:\\b\\node.exe');
  assert.equal(handler.args[0], '-e');
  assert.equal(handler.timeout, 920);
  assert.equal(providerHookState({...o, provider: 'claude'}).state, 'current');
  assert.equal(installProviderHooks({...o, provider: 'claude'}).state, 'current');
  // Another install's hook is reported, not taken over.
  assert.equal(providerHookState({...o, stateDir: 'C:\\other-state', provider: 'claude'}).state, 'owned-by-other');
});
