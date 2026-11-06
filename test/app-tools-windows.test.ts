import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopControl } from '../src/desktop-control.js';
import { PACKS, packsFor, platformTools, platformToolByName } from '../src/app-tools/packs.js';
import { indexFor, shortlistTools } from '../src/app-tools/retrieve.js';
import { filesPack } from '../src/app-tools/windows/files.js';
import { runDevicePlan } from '../src/brain-device.js';
import type { AppToolPlan } from '../src/app-tools/types.js';

/**
 * The app tools on Windows: Outlook (calendar, tasks, mail), OneNote, files and media controls.
 *
 * Nothing here touches the owner's Outlook, OneNote or player. The catalog and seam tests use a
 * recording executor; the end-to-end tests run the real native/app-tools-windows.ps1 with
 * test/fixtures/app-tools-windows-fake.ps1 in place of COM and WinRT, and only on Windows.
 */

const HELPER = fileURLToPath(new URL('../native/app-tools-windows.ps1', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/app-tools-windows-fake.ps1', import.meta.url));
const prefs = { get: (k: string) => (k === 'mac-control-enabled' ? 'true' : undefined), set: () => {} };
const driver = { call: async () => { throw new Error('the macOS driver must not be used on Windows'); }, stop() {} };

type Call = { file: string; args: string[]; options: Record<string, unknown> };
function recording(answer: (call: Call) => Promise<{ stdout: string; stderr: string }>) {
  const calls: Call[] = [];
  const exec = async (file: string, args: string[], options: Record<string, unknown>) => { const call = { file, args, options }; calls.push(call); return answer(call); };
  const control = new DesktopControl(prefs as any, driver as any, undefined as any, 'win32', Date.now, (async () => {}) as any, exec as any);
  return { control, calls };
}
const ok = (value: unknown) => async () => ({ stdout: JSON.stringify(value), stderr: '' });
const payloadOf = (call: Call) => JSON.parse(Buffer.from(call.args.at(-1)!, 'base64').toString('utf8'));

const SAMPLES: Record<string, Record<string, string>> = {
  notes_recent: {}, notes_read: { name: 'Roof' }, notes_find: { query: 'roof' }, notes_create_note: { body: 'Buy paint' },
  notes_append: { name: 'Roof', text: 'More' }, notes_delete: { name: 'Roof', confirm: 'Roof' },
  calendar_find_events: { query: 'standup' }, calendar_read_event: { summary: 'Standup', start: '2026-11-04 09:00:00' },
  calendar_list_events: { days: '7' }, calendar_create_event: { title: 'Call', start: '2026-11-04 17:00:00', end: '2026-11-04 17:30:00' },
  calendar_update_event: { summary: 'Standup', start: '2026-11-04 09:00:00', new_start: '2026-11-04 10:00:00' },
  calendar_delete_event: { summary: 'Standup', start: '2026-11-04 09:00:00', confirm: 'Standup' },
  reminders_list: {}, reminders_open: {}, reminders_read: { name: 'milk' }, reminders_add: { title: 'milk' },
  reminders_complete: { name: 'milk', confirm: 'milk' }, reminders_update: { name: 'milk', confirm: 'milk', due: '2026-11-06' },
  reminders_delete: { name: 'milk', confirm: 'milk' },
  mail_recent: {}, mail_find: { query: 'bank' }, mail_read: { subject: 'Hi', sender: 'Bank' }, mail_draft: { to: 'a@b.example', subject: 'Hi', body: 'Hello' },
  finder_recent: {}, finder_find: { query: 'invoice' },
  music_current: {}, music_play_pause: {}, music_next: {}, music_previous: {},
};

test('the Windows catalog offers only what Windows can run, and macOS keeps its own', () => {
  const names = platformTools('win32').map(tool => tool.name);
  assert.equal(names.some(name => /^(safari|messages)_/.test(name)), false, 'Safari and Messages have no Windows counterpart');
  assert.equal(names.includes('notes_update'), false, 'a OneNote page rewrite would drop ink and images, so it is not offered');
  assert.deepEqual([...names].sort(), Object.keys(SAMPLES).sort());
  assert.equal(packsFor('darwin'), PACKS, 'macOS is unchanged');
  assert.deepEqual(platformTools('linux'), []);
  for (const tool of platformTools('win32')) {
    const plan = tool.plan(SAMPLES[tool.name]) as AppToolPlan;
    assert.ok(['windows', 'local', 'text'].includes(plan.kind), `${tool.name} plans ${plan.kind}, which Windows cannot run`);
    const text = [tool.description, ...tool.args.map(arg => arg.description)].join(' ');
    assert.doesNotMatch(text, /\bApple\b|\bmacOS\b|\bMac\b|AppleScript|Finder/, `${tool.name} still talks about the Mac`);
    assert.equal(platformToolByName(tool.name, 'darwin')?.plan === tool.plan, false);
  }
  for (const pack of packsFor('win32')) assert.doesNotMatch(pack.summary, /Apple|Mac/);
});

test('retrieval on Windows ranks the Windows tools', async () => {
  const index = indexFor('win32');
  const pick = async (text: string) => (await shortlistTools(text, { index }))[0]?.tool.name;
  assert.equal(await pick('what is on my calendar this week'), 'calendar_list_events');
  assert.equal(await pick('summarise my mail'), 'mail_recent');
  assert.equal(await pick('write a note that the roof is leaking'), 'notes_create_note');
  assert.equal(await pick('what did i download recently'), 'finder_recent');
  assert.equal(index.tools.some(tool => tool.pack === 'safari'), false);
});

test('app_tools on Windows lists the Windows catalog; app_tool runs a Windows tool by name', async () => {
  const { control, calls } = recording(ok({ ok: true, data: [] }));
  const listed = await control.run('s', { action: 'app_tools', text: 'what is on my calendar' });
  assert.deepEqual(listed.tools.map((tool: any) => tool.name), platformTools('win32').map(tool => tool.name));
  assert.equal(listed.tools.find((tool: any) => tool.name === 'calendar_list_events').app, 'Outlook');
  await assert.rejects(control.run('s', { action: 'app_tool', tool: 'safari_tabs', args: {} }), /APP_TOOL_UNKNOWN/);
  const out = await control.run('s', { action: 'app_tool', tool: 'calendar_list_events', args: { days: '1' } });
  assert.equal(out.ok, true);
  assert.equal(out.output, 'There is nothing on your calendar in that window.');
  assert.equal(calls.length, 1);
});

test('a Windows tool runs the bundled helper hidden, with owner text only inside base64 JSON', async () => {
  const { control, calls } = recording(ok({ ok: true, text: 'Created a draft in Outlook and it was not sent.' }));
  const result = await control.packTool('s', 'mail_draft', { to: 'pat@plumbing.example', subject: 'Boiler; rm -rf "x"', body: 'Tuesday works.' });
  assert.equal(result.output, 'Created a draft in Outlook and it was not sent.');
  const [call] = calls;
  assert.match(call.file, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.args[call.args.indexOf('-File') + 1], HELPER);
  assert.equal(call.args.at(-2), 'mail-draft');
  assert.deepEqual(payloadOf(call), { to: 'pat@plumbing.example', subject: 'Boiler; rm -rf "x"', body: 'Tuesday works.' });
  assert.equal(call.args.some(arg => arg.includes('Boiler')), false);
});

test('calendar and reminders send the EventKit argument array and reuse the macOS formatters', async () => {
  const event = { id: 'X', title: 'Dentist', startDate: '2026-11-09 15:00:00', endDate: '2026-11-09 16:00:00', calendar: 'Calendar', isAllDay: false, location: 'Clinic' };
  const { control, calls } = recording(ok({ ok: true, data: [event] }));
  const out = await control.packTool('s', 'calendar_find_events', { query: 'dentist', start: '2026-11-04', end: '2026-11-11' });
  assert.deepEqual(payloadOf(calls[0]), { argv: ['events', '--from', '2026-11-04', '--to', '2026-11-11', '--limit', '300'] });
  assert.match(out.output, /1 event\(s\) match "dentist"/);
  assert.match(out.output, /- Dentist in Calendar from 2026-11-09 15:00:00 to 2026-11-09 16:00:00 at Clinic/);
  await control.packTool('s', 'reminders_add', { title: 'Buy milk', due: '2026-11-07 09:00:00' });
  assert.deepEqual(payloadOf(calls[1]), { argv: ['reminder-create', '--title', 'Buy milk', '--due', '2026-11-07 09:00:00'] });
});

test('a refusal decided by the pack starts no process; a bad date is an argument error', async () => {
  const { control, calls } = recording(ok({ ok: true, data: [] }));
  const out = await control.packTool('s', 'calendar_delete_event', { summary: 'Standup', start: '2026-11-04 09:00:00', confirm: 'standup' });
  assert.match(out.output, /To delete "Standup" I need the confirm argument to say exactly "Standup"/);
  await assert.rejects(control.packTool('s', 'calendar_create_event', { title: 'X', start: 'tomorrow', end: '2026-11-05 10:00:00' }), /APP_TOOL_ARGUMENT_INVALID/);
  const notes = await control.packTool('s', 'notes_delete', { name: 'Roof', confirm: 'roof' });
  assert.match(notes.output, /Nothing was deleted/);
  assert.equal(calls.length, 0);
});

test('the helper\'s own sentences reach the owner; a hang is reported as a hang', async () => {
  const sentence = 'Outlook on this PC has no email account set up yet. Open Outlook, add your account, then ask me again.';
  const { control } = recording(ok({ ok: false, error: `OUTLOOK_NO_ACCOUNT: ${sentence}` }));
  await assert.rejects(control.packTool('s', 'mail_recent', {}), new RegExp(`APP_TOOL_REFUSED: ${sentence.slice(0, 40)}`));
  const outcome = await runDevicePlan(control as any, { action: 'app_tool', tool: 'mail_recent', app: 'Outlook', args: {} } as any, 's', () => {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.line, sentence);
  const internal = recording(ok({ ok: false, error: 'INTERNAL: Exception from HRESULT: 0x80004005' })).control;
  await assert.rejects(internal.packTool('s', 'mail_recent', {}), /APP_TOOL_FAILED: mail_recent did not run/);
  const slow = recording(async () => { throw Object.assign(new Error('Command failed'), { killed: true, stdout: '' }); }).control;
  await assert.rejects(slow.packTool('s', 'music_current', {}), /APP_TOOL_FAILED: music_current did not run: Media did not answer in time/);
  const garbled = recording(async () => ({ stdout: 'not json', stderr: '' })).control;
  await assert.rejects(garbled.packTool('s', 'music_current', {}), /unreadable answer/);
});

test('app tools on Windows keep the Settings switch and the one-action-at-a-time rule; Linux has none yet', async () => {
  const off = new DesktopControl({ get: () => undefined, set: () => {} } as any, driver as any, undefined as any, 'win32', Date.now, (async () => {}) as any, (async () => { throw new Error('must not run'); }) as any);
  await assert.rejects(off.packTool('s', 'music_current', {}), /MAC_CONTROL_DISABLED/);
  await assert.rejects(off.packTool('s', 'mail_read', { subject: 'x' }), /APP_TOOL_ARGUMENT_MISSING: mail_read needs sender/);
  const linux = new DesktopControl(prefs as any, driver as any, undefined as any, 'linux');
  await assert.rejects(linux.packTool('s', 'notes_recent', {}), /DESKTOP_MACOS_ONLY/);
  assert.deepEqual((await linux.run('s', { action: 'app_tools' })).tools, []);
});

test('files: newest first, by name, known folders and honest refusals, without touching the real profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ffd-files-'));
  try {
    const downloads = join(root, 'Downloads');
    mkdirSync(downloads);
    const files = ['invoice-march.pdf', 'Invoice-april.pdf', 'photo.jpg'];
    files.forEach((name, i) => { const path = join(downloads, name); writeFileSync(path, 'x'); const t = new Date(Date.UTC(2026, 10, 1 + i)); utimesSync(path, t, t); });
    mkdirSync(join(downloads, 'Old stuff'));
    utimesSync(join(downloads, 'Old stuff'), new Date(Date.UTC(2020, 0, 1)), new Date(Date.UTC(2020, 0, 1)));
    writeFileSync(join(downloads, 'desktop.ini'), 'x');
    const pack = filesPack(async name => (name === 'downloads' ? downloads : undefined));
    const run = async (name: string, args: Record<string, string>) => {
      const plan = pack.tools.find(tool => tool.name === name)!.plan(args);
      return plan.kind === 'local' ? plan.run(new AbortController().signal) : plan.kind === 'text' ? plan.text : '';
    };
    const recent = await run('finder_recent', {});
    assert.match(recent, /^Showing 4 of 4 item\(s\) in the downloads folder, most recently changed first:/);
    const lines = recent.split('\n').slice(1);
    assert.match(lines[0], /^photo\.jpg - JPG file - /);
    assert.match(lines[3], /^Old stuff - Folder - 2020-01-01/);
    assert.equal(recent.includes('desktop.ini'), false);
    const found = await run('finder_find', { query: 'invoice' });
    assert.match(found, /^Found 2 item\(s\) in the downloads folder whose name contains invoice:\nInvoice-april\.pdf/);
    assert.match(await run('finder_find', { query: 'zzz' }), /No item in the downloads folder has a name containing zzz, after looking at 4 item\(s\)/);
    assert.match(await run('finder_recent', { folder: join(root, 'missing') }), /does not exist on this PC/);
    assert.match(await run('finder_recent', { folder: '\\\\server\\share' }), /I do not read network folders/);
    assert.match(await run('finder_recent', { folder: 'Pictures' }), /not one I read by name/);
    assert.match(await run('finder_recent', { limit: 'lots' }), /whole number/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- end to end on Windows: the real helper over fake COM objects -----------------------------

const onWindows = process.platform === 'win32';

function withFakes(scenario = '') {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-app-tools-'));
  const log = join(dir, 'writes.log');
  const env = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: process.env.PATH ?? '', TEMP: dir, TMP: dir, LOCALAPPDATA: dir, APPDATA: dir, USERPROFILE: dir, FFD_FAKE_LOG: log, FFD_FAKE_SCENARIO: scenario, PSModulePath: '' };
  const exec = (file: string, args: string[], options: any) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, [...args, '-Fake', FAKE], { ...options, env, encoding: 'utf8' }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
  });
  const control = new DesktopControl(prefs as any, driver as any, undefined as any, 'win32', Date.now, (async () => {}) as any, exec as any);
  const writes = () => (existsSync(log) ? readFileSync(log, 'utf8').replace(/^\uFEFF/, '') : '');
  return { control, writes, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('Outlook calendar end to end over fake COM', { skip: !onWindows, timeout: 120000 }, async () => {
  const h = withFakes();
  try {
    const week = (await h.control.packTool('s', 'calendar_list_events', { days: '7' })).output;
    assert.match(week, /^6 event\(s\):/);
    assert.match(week, /- Standup in Calendar \(Personal\)/);
    assert.match(week, /- Standup in Calendar \(Work\)/);
    assert.match(week, /- Team sync .* with 2 other people and it does not repeat/);
    assert.match(week, /- Gym .* and it repeats/);
    assert.equal(week.includes('Old review'), false);
    const read = (await h.control.packTool('s', 'calendar_read_event', { summary: 'dentist', start: `${day(3)} 15:00:00` })).output;
    assert.match(read, /at Main Street clinic/);
    assert.match(read, /Notes: Bring the referral letter\./);
    await assert.rejects(h.control.packTool('s', 'calendar_update_event', { summary: 'Team sync', start: `${day(1)} 10:00:00`, new_start: `${day(1)} 12:00:00` }), /APP_TOOL_REFUSED: Other people are on that event, so I did not change it/);
    await assert.rejects(h.control.packTool('s', 'calendar_delete_event', { summary: 'Gym', start: `${day(2)} 18:00:00`, confirm: 'Gym' }), /APP_TOOL_REFUSED: That event repeats, so I did not delete it/);
    await assert.rejects(h.control.packTool('s', 'calendar_read_event', { summary: 'Nothing', start: `${day(1)} 09:00:00` }), /There is no event called "Nothing" at that time/);
    const moved = (await h.control.packTool('s', 'calendar_update_event', { summary: 'Dentist', start: `${day(3)} 15:00:00`, new_start: `${day(3)} 16:30:00` })).output;
    assert.match(moved, /Calendar says it changed this event:\n- Dentist .* from \S+ 16:30:00 to \S+ 17:30:00/);
    const made = (await h.control.packTool('s', 'calendar_create_event', { title: 'Call the plumber', start: `${day(1)} 17:00:00`, end: `${day(1)} 17:30:00`, calendar: 'Family' })).output;
    assert.match(made, /Calendar says it added this event:\n- Call the plumber in Family/);
    const gone = (await h.control.packTool('s', 'calendar_delete_event', { summary: 'Standup', start: `${day(0)} 09:00:00`, confirm: 'Standup' })).output;
    assert.match(gone, /deleted this event:\n- Standup in Calendar \(Personal\)/);
    const writes = h.writes();
    assert.match(writes, new RegExp(`save event Dentist \\| ${day(3)} 16:30:00 \\| ${day(3)} 17:30:00`));
    assert.match(writes, /add 1 to Family/);
    assert.match(writes, /save event Call the plumber .* in Family/);
    assert.match(writes, /delete event Standup/);
    assert.doesNotMatch(writes, /Team sync|Gym/);
  } finally { h.done(); }
});

test('Outlook tasks and mail end to end over fake COM; a draft is never sent', { skip: !onWindows, timeout: 120000 }, async () => {
  const h = withFakes();
  try {
    const open = (await h.control.packTool('s', 'reminders_open', {})).output;
    assert.match(open, /^3 reminder\(s\):\n- Buy milk in Tasks due \S+ 00:00:00 and still open/);
    assert.equal(open.includes('Pay rent'), false);
    const lists = (await h.control.packTool('s', 'reminders_list', {})).output;
    assert.match(lists, /- Tasks\n- Shopping/);
    const added = (await h.control.packTool('s', 'reminders_add', { title: 'Renew passport', list: 'Shopping', due: `${day(5)} 09:00:00` })).output;
    assert.match(added, /Reminders says it added this reminder:\n- Renew passport in Shopping due \S+ 00:00:00/);
    const done = (await h.control.packTool('s', 'reminders_complete', { name: 'buy milk', confirm: 'buy milk' })).output;
    assert.match(done, /- Buy milk in Tasks .* and already done/);
    await h.control.packTool('s', 'reminders_update', { name: 'Call plumber', confirm: 'Call plumber', priority: '1' });
    assert.match(h.writes(), /save task Call plumber .* importance 2/);
    const recent = (await h.control.packTool('s', 'mail_recent', { limit: '2' })).output;
    assert.match(recent, /^Showing 2 newest message\(s\) in Inbox/);
    assert.match(recent, /- from: Bank Alerts <alerts@bank\.example>\n  subject: Statement ready\n  text: The statement/);
    assert.match(recent, /\[cut off here: the message continues\]/);
    const found = (await h.control.packTool('s', 'mail_find', { query: 'receipt', mailbox: 'Receipts' })).output;
    assert.match(found, /Found 1 message\(s\) with receipt .*\n- from: Shop <orders@shop\.example> \| subject: Your receipt/);
    assert.match((await h.control.packTool('s', 'mail_find', { query: 'x', mailbox: 'Nowhere' })).output, /could not find a mail folder called Nowhere/);
    const read = (await h.control.packTool('s', 'mail_read', { subject: 'boiler visit', sender: 'pat' })).output;
    assert.match(read, /The message Boiler visit from Pat Plumber <pat@plumbing\.example> has 28 characters:\nI can come on Tuesday at 10\./);
    const draft = (await h.control.packTool('s', 'mail_draft', { to: 'pat@plumbing.example', subject: 'Re: Boiler', body: 'Tuesday at ten works for me.' })).output;
    assert.match(draft, /Created a draft in Outlook and it was not sent: the Drafts folder now holds the subject Re: Boiler with 6 word\(s\)/);
    const writes = h.writes();
    assert.match(writes, /save mail to pat@plumbing\.example \| Re: Boiler \| in Drafts/);
    assert.doesNotMatch(writes, /SEND CALLED/);
  } finally { h.done(); }
});

test('OneNote end to end over fake COM: pages, a safe append and escaped text', { skip: !onWindows, timeout: 120000 }, async () => {
  const h = withFakes();
  try {
    const recent = (await h.control.packTool('s', 'notes_recent', { limit: '2' })).output;
    assert.match(recent, /^Showing 2 of 4 note\(s\) in OneNote, newest first:\n- name: Shopping/);
    assert.equal(recent.includes('Deleted page'), false, 'pages in the recycle bin are not notes');
    const roof = (await h.control.packTool('s', 'notes_read', { name: 'roof' })).output;
    assert.match(roof, /Call the builder & ask for a quote <soon>\./);
    assert.match((await h.control.packTool('s', 'notes_read', { name: 'Ideas' })).output, /More than one note is called Ideas/);
    assert.match((await h.control.packTool('s', 'notes_find', { query: 'plumber' })).output, /Found 1 note\(s\) mentioning plumber.*\n- Ideas \(Work notes > Work\)/);
    const made = (await h.control.packTool('s', 'notes_create_note', { body: 'Paint <blue> & white\nsecond line' })).output;
    assert.match(made, /Wrote the note Paint <blue> & white in Personal > Quick Notes\./);
    await h.control.packTool('s', 'notes_append', { name: 'Roof', text: 'Builder starts Tuesday' });
    const deleted = (await h.control.packTool('s', 'notes_delete', { name: 'Shopping', confirm: 'Shopping' })).output;
    assert.match(deleted, /Deleted the note Shopping \(10 characters\)\. OneNote keeps it in the notebook's recycle bin\./);
    const writes = h.writes();
    assert.match(writes, /<one:T><!\[CDATA\[Paint &lt;blue&gt; &amp; white\]\]><\/one:T>/);
    const append = writes.split(/\r?\n/).find(line => line.startsWith('update') && line.includes('Builder starts Tuesday'))!;
    assert.match(append, /<one:Position x="36\.0" y="140\.8" z="0"/, 'the new block goes below the existing one');
    assert.doesNotMatch(append, /The roof is leaking/, 'existing text is never sent back');
    assert.match(writes, /delete page P2/);
  } finally { h.done(); }
});

test('media controls end to end over a fake session', { skip: !onWindows, timeout: 60000 }, async () => {
  const h = withFakes();
  try {
    assert.equal((await h.control.packTool('s', 'music_current', {})).output, 'Track: Song 1, artist: The Examples, album: Fixtures, in Spotify (player state: playing).');
    assert.match((await h.control.packTool('s', 'music_play_pause', {})).output, /^Done\. Now: .*player state: paused/);
    assert.match((await h.control.packTool('s', 'music_next', {})).output, /Track: Song 2/);
    assert.match(h.writes(), /media toggle/);
  } finally { h.done(); }
  const quiet = withFakes('no-media');
  try { assert.equal((await quiet.control.packTool('s', 'music_current', {})).output, 'Nothing is playing on this PC just now.'); } finally { quiet.done(); }
});

test('missing Outlook, no account and missing OneNote are said plainly', { skip: !onWindows, timeout: 120000 }, async () => {
  for (const [scenario, tool, args, said] of [
    ['no-account', 'mail_recent', {}, /APP_TOOL_REFUSED: Outlook on this PC has no email account set up yet\. Open Outlook, add your account/],
    ['no-profile', 'calendar_list_events', {}, /APP_TOOL_REFUSED: Outlook on this PC has no email account set up yet/],
    ['outlook-missing', 'reminders_open', {}, /APP_TOOL_REFUSED: Classic Outlook is not installed on this PC/],
    ['onenote-missing', 'notes_recent', {}, /APP_TOOL_REFUSED: OneNote for Windows .* is not installed on this PC.*Sticky Notes cannot be read by other programs/],
  ] as const) {
    const h = withFakes(scenario);
    try { await assert.rejects(h.control.packTool('s', tool, args as Record<string, string>), said); } finally { h.done(); }
  }
});

test('the helper script is plain ASCII for Windows PowerShell 5.1', () => {
  for (const file of [HELPER, FAKE]) assert.equal(/[^\x00-\x7f]/.test(readFileSync(file, 'latin1')), false, file);
  assert.doesNotMatch(readFileSync(HELPER, 'utf8'), /\.Send\(/, 'nothing in the helper ever sends mail');
});

test('tool ranking on Windows: a trigram stand-in for the Mac embedding helper, for the app in front only', async () => {
  const { embedExtras, embedDocs, lexicalRank } = await import('../src/app-tools/embed.js');
  const { windowsToolApp } = await import('../src/app-tools/windows/plans.js');
  const tools = platformTools('win32');
  const docs = embedDocs(tools);
  assert.equal(lexicalRank('whats playng', docs, 1)[0]?.id, 'music_current');
  assert.equal(lexicalRank('wat did i writ about the roof', docs, 1)[0]?.id, 'notes_read');
  assert.deepEqual(lexicalRank('refactor the parser', docs), [], 'a coding request resembles no tool');
  assert.deepEqual(await embedExtras('whats playng', tools, { app: 'Media', platform: 'win32' }), ['music_current']);
  assert.deepEqual(await embedExtras('whats playng', tools, { app: 'Outlook', platform: 'win32' }), [], 'only the app in front');
  assert.deepEqual(await embedExtras('whats playng', tools, { platform: 'win32' }), []);
  const shortlist = await shortlistTools('whats playng', { index: indexFor('win32'), app: 'Media' });
  assert.deepEqual(shortlist.map(entry => [entry.tool.name, entry.via]), [['music_current', 'embedding']]);
  assert.equal(windowsToolApp('Microsoft Outlook', 'OUTLOOK'), 'Outlook');
  assert.equal(windowsToolApp('OneNote for Microsoft 365', 'ONENOTE'), 'OneNote');
  assert.equal(windowsToolApp('Windows Explorer', 'explorer'), 'File Explorer');
  assert.equal(windowsToolApp('Spotify', 'Spotify'), 'Media');
  assert.equal(windowsToolApp('Comet', 'comet'), 'Comet');
});
