import type { AppPack, AppTool, AppToolArg, AppToolPlan } from '../types.js';
import { asStr } from '../applescript.js';

/**
 * The Music pack: what is playing, and what the library holds.
 *
 * Why this file exists: "what song is this" is a question about content, and the accessibility
 * labels of the Music window answer it with button names. Music's scripting dictionary exposes
 * `player state`, `current track` and `every track of library playlist 1`, so both the now-playing
 * answer and a library search can be built from what Music actually holds.
 *
 * Read-only by construction, and deliberately so: `play`, `pause`, `next track` and
 * `set sound volume` all exist in this dictionary, and the owner's music starting or stopping by
 * itself is a bad failure. No tool in this pack contains any of them, and the tests pin that.
 *
 * Measured notes about this app (macOS 27.0.1, /System/Applications/Music.app):
 * - `player state` is an enumeration that stringifies to "playing", "paused" or "stopped".
 * - a track carries `name`, `artist` and `album`; airplay and some cloud items return empty
 *   strings for artist or album, so the answer fills those in rather than showing a blank.
 * - `every track of library playlist 1` walks the whole library, so the search reads a bounded
 *   prefix and says so in the description instead of holding the turn open.
 */

/** Tracks scanned in one library search. */
const SCAN_CAP = 2000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/** A plan that changes nothing and says why, in a sentence the owner can read. */
function refuse(sentence: string): AppToolPlan {
  return { kind: 'osascript', script: `return ${asStr(sentence)}\n` };
}

/** A whole positive number, clamped to a safe maximum, or undefined when it is not one. */
function wholeNumber(value: unknown, fallback: number, max: number): number | undefined {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) return undefined;
  return Math.min(n, max);
}

const musicCurrent: AppTool = {
  name: 'music_current',
  pack: 'music',
  app: 'Music',
  bundleId: 'com.apple.Music',
  description:
    'Say what is playing in Apple Music right now: the track, the artist, the album and whether ' +
    'it is playing or paused. Use this when the owner asks what song is on, what they are ' +
    'listening to, or who sings what is playing. It only reports what the player already has: it ' +
    'never plays, pauses, skips, seeks or changes the volume, and it never alters what Music ' +
    'holds. It reads the single track that is playing, so it does not list a queue. ' +
    'Returns one line with the track, the artist, the album and the player state.',
  args: [],
  examples: [
    'what song is playing',
    'what am i listening to',
    'who is this singing',
    'is the music paused',
  ],
  keywords: [
    'what is playing',
    'now playing',
    'song',
    'artist',
    'album',
    'listening',
    'paused',
    'music',
  ],
  // Controlling playback is never this pack's job.
  notFor: ['play a song', 'pause the music', 'skip this song'],
  writes: false,
  plan: () => ({
    kind: 'osascript',
    script:
      `tell application "Music"\n` +
      `\tset pstate to player state as string\n` +
      `\tif pstate is "stopped" then return "Nothing is playing in Music just now."\n` +
      `\ttry\n` +
      `\t\tset tr to name of current track\n` +
      `\t\tset ar to artist of current track\n` +
      `\t\tset al to album of current track\n` +
      `\ton error\n` +
      `\t\treturn "Music is " & pstate & ", but it would not give the track details."\n` +
      `\tend try\n` +
      `end tell\n` +
      `return "Track: " & tr & ", artist: " & ar & ", album: " & al & " (player state: " & pstate & ")."\n`,
  }),
};

const musicLibrary: AppTool = {
  name: 'music_library',
  pack: 'music',
  app: 'Music',
  bundleId: 'com.apple.Music',
  description:
    'Search the Apple Music library for songs, albums and artists whose name, artist or album ' +
    'contains a word the owner says, and return the track, the artist and the album of each ' +
    'match. Use this when the owner asks whether they have a song, asks to find an album, or ' +
    'asks what music they own by someone. It searches only what is already in the library: it ' +
    'never searches the store, the internet or a streaming catalogue, and it only reads, so it ' +
    'never plays a track, adds anything to a playlist or changes the library. It reads a bounded ' +
    'prefix of the library and returns at most ' +
    MAX_LIMIT +
    ' matches. Returns one line per match with the track, the artist and the album.',
  args: [
    { name: 'query', description: 'The word or short phrase to look for in the song, artist or album names, as the owner said it.', required: true },
    {
      name: 'limit',
      description: `How many matches to return, for example 10. Leave empty for ${DEFAULT_LIMIT}; ${MAX_LIMIT} is the most allowed.`,
    },
  ],
  examples: [
    'do i have that song in my music library',
    'find the album by that band in my library',
    'search my music for a song called sunshine',
    'what music do i have by that artist',
  ],
  keywords: [
    'music library',
    'my music',
    'find a song',
    'search my music',
    'album',
    'do i have',
    'artists',
  ],
  // Playing something is a change, and the now-playing question belongs to the other tool.
  notFor: ['play a song', 'queue this album', 'what is playing now'],
  writes: false,
  plan: args => {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return refuse('I need the word or phrase to look for in the music library, so nothing was searched.');
    }
    const limit = wholeNumber(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
    if (limit === undefined) {
      return refuse(`The limit has to be a whole number of matches, like 10, or left empty for the first ${DEFAULT_LIMIT}.`);
    }
    return {
      kind: 'osascript',
      script:
        `set q to ${asStr(query)}\n` +
        `set cap to ${limit}\n` +
        `set scanCap to ${SCAN_CAP}\n` +
        `set hits to {}\n` +
        `tell application "Music"\n` +
        `\tset total to count of tracks of library playlist 1\n` +
        `\tif total is 0 then return "The Music library has no tracks, so nothing was searched."\n` +
        `\tset scan to total\n` +
        `\tif scan > scanCap then set scan to scanCap\n` +
        `\trepeat with i from 1 to scan\n` +
        `\t\tset t to track i of library playlist 1\n` +
        `\t\tset nm to name of t\n` +
        `\t\tset ar to ""\n` +
        `\t\tset al to ""\n` +
        `\t\ttry\n` +
        `\t\t\tset ar to artist of t\n` +
        `\t\tend try\n` +
        `\t\ttry\n` +
        `\t\t\tset al to album of t\n` +
        `\t\tend try\n` +
        `\t\tif ar is "" then set ar to "unknown artist"\n` +
        `\t\tif al is "" then set al to "unknown album"\n` +
        `\t\tif (nm contains q) or (ar contains q) or (al contains q) then\n` +
        `\t\t\tset end of hits to (nm & " - " & ar & " - " & al)\n` +
        `\t\t\tif (count of hits) is greater than or equal to cap then exit repeat\n` +
        `\t\tend if\n` +
        `\tend repeat\n` +
        `end tell\n` +
        `if (count of hits) is 0 then return "No track in the Music library matches " & q & "."\n` +
        `set {oldDelims, AppleScript's text item delimiters} to {AppleScript's text item delimiters, return}\n` +
        `set body to hits as text\n` +
        `set AppleScript's text item delimiters to oldDelims\n` +
        `return "Showing " & (count of hits) & " match(es) in the Music library:" & return & body\n`,
    };
  },
};

export const MUSIC_PACK: AppPack = {
  id: 'music',
  app: 'Music',
  bundleId: 'com.apple.Music',
  summary: 'Say what is playing and search the music library, without ever playing, pausing or changing anything.',
  tools: [musicCurrent, musicLibrary],
};

export default MUSIC_PACK;