import test from 'node:test';
import assert from 'node:assert/strict';
import {absoluteOwnerPath, openOwnerFile, ownerFolderList, ownerFolderPath, resolveWindowsApp, windowsAppKey, windowsExeNames, windowsOpenCommand, type OpenRunner} from '../src/open-file.js';
import {brainPrompt} from '../src/meta-model.js';

type Call = {file: string; args: string[]; options: Parameters<OpenRunner>[2]};
function runner(answer: unknown | Error) {
  const calls: Call[] = [];
  const run: OpenRunner = async (file, args, options) => {
    calls.push({file, args, options});
    if (answer instanceof Error) throw answer;
    return {stdout: JSON.stringify(answer)};
  };
  return {calls, run};
}

test('macOS still opens through /usr/bin/open with the same replies', async () => {
  const ok = runner({});
  assert.equal(await openOwnerFile('/Users/o/Downloads/rows.csv', 'Numbers', {platform: 'darwin', run: ok.run}), 'Opened rows.csv in Numbers. Read the window to check it.');
  assert.equal(ok.calls[0].file, '/usr/bin/open');
  assert.deepEqual(ok.calls[0].args, ['-a', 'Numbers', '/Users/o/Downloads/rows.csv']);
  const failed = runner(new Error('exit 1'));
  assert.equal(await openOwnerFile('/Users/o/Downloads/rows.csv', 'Numbers', {platform: 'darwin', run: failed.run}), 'Numbers could not open rows.csv. Is Numbers installed?');
  assert.equal(await openOwnerFile('/Users/o/Downloads/rows.csv', undefined, {platform: 'darwin', run: failed.run}), 'rows.csv could not be opened.');
});

test('Windows opens through a hidden PowerShell, with the path in the environment and never via cmd', async () => {
  const file = 'C:\\Users\\o\\Downloads\\a "b" & c.csv';
  const ok = runner({ok: true, exe: 'C:\\Program Files\\Microsoft Office\\EXCEL.EXE'});
  assert.equal(await openOwnerFile(file, 'Excel', {platform: 'win32', run: ok.run}), 'Opened a "b" & c.csv in Excel. Read the window to check it.');
  const call = ok.calls[0];
  assert.match(call.file, /powershell\.exe$/i);
  assert.equal(call.options.windowsHide, true);
  assert.ok(!call.args.some(a => a.includes('Downloads')), 'the path must not be part of the command line');
  assert.equal(call.options.env.FFD_OPEN_PATH, file);
  assert.equal(call.options.env.FFD_OPEN_APP, 'Excel');
  assert.equal(call.options.env.FFD_OPEN_EXES, 'excel.exe');
  assert.ok(call.args.includes('-EncodedCommand'));
  const script = Buffer.from(call.args[call.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.match(script, /App Paths/);
  assert.match(script, /UseShellExecute = \$true/);
  assert.ok(/^[\x00-\x7f]*$/.test(script), 'the script stays ASCII for Windows PowerShell 5.1');

  const plain = runner({ok: true});
  assert.equal(await openOwnerFile(file, undefined, {platform: 'win32', run: plain.run}), 'Opened a "b" & c.csv. Read the window to check it.');
  assert.equal(plain.calls[0].options.env.FFD_OPEN_APP, '');
});

test('Windows says plainly why a file did not open', async () => {
  const file = 'C:\\Users\\o\\Documents\\rows.csv';
  const missing = runner({ok: false, error: 'APP_NOT_FOUND'});
  assert.match(await openOwnerFile(file, 'LibreOffice', {platform: 'win32', run: missing.run}), /^LibreOffice is not installed on this PC, so rows\.csv was not opened\./);
  const store = runner({ok: false, error: 'STORE_APP', name: 'Clipchamp'});
  assert.match(await openOwnerFile(file, 'clipchamp', {platform: 'win32', run: store.run}), /^Clipchamp is a Microsoft Store app/);
  const noApp = runner({ok: false, error: 'OPEN_FAILED', detail: 'No application is associated with the specified file for this operation'});
  assert.equal(await openOwnerFile(file, undefined, {platform: 'win32', run: noApp.run}), 'No app on this PC is set to open rows.csv. Name an app to open it in.');
  const broken = runner(new Error('timeout'));
  assert.equal(await openOwnerFile(file, 'Excel', {platform: 'win32', run: broken.run}), 'Excel could not open rows.csv.');
  // A Mac app name is answered without starting anything.
  const mac = runner({ok: true});
  assert.match(await openOwnerFile(file, 'Numbers', {platform: 'win32', run: mac.run}), /^Numbers is a Mac app and this is a Windows PC\. Use Excel instead/);
  assert.equal(mac.calls.length, 0);
});

test('app names map to the executables Windows registers', () => {
  assert.deepEqual(windowsExeNames('Microsoft Word'), ['winword.exe', 'word.exe']);
  assert.deepEqual(windowsExeNames('PowerPoint'), ['powerpnt.exe', 'powerpoint.exe']);
  assert.deepEqual(windowsExeNames('Google Chrome'), ['chrome.exe']);
  assert.deepEqual(windowsExeNames('Visual Studio Code'), ['code.exe', 'visualstudiocode.exe']);
  assert.deepEqual(windowsExeNames('notepad.exe'), ['notepad.exe']);
  assert.deepEqual(windowsExeNames('a&b|c'), [], 'no shell characters ever reach a lookup');
  assert.equal(windowsAppKey('  Microsoft   Edge '), 'edge');
  assert.equal(windowsOpenCommand('x', 'Edge').env.FFD_OPEN_KEY, 'edge');
});

test('owner folders resolve Windows paths and refuse anything outside them', () => {
  const home = 'C:\\Users\\o';
  assert.equal(ownerFolderPath('rows.csv', 'Downloads', home, 'win32'), 'C:\\Users\\o\\Downloads\\rows.csv');
  assert.equal(ownerFolderPath('Documents\\plan.txt', 'Downloads', home, 'win32'), 'C:\\Users\\o\\Documents\\plan.txt');
  assert.equal(ownerFolderPath('documents/plan.txt', 'Downloads', home, 'win32'), 'C:\\Users\\o\\documents\\plan.txt');
  assert.equal(ownerFolderPath('~\\Videos\\clip.mp4', 'Downloads', home, 'win32'), 'C:\\Users\\o\\Videos\\clip.mp4');
  assert.equal(ownerFolderPath('c:/users/o/desktop/a.pdf', 'Downloads', home, 'win32'), 'c:\\users\\o\\desktop\\a.pdf');
  assert.equal(ownerFolderPath('C:\\Users\\o\\.ssh\\id', 'Downloads', home, 'win32'), undefined);
  assert.equal(ownerFolderPath('C:\\Users\\o\\Downloads\\..\\.ssh\\id', 'Downloads', home, 'win32'), undefined);
  assert.equal(ownerFolderPath('C:\\Users\\o\\Downloads\\.hidden\\a.txt', 'Downloads', home, 'win32'), undefined);
  assert.equal(ownerFolderPath('C:\\Windows\\win.ini', 'Downloads', home, 'win32'), undefined);
  assert.equal(absoluteOwnerPath('C:\\x', 'win32'), true);
  assert.equal(ownerFolderList('win32'), 'Downloads, Desktop, Documents, Pictures, Videos or Music');
  // macOS is unchanged.
  assert.equal(ownerFolderList('darwin'), 'Downloads, Desktop, Documents, Pictures, Movies or Music');
  assert.equal(ownerFolderPath('Movies/a.mov', 'Downloads', '/Users/o', 'darwin'), '/Users/o/Movies/a.mov');
  assert.equal(ownerFolderPath('~/.ssh/id', 'Downloads', '/Users/o', 'darwin'), undefined);
  assert.equal(ownerFolderPath('C:\\x', 'Downloads', '/Users/o', 'darwin'), '/Users/o/Downloads/C:\\x');
});

test('the brain prompt talks about the PC on Windows and stays as it was on macOS', () => {
  const win = brainPrompt('win32'), mac = brainPrompt('darwin');
  for (const word of [/\bMac\b/, /Finder/, /Safari/, /Numbers/, /Comet/, /System Settings/, /keychain/, /Apple Reminders/]) assert.doesNotMatch(win, word);
  assert.match(win, /apps running on the PC right now/);
  assert.match(win, /open it in Excel with open_file/);
  assert.match(win, /Never target Windows Settings, Credential Manager or password apps/);
  assert.match(mac, /apps running on the Mac right now/);
  assert.match(mac, /open it in Numbers with open_file/);
  assert.match(mac, /Never target System Settings, keychain or password apps/);
  assert.match(mac, /Mac apps \(Notes, Calendar, Reminders, Mail, Finder, Safari, Music, Messages\)/);
});

// Opt-in and read-only: resolves which program a name maps to, opens nothing.
test('live: resolves installed apps on this PC without opening anything', {skip: process.platform !== 'win32' || process.env.FFD_LIVE_DESKTOP !== '1'}, async () => {
  const notepad = await resolveWindowsApp('Notepad');
  assert.equal(notepad.ok, true);
  assert.match(notepad.exe ?? '', /notepad\.exe$/i);
  assert.deepEqual(await resolveWindowsApp('No Such App FFD Test'), {ok: false, error: 'APP_NOT_FOUND'});
});
