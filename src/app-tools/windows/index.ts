import type { AppPack } from '../types.js';
import { ONENOTE_PACK } from './onenote.js';
import { OUTLOOK_CALENDAR_PACK, OUTLOOK_MAIL_PACK, OUTLOOK_TASKS_PACK } from './outlook.js';
import { FILES_PACK } from './files.js';
import { MEDIA_PACK } from './media.js';

/**
 * Every app tool that works on Windows, in the same tie-break order as the macOS registry.
 * Messages and Safari are absent on purpose: Windows has nothing they could drive.
 */
export const WINDOWS_PACKS: AppPack[] = [
  ONENOTE_PACK,
  OUTLOOK_CALENDAR_PACK,
  OUTLOOK_TASKS_PACK,
  OUTLOOK_MAIL_PACK,
  FILES_PACK,
  MEDIA_PACK,
];
