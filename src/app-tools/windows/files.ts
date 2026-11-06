import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { win32 } from 'node:path';
import type { AppPack, AppTool, AppToolPlan } from '../types.js';
import { FINDER_PACK } from '../packs/finder.js';
import { retarget, say, wholeNumber } from './plans.js';

/**
 * Files on Windows: the Finder pack's two read-only tools over Node's own file system calls.
 *
 * No Explorer window, no PowerShell and no shell: a listing is `readdir` plus `stat`, so the tool
 * is fast, cannot type anywhere and cannot change a file. Like the macOS tools it reads only the
 * top level of one folder. Windows Search would answer "anywhere on the PC" questions, but its
 * index skips folders the owner never added and answers stale results for a fresh download, so a
 * plain listing is the honest answer to "what did I download" and "is the invoice in Downloads".
 *
 * Known folders are looked up where Windows keeps them (Explorer's Shell Folders), because Desktop,
 * Documents and Pictures are often moved into OneDrive on Windows 11.
 */

/** Looks up a known folder's real path; undefined when Windows does not say. */
export type KnownFolders = (name: string) => Promise<string | undefined>;

const SHELL_VALUES: Record<string, string> = {
  desktop: 'Desktop', documents: 'Personal', pictures: 'My Pictures', videos: 'My Video',
  downloads: '{374DE290-123F-4565-9164-39C4925E467B}',
};

let shellFolders: Promise<Record<string, string>> | undefined;
function readShellFolders(): Promise<Record<string, string>> {
  shellFolders ??= new Promise(resolve => {
    execFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders'], { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      const values: Record<string, string> = {};
      if (!error) for (const line of String(stdout).split(/\r?\n/)) {
        const match = /^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/.exec(line);
        if (match) values[match[1]] = match[2].trim();
      }
      resolve(values);
    });
  });
  return shellFolders;
}

export const windowsKnownFolders: KnownFolders = async name => {
  const home = process.env.USERPROFILE || homedir();
  if (name === 'home') return home;
  if (name === 'public') return process.env.PUBLIC || win32.join(win32.parse(home).root, 'Users', 'Public');
  const value = SHELL_VALUES[name];
  const found = value ? (await readShellFolders())[value] : undefined;
  if (found) return found;
  const fallback: Record<string, string> = { desktop: 'Desktop', documents: 'Documents', pictures: 'Pictures', videos: 'Videos', downloads: 'Downloads' };
  return fallback[name] ? win32.join(home, fallback[name]) : undefined;
};

const ALIASES: Record<string, string> = {
  downloads: 'downloads', download: 'downloads', desktop: 'desktop', documents: 'documents', document: 'documents',
  home: 'home', pictures: 'pictures', picture: 'pictures', photos: 'pictures', videos: 'videos', video: 'videos',
  movies: 'videos', movie: 'videos', public: 'public',
};

const UNKNOWN_FOLDER = 'That folder name is not one I read by name. Name Downloads, Desktop, Documents, Home, Pictures, Videos or Public, or give the full path, such as C:\\Users\\you\\Projects.';

/** Which folder the owner meant, or a sentence saying why it cannot be read. */
async function target(raw: string, known: KnownFolders): Promise<{ path: string; label: string } | { refusal: string }> {
  const text = String(raw ?? '').trim();
  if (!text) {
    const path = await known('downloads');
    return path ? { path, label: 'the downloads folder' } : { refusal: UNKNOWN_FOLDER };
  }
  // A drive path only: a network share can hang the listing for a long time on a dropped connection.
  if (/^[a-zA-Z]:[\\/]/.test(text)) return { path: win32.normalize(text), label: `the folder at ${text}` };
  if (/^[\\/]{2}/.test(text)) return { refusal: 'I do not read network folders. Give a folder on this PC instead, such as C:\\Users\\you\\Projects.' };
  const key = ALIASES[text.toLowerCase().replace(/\s+folder$/, '').trim()];
  const path = key ? await known(key) : undefined;
  return path ? { path, label: `the ${key} folder` } : { refusal: UNKNOWN_FOLDER };
}

interface Entry { name: string; kind: string; changed: Date }

const SCAN_CAP = 5000;

function kindOf(name: string, folder: boolean): string {
  if (folder) return 'Folder';
  const ext = win32.extname(name).slice(1).toUpperCase();
  return ext ? `${ext} file` : 'File';
}

function when(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The top level of one folder, newest first. Hidden and system entries are left out, like Explorer does. */
async function listing(path: string, signal: AbortSignal, match?: (name: string) => boolean): Promise<{ entries: Entry[]; scanned: number } | { refusal: string }> {
  let names;
  try {
    names = await readdir(path, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return { refusal: 'That folder does not exist on this PC, so nothing was read out.' };
    if (code === 'ENOTDIR') return { refusal: 'That location is not a folder I can read, so nothing was read out.' };
    if (code === 'EPERM' || code === 'EACCES') return { refusal: 'Windows did not let me read that folder, so nothing was read out.' };
    return { refusal: 'That location is not a folder I can read, so nothing was read out.' };
  }
  const entries: Entry[] = [];
  let scanned = 0;
  for (const dirent of names) {
    if (signal.aborted) break;
    if (scanned >= SCAN_CAP) break;
    if (/^(desktop\.ini|thumbs\.db|ntuser\..*)$/i.test(dirent.name) || dirent.name.startsWith('$')) continue;
    scanned += 1;
    if (match && !match(dirent.name)) continue;
    try {
      const info = await stat(win32.join(path, dirent.name));
      entries.push({ name: dirent.name, kind: kindOf(dirent.name, info.isDirectory()), changed: info.mtime });
    } catch {
      // A file that vanished or is locked between the listing and the stat is simply not shown.
    }
  }
  entries.sort((a, b) => b.changed.getTime() - a.changed.getTime());
  return { entries, scanned };
}

const line = (entry: Entry) => `${entry.name} - ${entry.kind} - ${when(entry.changed)}`;

const WORDS: [string | RegExp, string][] = [
  ['on this Mac', 'on this PC'],
  ['a full path beginning with a slash', 'a full path such as C:\\Users\\you\\Projects'],
  ['Downloads, Desktop or Documents', 'Downloads, Desktop, Documents or Pictures'],
];

const macTool = (name: string): AppTool => {
  const found = FINDER_PACK.tools.find(candidate => candidate.name === name);
  if (!found) throw new Error(`The ${name} tool is missing from the finder pack.`);
  return found;
};

/** The Files pack, with the known-folder lookup injectable so tests never read the real profile. */
export function filesPack(known: KnownFolders = windowsKnownFolders): AppPack {
  const recent = macTool('finder_recent');
  const find = macTool('finder_find');
  const recentPlan = (args: Record<string, string>): AppToolPlan => {
    const limit = wholeNumber(args.limit, 10, 25);
    if (limit === undefined) return say('The limit has to be a whole number of items, like 10, or left empty for the 10 most recent.');
    return {
      kind: 'local',
      run: async signal => {
        const where = await target(String(args.folder ?? ''), known);
        if ('refusal' in where) return where.refusal;
        const read = await listing(where.path, signal);
        if ('refusal' in read) return read.refusal;
        if (!read.entries.length) return 'That folder is empty, so there was nothing to read out.';
        const shown = read.entries.slice(0, limit);
        return [`Showing ${shown.length} of ${read.entries.length} item(s) in ${where.label}, most recently changed first:`, ...shown.map(line)].join('\n');
      },
    };
  };
  const findPlan = (args: Record<string, string>): AppToolPlan => {
    const query = String(args.query ?? '').trim();
    if (!query) return say('I need the word or phrase to look for in the file names, so nothing was looked for.');
    const limit = wholeNumber(args.limit, 10, 25);
    if (limit === undefined) return say('The limit has to be a whole number of matches, like 10, or left empty for the 10 newest.');
    const wanted = query.toLowerCase();
    return {
      kind: 'local',
      run: async signal => {
        const where = await target(String(args.folder ?? ''), known);
        if ('refusal' in where) return where.refusal;
        const read = await listing(where.path, signal, name => name.toLowerCase().includes(wanted));
        if ('refusal' in read) return read.refusal;
        if (!read.entries.length) return `No item in ${where.label} has a name containing ${query}, after looking at ${read.scanned} item(s).`;
        const shown = read.entries.slice(0, limit);
        return [`Found ${read.entries.length} item(s) in ${where.label} whose name contains ${query}${shown.length < read.entries.length ? ` (showing the newest ${shown.length})` : ''}:`, ...shown.map(line)].join('\n');
      },
    };
  };
  return {
    id: 'finder',
    app: 'File Explorer',
    summary: 'Read recent files and find files by name in one folder, without ever moving or deleting anything.',
    tools: [
      retarget(recent, { app: 'File Explorer', pairs: WORDS, extraKeywords: ['explorer', 'file explorer'], plan: recentPlan }),
      retarget(find, { app: 'File Explorer', pairs: WORDS, extraKeywords: ['explorer', 'file explorer'], plan: findPlan }),
    ],
  };
}

export const FILES_PACK = filesPack();
