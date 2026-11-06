import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsBrowserHelper, windowsBrowserNative, windowsDesktopBrowser, type BrowserHelper } from '../src/browser-windows.js';
import { BrowserTabs } from '../src/browser-tabs.js';
import { DesktopControl } from '../src/desktop-control.js';
import { deviceRefusal } from '../src/brain-device.js';
import { browserToolText } from '../src/meta-model.js';

// Runs on every OS: the Windows browser path is driven through fakes that answer like
// native/browser-windows.ps1. The last test drives a real browser the test launches itself.

const TABS = {
  ok: true,
  windows: [{ window_id: '100', pid: 7, browser: 'chrome', active_tab_id: 't1', bounds: { x: 0, y: 0, width: 800, height: 600 }, tabs: [
    { tab_id: 't1', title: 'Hackathon details', url: 'https://example.org/hackathon?private=x', active: true },
    { tab_id: 't2', title: 'Hackathon schedule', url: '', active: false },
    { tab_id: 't3', title: 'Settings', url: 'chrome://settings', active: false },
  ] }],
};
function fakeHelper(calls: { action: string; args: any }[] = [], overrides: Record<string, (args: any) => any> = {}): BrowserHelper {
  return async (action, args = {}) => {
    calls.push({ action, args });
    if (overrides[action]) return overrides[action](args);
    if (action === 'inventory') return { ok: true, browsers: [{ id: 'chrome', name: 'Google Chrome', pid: 7, supported: true }, { id: 'firefox', name: 'Firefox', pid: 9, supported: false }] };
    if (action === 'tabs') return structuredClone(TABS);
    if (action === 'focus') return { ok: true, window_id: args.window_id, tab_id: args.tab_id, title: 'Hackathon schedule', url: args.tab_id === 't2' ? 'https://example.org/schedule' : 'https://example.org/hackathon?private=x' };
    if (action === 'read') return { ok: true, url: 'https://example.org/schedule', title: 'Hackathon schedule', text: 'Day one. Day two.', truncated: false, links: [{ id: '0', label: 'Venue', href: 'https://example.org/venue', x: 1, y: 2 }], viewport: { width: 800, height: 500 }, screenshot: args.screenshot ? { pngBase64: 'iVBORw0KGgo=', mimeType: 'image/png', width: 800, height: 600 } : null };
    if (action === 'close') return { ok: true, closed: true, tab_id: args.tab_id };
    if (action === 'open') return { ok: true, window_id: '100', tab_id: 't9', title: 'New', url: args.url };
    if (action === 'scroll') return { ok: true, scrolled: true };
    if (action === 'follow') return { ok: true, navigationRequested: true };
    throw new Error('BROWSER_ACTION_UNSUPPORTED: ?');
  };
}
function prefs(enabled = true) { const m = new Map([['mac-control-enabled', String(enabled)]]); return { get: (k: string) => m.get(k), set: (k: string, v: string) => { m.set(k, v); } }; }
const noDriver = { call: async () => { throw new Error('the macOS driver must not run here'); }, stop() {} } as any;
function windowsControl(helper: BrowserHelper, enabled = true) {
  return new DesktopControl(prefs(enabled), noDriver, windowsDesktopBrowser(helper), 'win32', Date.now, async () => {});
}

test('the helper runs the bundled script hidden, with the action and a base64 JSON payload, and names refusals', async () => {
  const seen: any[] = [];
  const helper = windowsBrowserHelper(async (file, args, options) => {
    seen.push({ file, args, options });
    return JSON.stringify(args.at(-2) === 'close' ? { ok: false, error: 'BROWSER_TAB_GONE: That tab is no longer open. List the tabs again.' } : { ok: true, windows: [] });
  });
  await helper('tabs', { browser: 'chrome', note: 'quote " and \\ survive' });
  const { file, args, options } = seen[0];
  assert.match(file, /powershell\.exe$/i);
  assert.equal(options.windowsHide, true);
  assert.match(args[args.indexOf('-File') + 1], /browser-windows\.ps1$/);
  assert.equal(args.at(-2), 'tabs');
  assert.deepEqual(JSON.parse(Buffer.from(args.at(-1), 'base64').toString()), { browser: 'chrome', note: 'quote " and \\ survive' });
  await assert.rejects(helper('close', {}), err => deviceRefusal(err) === 'That tab is no longer open. List the tabs again.');
  const broken = windowsBrowserHelper(async () => { throw Object.assign(new Error('x'), { killed: true }); });
  await assert.rejects(broken('tabs'), /^Error: BROWSER_TIMEOUT/);
  const garbled = windowsBrowserHelper(async () => 'not json');
  await assert.rejects(garbled('tabs'), /BROWSER_HELPER_FAILED/);
});

test('the Windows script only reads and uses UI Automation patterns: no keys, no pointer, ASCII only', () => {
  const source = readFileSync(new URL('../native/browser-windows.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /SendKeys|SetCursorPos|mouse_event|SendInput|keybd_event/);
  assert.ok(/^[\x00-\x7f]*$/.test(source), 'Windows PowerShell 5.1 reads BOM-less scripts as ANSI');
  // An address handed to the browser can never be read as one of its switches.
  assert.match(source, /@\('--', \$url\)/);
});

test('coordinator browser tool on Windows: background tabs list with url null and gain their address once selected', async () => {
  const calls: any[] = [];
  const tabs = new BrowserTabs(windowsBrowserNative(fakeHelper(calls)), 'win32', Date.now, () => true);
  const found = await tabs.run('owner:a', { action: 'discover', query: 'hackathon' }) as any;
  assert.equal(found.matches, 2);
  assert.deepEqual(found.browsers[0].tabs.map((t: any) => t.url), ['https://example.org/hackathon', null]);
  assert.equal(found.browsers[1].supported, false);
  assert.match(found.evidence, /url null until selected/);
  assert.doesNotMatch(JSON.stringify(found), /chrome:\/\/settings|private=x/);
  const ref = found.browsers[0].tabs[1].tabRef;
  const chosen = await tabs.run('owner:a', { action: 'select', tabRef: ref }) as any;
  assert.equal(chosen.url, 'https://example.org/schedule');
  assert.equal(calls.at(-1).args.foreground, true);
  const page = await tabs.run('owner:a', { action: 'read', tabRef: ref }) as any;
  assert.equal(page.text, 'Day one. Day two.');
  assert.equal(calls.at(-1).args.visible_only, true);
  await tabs.run('owner:a', { action: 'follow', tabRef: ref, snapshotId: page.snapshotId, linkId: '0' });
  assert.deepEqual(calls.at(-1), { action: 'follow', args: { browser: 'chrome', pid: 7, window_id: '100', tab_id: 't2', expected_url: 'https://example.org/schedule', link_id: '0', href: 'https://example.org/venue', label: 'Venue' } });
});

test('coordinator browser tool on Windows refuses non-web pages once selected and honours the Remote control switch', async () => {
  const helper = fakeHelper([], { focus: () => ({ ok: true, url: 'file:///C:/private.pdf', title: 'x' }) });
  const tabs = new BrowserTabs(windowsBrowserNative(helper), 'win32');
  const found = await tabs.run('owner:a', { action: 'discover', query: 'schedule' }) as any;
  await assert.rejects(tabs.run('owner:a', { action: 'select', tabRef: found.browsers[0].tabs[0].tabRef }), /Only ordinary HTTP\(S\) pages/);
  let calls = 0;
  const off = new BrowserTabs(async () => { calls++; }, 'win32', Date.now, () => false);
  await assert.rejects(off.run('a', { action: 'discover' }), err => deviceRefusal(err) === 'Desktop control is switched off in Settings. Turn on Remote control, then ask me again.');
  await assert.rejects(new BrowserTabs(async () => { calls++; }, 'linux').run('a', { action: 'discover' }), /macOS and Windows only/);
  assert.equal(calls, 0);
});

test('desktop control on Windows lists, focuses, reads (restoring the owner\'s tab), opens and closes tabs', async () => {
  const calls: any[] = [];
  const c = windowsControl(fakeHelper(calls));
  assert.deepEqual(c.view().browserAdapters, ['comet', 'chrome', 'edge', 'brave']);
  assert.ok(c.view().actions.includes('read_tab') && !c.view().actions.includes('navigate_tab'));
  const browsers = (await c.run('brain:1', { action: 'list_browsers' })).apps;
  assert.deepEqual(browsers.map((b: any) => [b.name, b.directTabs]), [['Google Chrome', true], ['Firefox', false]]);
  await assert.rejects(c.run('brain:1', { action: 'list_tabs', browser: 'firefox' }), /DESKTOP_SELECT_SUPPORTED_BROWSER/);
  const listed = await c.run('brain:1', { action: 'list_tabs', browser: 'chrome' });
  const [first, second] = listed.windows[0].tabs;
  assert.equal(second.url, null);
  assert.equal(calls.at(-1).args.browser, 'chrome');
  calls.length = 0;
  const page = await c.run('brain:1', { action: 'read_tab', tabRef: second.tabRef, screenshot: true });
  assert.equal(page.text, 'Day one. Day two.');
  assert.equal(page.screenshot.pngBase64, 'iVBORw0KGgo=');
  assert.equal(page.untrustedAppEvidence, true);
  assert.deepEqual(calls.map(x => [x.action, x.args.tab_id ?? null]), [['tabs', null], ['focus', 't2'], ['read', 't2'], ['focus', 't1']]);
  await assert.rejects(c.run('brain:1', { action: 'focus_tab', tabRef: first.tabRef }), /DESKTOP_ACTION_ID_REQUIRED/);
  const focused = await c.run('brain:1', { action: 'focus_tab', tabRef: first.tabRef, actionId: crypto.randomUUID() });
  assert.equal(focused.tab_id, 't1');
  const opened = await c.run('brain:1', { action: 'new_tab', windowRef: listed.windows[0].windowRef, url: 'https://example.org/new', actionId: crypto.randomUUID() });
  assert.equal(opened.inRequestedWindow, true);
  assert.deepEqual(calls.at(-1), { action: 'open', args: { browser: 'chrome', url: 'https://example.org/new' } });
  await assert.rejects(c.run('brain:1', { action: 'new_tab', windowRef: listed.windows[0].windowRef, url: 'javascript:alert(1)', actionId: crypto.randomUUID() }), /DESKTOP_URL_INVALID/);
  const again = await c.run('brain:1', { action: 'list_tabs', browser: 'chrome' });
  const closed = await c.run('brain:1', { action: 'close_tab', tabRef: again.windows[0].tabs[1].tabRef, actionId: crypto.randomUUID() });
  assert.equal(closed.closed, true);
  await assert.rejects(c.run('brain:1', { action: 'navigate_tab', tabRef: again.windows[0].tabs[0].tabRef, url: 'https://example.org', actionId: crypto.randomUUID() }),
    err => /new tab/.test(deviceRefusal(err)));
});

test('desktop control on Windows: a navigated or closed tab is stale, and the Settings switch gates everything', async () => {
  let moved = false;
  const helper = fakeHelper([], { tabs: () => { const t = structuredClone(TABS); if (moved) t.windows[0].tabs[0].url = 'https://example.org/elsewhere'; return t; } });
  const c = windowsControl(helper);
  const listed = await c.run('brain:1', { action: 'list_tabs', browser: 'chrome' });
  moved = true;
  await assert.rejects(c.run('brain:1', { action: 'read_tab', tabRef: listed.windows[0].tabs[0].tabRef }), /DESKTOP_TAB_NAVIGATED/);
  await assert.rejects(windowsControl(fakeHelper(), false).run('brain:1', { action: 'list_tabs', browser: 'chrome' }), /MAC_CONTROL_DISABLED/);
});

test('tool descriptions name the browsers this computer can read', () => {
  const win = browserToolText('win32'), mac = browserToolText('darwin');
  assert.match(win.listTabs, /Chrome, Edge, Brave, Comet/);
  assert.doesNotMatch(Object.values(win).join(' '), /Safari|Mac\b/);
  assert.equal(mac.listTabs, 'List the open tabs in every running browser (Comet, Chrome, Edge, Brave, Safari).');
  assert.doesNotMatch(Object.values(win).join(' ') + Object.values(mac).join(' '), /[\u2013\u2014]/);
});

// ---- Opt-in live test: launches its own browser with a throwaway profile on local pages,
// acts only on that browser (by process id), and closes it. Never touches the owner's browser.
const browserExe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
  .find(p => process.platform === 'win32' && existsSync(p));
test('live: a browser this test launched is listed, read, scrolled, followed, opened into and closed', { skip: process.env.FFD_LIVE_DESKTOP !== '1' || !browserExe, timeout: 120000 }, async () => {
  const id = /msedge/.test(browserExe!) ? 'msedge' : 'chrome';
  const server = createServer((req, res) => {
    const name = (req.url ?? '/').slice(1).replace(/[^a-z]/g, '') || 'home';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<title>FfdLive ${name}</title><h1>Heading ${name}</h1><p>Caf\u00e9 text ${name}</p><a href="http://127.0.0.1:48034/next">Next page</a><div role="tab">Page tab</div><div style="height:4000px"></div>`);
  });
  await new Promise<void>(r => server.listen(48034, '127.0.0.1', r));
  const profile = mkdtempSync(join(tmpdir(), 'ffd-live-browser-'));
  const child = spawn(browserExe!, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--new-window', 'http://127.0.0.1:48034/alpha', 'http://127.0.0.1:48034/beta'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, TMP: profile, TEMP: profile } });
  const pid = child.pid!;
  const raw = windowsBrowserHelper();
  // Every call is pinned to this test's own browser process.
  const helper: BrowserHelper = (action, args = {}, signal) => raw(action, { ...args, pid }, signal);
  try {
    let windows: any[] = [];
    for (let i = 0; i < 40 && windows[0]?.tabs?.length !== 2; i++) { await new Promise(r => setTimeout(r, 500)); windows = (await helper('tabs', { browser: id }).catch(() => ({ windows: [] }))).windows; }
    assert.deepEqual(windows[0].tabs.map((t: any) => t.title), ['FfdLive alpha', 'FfdLive beta'], 'page role=tab elements are not browser tabs');
    const own = (n: (q: Record<string, unknown>) => Promise<any>) => async (q: Record<string, unknown>) => q.action === 'inventory' ? (await n(q)).filter((b: any) => b.pid === pid) : n(q);
    const tabs = new BrowserTabs(own(windowsBrowserNative(helper)), 'win32');
    const found = await tabs.run('live', { action: 'discover', query: 'FfdLive' }) as any;
    const beta = found.browsers[0].tabs.find((t: any) => t.title === 'FfdLive beta');
    assert.equal(beta.url, null);
    assert.equal((await tabs.run('live', { action: 'select', tabRef: beta.tabRef }) as any).url, 'http://127.0.0.1:48034/beta');
    assert.equal((await tabs.run('live', { action: 'scroll', tabRef: beta.tabRef, direction: 'down' }) as any).scrolled, true);
    await tabs.run('live', { action: 'scroll', tabRef: beta.tabRef, direction: 'up' });
    const page = await tabs.run('live', { action: 'read', tabRef: beta.tabRef }) as any;
    assert.match(page.text, /Caf\u00e9 text beta/);
    assert.deepEqual(page.links.map((l: any) => l.label), ['Next page']);
    await tabs.run('live', { action: 'follow', tabRef: beta.tabRef, snapshotId: page.snapshotId, linkId: '0' });

    const control = new DesktopControl(prefs(true), noDriver, windowsDesktopBrowser(helper), 'win32', Date.now, async () => {});
    let listed: any;
    for (let i = 0; i < 20; i++) { listed = await control.run('live', { action: 'list_tabs', browser: id === 'msedge' ? 'edge' : 'chrome' }); if (listed.windows[0].tabs.some((t: any) => t.title === 'FfdLive next')) break; await new Promise(r => setTimeout(r, 300)); }
    const alpha = listed.windows[0].tabs.find((t: any) => t.title === 'FfdLive alpha');
    const read = await control.run('live', { action: 'read_tab', tabRef: alpha.tabRef });
    assert.match(read.text, /Heading alpha/);
    const after = await control.run('live', { action: 'list_tabs', browser: id === 'msedge' ? 'edge' : 'chrome' });
    assert.equal(after.windows[0].tabs.find((t: any) => t.active).title, 'FfdLive next', 'the selected tab is restored after a read');
    const opened = await control.run('live', { action: 'new_tab', windowRef: after.windows[0].windowRef, url: 'http://127.0.0.1:48034/gamma', actionId: crypto.randomUUID() });
    assert.ok(opened.tab_id);
    let gamma: any;
    for (let i = 0; i < 20 && !gamma; i++) { const l = await control.run('live', { action: 'list_tabs', browser: id === 'msedge' ? 'edge' : 'chrome' }); gamma = l.windows.flatMap((w: any) => w.tabs).find((t: any) => t.title === 'FfdLive gamma'); if (!gamma) await new Promise(r => setTimeout(r, 300)); }
    assert.ok(gamma, 'the new tab opened in this browser');
    assert.equal((await control.run('live', { action: 'close_tab', tabRef: gamma.tabRef, actionId: crypto.randomUUID() })).closed, true);
  } finally {
    await new Promise(r => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, r));
    server.close();
    await new Promise(r => setTimeout(r, 1000));
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
});
