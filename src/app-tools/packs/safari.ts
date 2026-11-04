import type { AppPack, AppTool, AppToolArg, AppToolPlan } from '../types.js';
import { asStr } from '../applescript.js';

/**
 * The Safari pack: read the open tabs and the text of one page.
 *
 * Why this file exists: the owner asks "what tabs do I have open" and "what does that article
 * say", and neither can be answered from a screenshot of Safari's chrome. Safari's scripting
 * dictionary exposes `tabs of window`, each tab carrying `name` (the title), `URL` and a
 * read-only `text` property described as "the text of the web page currently loaded in the tab",
 * so the page's own words can be sent back instead of the labels of the window.
 *
 * Read-only by construction: no `close`, no `set`, no navigation command and no form of typing
 * appears in either script. Reading a page and driving a browser sit on opposite sides of a line
 * that is not worth crossing by accident.
 *
 * Measured notes about this app (macOS 27.0.1, dictionary at
 * /System/Cryptexes/App/System/Applications/Safari.app/Contents/Resources/Safari.sdef):
 * - the suite extends `window` with a `tab` element and a `current tab` property, and defines a
 *   `tab` class with read-only `name`, `URL`, `text` and `visible`.
 * - `do JavaScript` exists in the dictionary and takes the tab `in`, but it is gated by Safari's
 *   "Allow JavaScript from Apple Events" developer setting. `text of tab` is a declared property
 *   and is the route used here; if Safari still refuses it, the error is turned into a sentence
 *   that names both the automation permission and that setting rather than a raw error number.
 * - a tab is not addressable by title, so matching walks every window's tabs and refuses when
 *   the fragment matches none or more than one.
 */

const DEFAULT_TAB_LIMIT = 20;
const MAX_TAB_LIMIT = 50;
const DEFAULT_READ = 4000;
const MAX_READ = 40000;

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

const windowArg: AppToolArg = {
  name: 'window',
  description:
    'Which Safari window to read, counted from the front as 1. Leave empty for the front window, which is the one the owner is looking at.',
};

const safariTabs: AppTool = {
  name: 'safari_tabs',
  pack: 'safari',
  app: 'Safari',
  bundleId: 'com.apple.Safari',
  description:
    "List the open tabs of a Safari window and return each tab's title and web address. Use this " +
    'when the owner asks what tabs are open, asks what pages they have up, or wants to know what ' +
    'they were reading in Safari. It reads the tab titles and addresses only: it never opens, ' +
    'closes, reloads, reorders or changes a tab, and it never reads the contents of a page by ' +
    'itself. It reads the front window unless the owner gives a window number and returns at most ' +
    MAX_TAB_LIMIT +
    ' tabs. Returns one line per tab, in the order the tabs appear.',
  args: [windowArg, {
    name: 'limit',
    description: `How many tabs to return, for example 20. Leave empty for ${DEFAULT_TAB_LIMIT}; ${MAX_TAB_LIMIT} is the most allowed.`,
  }],
  examples: [
    'what tabs do i have open',
    'list my open safari tabs',
    'what pages do i have up in safari',
    'what was i reading in the browser',
  ],
  keywords: [
    'tabs',
    'open tabs',
    'safari tabs',
    'what is open',
    'web pages',
    'addresses',
    'browser',
    'windows',
  ],
  // Closing or opening a tab is a change, which this pack never makes.
  notFor: ['close the tab', 'open a new tab', 'reload the page'],
  writes: false,
  plan: args => {
    const limit = wholeNumber(args.limit, DEFAULT_TAB_LIMIT, MAX_TAB_LIMIT);
    if (limit === undefined) {
      return refuse(`The limit has to be a whole number of tabs, like 20, or left empty for the first ${DEFAULT_TAB_LIMIT}.`);
    }
    const rawWindow = String(args.window ?? '').trim();
    let select = `\tset w to front window\n`;
    if (rawWindow) {
      const win = wholeNumber(rawWindow, 1, 1000);
      if (win === undefined) {
        return refuse('The window has to be a whole number, like 1 for the front window, or left empty for the front window.');
      }
      select =
        `\tset n to ${win}\n` +
        `\tif n > (count of windows) then return "There is no Safari window number " & n & ", so nothing was listed."\n` +
        `\tset w to window n\n`;
    }
    return {
      kind: 'osascript',
      script:
        `set cap to ${limit}\n` +
        `tell application "Safari"\n` +
        `\tif (count of windows) is 0 then return "No Safari window is open, so there are no tabs to list."\n` +
        select +
        `\tset theTabs to tabs of w\n` +
        `\tset total to count of theTabs\n` +
        `\tif total is 0 then return "That Safari window has no open tabs."\n` +
        `\tset out to {}\n` +
        `\trepeat with i from 1 to total\n` +
        `\t\tset t to item i of theTabs\n` +
        `\t\ttry\n` +
        `\t\t\tset end of out to ((name of t) & " - " & (URL of t))\n` +
        `\t\ton error\n` +
        `\t\t\tset end of out to "(a tab whose title and address could not be read)"\n` +
        `\t\tend try\n` +
        `\t\tif (count of out) is greater than or equal to cap then exit repeat\n` +
        `\tend repeat\n` +
        `end tell\n` +
        `if (count of out) is 0 then return "No tabs were listed."\n` +
        `set {oldDelims, AppleScript's text item delimiters} to {AppleScript's text item delimiters, return}\n` +
        `set body to out as text\n` +
        `set AppleScript's text item delimiters to oldDelims\n` +
        `return "Showing " & (count of out) & " of " & total & " tab(s) in Safari:" & return & body\n`,
    };
  },
};

const safariReadTab: AppTool = {
  name: 'safari_read_tab',
  pack: 'safari',
  app: 'Safari',
  bundleId: 'com.apple.Safari',
  description:
    'Read the visible text of one open Safari tab, found by a fragment of its title or its web ' +
    'address, and return what the page actually says. Use this when the owner asks what a page ' +
    'says, asks to read an article they have open, or asks for the text of the page they are ' +
    'looking at. It reads one tab at a time and refuses when no tab matches or when more than ' +
    'one does, so the owner has to say which page they mean, and it reads only that page: it ' +
    'never clicks, types, scrolls, navigates or changes anything. Reading a page through ' +
    'Safari can be blocked until Safari has been granted automation permission, and it can also ' +
    'need the Allow JavaScript from Apple Events developer setting; when it is blocked the tool ' +
    'returns a sentence naming both rather than a raw error. Returns the tab title and up to the ' +
    'requested number of characters of the page text.',
  args: [
    { name: 'query', description: 'A fragment of the tab title or the web address, as the owner said it, enough to pick one tab.', required: true },
    {
      name: 'limit',
      description: `How many characters of the page text to return, for example 4000. Leave empty for ${DEFAULT_READ}; ${MAX_READ} is the most allowed.`,
    },
  ],
  examples: [
    'what does this page say',
    'read the article i have open',
    'what is the text of that page',
    'read the page about the recipe',
  ],
  keywords: [
    'read page',
    'page text',
    'article',
    'what does the page say',
    'read this tab',
    'page content',
    'read a web page',
  ],
  notFor: ['close the tab', 'open a new tab', 'scroll the page'],
  writes: false,
  plan: args => {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return refuse('I need a fragment of the tab title or its web address to know which page to read, so nothing was read.');
    }
    const limit = wholeNumber(args.limit, DEFAULT_READ, MAX_READ);
    if (limit === undefined) {
      return refuse(`The character limit has to be a whole number, like 4000, or left empty for the first ${DEFAULT_READ} characters.`);
    }
    return {
      kind: 'osascript',
      script:
        `set q to ${asStr(query)}\n` +
        `set cap to ${limit}\n` +
        `set pageText to missing value\n` +
        `set pageTitle to "that page"\n` +
        `tell application "Safari"\n` +
        `\tif (count of windows) is 0 then return "No Safari window is open, so there is no page to read."\n` +
        `\tset hits to {}\n` +
        `\trepeat with w in windows\n` +
        `\t\trepeat with k in tabs of w\n` +
        `\t\t\tset t to contents of k\n` +
        `\t\t\ttry\n` +
        `\t\t\t\tif ((name of t contains q) or (URL of t contains q)) then set end of hits to t\n` +
        `\t\t\tend try\n` +
        `\t\tend repeat\n` +
        `\tend repeat\n` +
        `\tif (count of hits) is 0 then return "No open Safari tab has a title or address containing " & q & ", so nothing was read."\n` +
        `\tif (count of hits) is greater than 1 then return "More than one open Safari tab matches " & q & ", so nothing was read: say which page you mean."\n` +
        `\tset t to item 1 of hits\n` +
        `\ttry\n` +
        `\t\tset pageTitle to name of t\n` +
        `\tend try\n` +
        `\ttry\n` +
        `\t\tset pageText to text of t\n` +
        `\ton error errMsg number errNum\n` +
        `\t\treturn "Safari would not give up the text of " & pageTitle & " (error " & errNum & "). Reading a page needs Safari's automation permission, granted once in System Settings under Privacy and Security, Automation, and it can also need the Allow JavaScript from Apple Events developer setting switched on in Safari's Develop menu. Nothing was changed and nothing was read."\n` +
        `\tend try\n` +
        `end tell\n` +
        `if pageText is missing value then return "Safari returned no text for " & pageTitle & ", so nothing was read."\n` +
        `set total to length of pageText\n` +
        `if total is 0 then return pageTitle & " has no visible text, which usually means the page is still loading or holds only images."\n` +
        `set shown to pageText\n` +
        `if total > cap then set shown to text 1 thru cap of pageText\n` +
        `if total > cap then return pageTitle & " has " & total & " characters; the first " & cap & " are:" & return & shown\n` +
        `return pageTitle & " has " & total & " characters:" & return & shown\n`,
    };
  },
};

export const SAFARI_PACK: AppPack = {
  id: 'safari',
  app: 'Safari',
  bundleId: 'com.apple.Safari',
  summary: 'List the open Safari tabs and read the text of one page, without clicking or changing anything.',
  tools: [safariTabs, safariReadTab],
};

export default SAFARI_PACK;