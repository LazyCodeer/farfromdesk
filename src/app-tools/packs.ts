import type { AppPack, AppTool } from './types.js';
// The AppleScript literal helpers live in their own leaf module so a pack file can import them
// without creating a cycle back through this registry. They are re-exported here because the
// tests import them from this path.
export { asStr, appleDate, appleDateParts, appleDateAssign } from './applescript.js';
// One file per app, registered below. Each pack owns its tools, its refusal sentences and the
// parsing of whatever engine answers it; this module is only the registry and the lookups over
// it. The inline calendar and reminders tools that used to sit here moved into their pack files.
import { NOTES_PACK } from './packs/notes.js';
import { CALENDAR_PACK } from './packs/calendar.js';
import { REMINDERS_PACK } from './packs/reminders.js';
import { MAIL_PACK } from './packs/mail.js';
import { FINDER_PACK } from './packs/finder.js';
import { SAFARI_PACK } from './packs/safari.js';
import { MUSIC_PACK } from './packs/music.js';
import { MESSAGES_PACK } from './packs/messages.js';
import { WINDOWS_PACKS } from './windows/index.js';

/**
 * Every app the companion can call a tool on.
 *
 * The order is also the tie-break: when two tools score the same for one request, the one whose
 * pack is earlier wins, because retrieval keeps declaration order stable. Notes stays first
 * because it is the pack the failed "summary of all the notes" request needed.
 */
export const PACKS: AppPack[] = [
  NOTES_PACK,
  CALENDAR_PACK,
  REMINDERS_PACK,
  MAIL_PACK,
  FINDER_PACK,
  SAFARI_PACK,
  MUSIC_PACK,
  MESSAGES_PACK,
];

export function allPackTools(): AppTool[] {
  return PACKS.flatMap(pack => pack.tools);
}

export function packFor(app: string): AppPack | undefined {
  const wanted = app.trim().toLowerCase();
  return PACKS.find(pack => pack.app.toLowerCase() === wanted);
}

export function toolByName(name: string): AppTool | undefined {
  const wanted = name.trim().toLowerCase();
  return allPackTools().find(tool => tool.name.toLowerCase() === wanted);
}
/**
 * The packs that work on one platform, so a catalog never lists a tool that would be refused.
 *
 * macOS keeps `PACKS` exactly. Windows has Outlook (calendar, tasks, mail), OneNote, files and the
 * system media controls (see `src/app-tools/windows/`); Messages and Safari have no Windows
 * counterpart and are not offered. Other systems have no app tools yet.
 */
export function packsFor(platform: NodeJS.Platform = process.platform): AppPack[] {
  if (platform === 'darwin') return PACKS;
  if (platform === 'win32') return WINDOWS_PACKS;
  return [];
}

export function platformTools(platform: NodeJS.Platform = process.platform): AppTool[] {
  return packsFor(platform).flatMap(pack => pack.tools);
}

export function platformToolByName(name: string, platform: NodeJS.Platform = process.platform): AppTool | undefined {
  const wanted = name.trim().toLowerCase();
  return platformTools(platform).find(tool => tool.name.toLowerCase() === wanted);
}
