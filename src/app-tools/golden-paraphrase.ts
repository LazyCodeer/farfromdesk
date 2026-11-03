import type { GoldenUtterance } from './golden.js';

/**
 * Requests that name neither the app nor any of its words, with the app in front.
 *
 * These are the honest test of the embedding layer. The lexical scorer is deliberately
 * conservative: it only puts a pack in play when the owner names the app, is in that app, or
 * says a word that belongs to it. "remind me to buy milk later" says none of those things, so
 * on the words alone it is not a Notes request even though it plainly is one while Notes is on
 * screen. Measured 3 November 2026: the lexical scorer found the right tool in the top five for
 * 8 of these 10, and adding on-device embedding candidates for the app in front made it 10 of 10.
 */
export const PARAPHRASES: GoldenUtterance[] = [
  { text: 'remind me to buy milk later', app: 'Notes', tool: 'notes_create_note', note: 'not one Notes word; only the app in front makes it a Notes request' },
  { text: 'keep a record that the plumber comes on Monday', app: 'Notes', tool: 'notes_create_note', note: 'record keeping, no note vocabulary' },
  { text: "don't let me forget to call Ashitosh", app: 'Notes', tool: 'notes_create_note', note: 'the calendar pack also looks plausible here; the app in front decides' },
  { text: 'save this for later: invoice 442', app: 'Notes', tool: 'notes_create_note', note: 'save is a generic verb, so the lexical gate ignores it' },
  { text: 'my head is full, hold onto this thought: the roof is leaking', app: 'Notes', tool: 'notes_create_note', note: 'how people actually talk when they want to remember something' },
  { text: 'block out an hour for the dentist on Friday', app: 'Calendar', tool: 'calendar_create_event', note: 'no calendar words at all' },
  { text: 'I am seeing Ashitosh on Friday', app: 'Calendar', tool: 'calendar_create_event', note: 'a plan stated as a fact' },
  { text: 'what does my Friday look like', app: 'Calendar', tool: 'calendar_list_events', note: 'asking to see the schedule without saying schedule' },
  { text: 'am I busy tomorrow', app: 'Calendar', tool: 'calendar_list_events', note: 'busy is the only signal' },
  { text: 'is anything booked on Friday', app: 'Calendar', tool: 'calendar_list_events', note: 'booked belongs to the app, but on its own it is a weak match' },
];