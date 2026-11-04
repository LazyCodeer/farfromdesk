import type { GoldenUtterance } from './golden.js';

/**
 * Requests that name neither the app nor any of its words, with the app in front.
 *
 * These are the honest test of the embedding layer. The lexical scorer is deliberately
 * conservative: it only puts a pack in play when the owner names the app, is in that app, or
 * says a word that belongs to it. "remind me to buy milk later" says none of those things, so
 * on the words alone it is not a Notes request even though it plainly is one while Notes is on
 * screen. Measured 4 November 2026, at eleven tools and 17 rows: the lexical scorer found the
 * right tool first for 16 of the 17, and adding on-device embedding candidates for the app in
 * front made it 17 of 17. The row that words alone miss is "what have I been jotting down
 * lately"; it is what keeps this set testing the embedding layer instead of the dictionary.
 */
export const PARAPHRASES: GoldenUtterance[] = [
  { text: 'remind me to buy milk later', app: 'Notes', tool: 'notes_create_note', note: 'not one Notes word; only the app in front makes it a Notes request' },
  { text: 'keep a record that the plumber comes on Monday', app: 'Notes', tool: 'notes_create_note', note: 'record keeping, no note vocabulary' },
  { text: "don't let me forget to call Ashitosh", app: 'Notes', tool: 'notes_create_note', note: 'the calendar pack also looks plausible here; the app in front decides' },
  { text: 'save this for later: invoice 442', app: 'Notes', tool: 'notes_create_note', note: 'save is a generic verb, so the lexical gate ignores it' },
  { text: 'my head is full, hold onto this thought: the roof is leaking', app: 'Notes', tool: 'notes_create_note', note: 'how people actually talk when they want to remember something' },
  { text: 'what have I been jotting down lately', app: 'Notes', tool: 'notes_recent', note: 'asks for the lot without one Notes content word; only the app in front and the embedding layer find it' },
  { text: 'read me the roof one', app: 'Notes', tool: 'notes_read', note: 'one note named by what it is about, not by its title' },
  { text: 'tack this onto the end of the roof one', app: 'Notes', tool: 'notes_append', note: 'append with none of the append vocabulary' },
  { text: 'rewrite the roof one to say the leak is fixed', app: 'Notes', tool: 'notes_update', note: 'replace the text of one note, said as a rewrite' },
  { text: 'throw away the shopping list note', app: 'Notes', tool: 'notes_delete', note: 'delete without ever saying delete' },
  { text: 'block out an hour for the dentist on Friday', app: 'Calendar', tool: 'calendar_create_event', note: 'no calendar words at all' },
  { text: 'I am seeing Ashitosh on Friday', app: 'Calendar', tool: 'calendar_create_event', note: 'a plan stated as a fact' },
  { text: 'what does my Friday look like', app: 'Calendar', tool: 'calendar_list_events', note: 'asking to see the schedule without saying schedule' },
  { text: 'am I busy tomorrow', app: 'Calendar', tool: 'calendar_list_events', note: 'busy is the only signal' },
  { text: 'is anything booked on Friday', app: 'Calendar', tool: 'calendar_list_events', note: 'booked belongs to the app, but on its own it is a weak match' },
  { text: 'make sure I pick up the dry cleaning', app: 'Reminders', tool: 'reminders_add', note: 'a chore with no reminder vocabulary' },
  { text: 'anything I have to do today', app: 'Reminders', tool: 'reminders_open', note: 'asks for the open items without naming the app or a single reminder word' },
];

/**
 * One owner-voice paraphrase per reviewed tool, with the app in front.
 *
 * This set answers a different question from PARAPHRASES above. That one measures the embedding
 * layer, so every row deliberately avoids the app's own words and only a Request that words alone
 * cannot place belongs in it. This one measures COVERAGE: every tool, including the eleven that
 * arrived with Mail, Finder, Safari, Music and Messages and the five content tools the Notes
 * failure needed, has at least one sentence the owner would really say that lands on it first.
 * Mixing the two would falsify the first set's meaning, which is why they are separate.
 *
 * Every row here is first for its tool on the words alone (and therefore also after widening,
 * which may only append). `uncoveredTools(allPackTools(), PARAPHRASE_COVERAGE)` must stay empty,
 * which test/app-tools-retrieval.test.ts asserts, so a new pack cannot land without a sentence.
 */
export const PARAPHRASE_COVERAGE: GoldenUtterance[] = [
  { text: 'show me everything i have written down', app: 'Notes', tool: 'notes_recent', note: 'asks for the lot, in the owner\'s words' },
  { text: 'what does the roof note say', app: 'Notes', tool: 'notes_read', note: 'one note, named by what it is about' },
  { text: 'do i have a note about the dentist', app: 'Notes', tool: 'notes_find', note: 'a search phrased as a question about whether it exists' },
  { text: 'remind me to buy stamps', app: 'Notes', tool: 'notes_create_note', note: 'the everyday way to ask for something to be written down' },
  { text: 'add a line to the roof note', app: 'Notes', tool: 'notes_append', note: 'adding to one note without saying append' },
  { text: 'change the roof note to say the leak is fixed', app: 'Notes', tool: 'notes_update', note: 'a correction to one note' },
  { text: 'delete the shopping list note', app: 'Notes', tool: 'notes_delete', note: 'the plain delete, with the name the owner typed' },
  { text: 'when is my next dentist appointment', app: 'Calendar', tool: 'calendar_find_events', note: 'a lookup by subject, not a window listing' },
  { text: 'what are the details of the standup', app: 'Calendar', tool: 'calendar_read_event', note: 'one event, asked about in full' },
  { text: 'what is on this week', app: 'Calendar', tool: 'calendar_list_events', note: 'a window with no dates named' },
  { text: 'put the dentist in for friday at 3', app: 'Calendar', tool: 'calendar_create_event', note: 'a booking, stated as placing something' },
  { text: 'move my dentist appointment to 6pm', app: 'Calendar', tool: 'calendar_update_event', note: 'moving one event' },
  { text: 'cancel the standup on friday', app: 'Calendar', tool: 'calendar_delete_event', note: 'cancel is how the owner says delete for a meeting' },
  { text: 'what reminder lists do i have', app: 'Reminders', tool: 'reminders_list', note: 'the lists themselves, not the items on them' },
  { text: 'what do i have to do today', app: 'Reminders', tool: 'reminders_open', note: 'the open items, with no reminder vocabulary' },
  { text: 'read me that reminder about the water bill', app: 'Reminders', tool: 'reminders_read', note: 'one item, read out' },
  { text: 'remind me to pick up the dry cleaning', app: 'Reminders', tool: 'reminders_add', note: 'a new item, said the way people say it' },
  { text: 'i picked up the dry cleaning, tick it off', app: 'Reminders', tool: 'reminders_complete', note: 'done, without the word complete' },
  { text: 'move the dentist reminder to tuesday', app: 'Reminders', tool: 'reminders_update', note: 'a change to one item' },
  { text: 'get rid of the water bill reminder', app: 'Reminders', tool: 'reminders_delete', note: 'delete said as getting rid of' },
  { text: 'what is in my inbox', app: 'Mail', tool: 'mail_recent', note: 'the newest mail, no sender or subject' },
  { text: 'find the email from the bank', app: 'Mail', tool: 'mail_find', note: 'a lookup by sender' },
  { text: 'what did the bank say', app: 'Mail', tool: 'mail_read', note: 'one message, asked about by its sender' },
  { text: 'write a reply to the landlord but do not send it', app: 'Mail', tool: 'mail_draft', note: 'a draft, with the never-send rule said out loud' },
  { text: 'what files did i just download', app: 'Finder', tool: 'finder_recent', note: 'the newest files, by where they landed' },
  { text: 'find the file called invoice', app: 'Finder', tool: 'finder_find', note: 'a lookup by name' },
  { text: 'what tabs do i have open', app: 'Safari', tool: 'safari_tabs', note: 'the open tabs' },
  { text: 'what does the page i am looking at say', app: 'Safari', tool: 'safari_read_tab', note: 'the page in front, read' },
  { text: 'what song is playing', app: 'Music', tool: 'music_current', note: 'the now-playing question' },
  { text: 'do i have that song in my library', app: 'Music', tool: 'music_library', note: 'a library lookup' },
  { text: 'who texted me last', app: 'Messages', tool: 'messages_recent', note: 'the newest texts' },
  { text: 'search my texts for the address', app: 'Messages', tool: 'messages_find', note: 'a lookup across the history' },
];