import type { AppPack, AppTool } from '../types.js';
import { win } from './plans.js';

/**
 * Music on Windows: the system media controls (the panel Windows shows over the volume flyout).
 *
 * Windows has no Music app with a library to search, but every player that shows up in that panel
 * (Spotify, the Media Player app, a browser playing YouTube) publishes what it is playing and takes
 * play, pause and skip through the same WinRT interface, GlobalSystemMediaTransportControls. So the
 * Windows pack says what is playing and controls playback; it has no library search.
 *
 * Playback control is not marked as a write: pausing or skipping is undone by pressing the same
 * control again, which is the bar `writes` sets for "something the owner would have to undo".
 */

const nowPlaying: AppTool = {
  name: 'music_current',
  pack: 'music',
  app: 'Media',
  description:
    'Say what is playing on this PC right now, in whichever app is playing (Spotify, Media Player, ' +
    'a browser tab): the track, the artist, the album, the app and whether it is playing or paused. ' +
    'Use this when the owner asks what song is on, what they are listening to, or who sings what is ' +
    'playing. It only reports what the player already shows Windows: it never plays, pauses, skips ' +
    'or changes the volume. Returns one line with the track, the artist, the album, the app and the ' +
    'player state, or says that nothing is playing.',
  args: [],
  examples: ['what song is playing', 'what am i listening to', 'who is this singing', 'is the music paused'],
  keywords: ['what is playing', 'now playing', 'song', 'artist', 'album', 'listening', 'paused', 'music', 'spotify'],
  notFor: ['play a song', 'pause the music', 'skip this song'],
  writes: false,
  plan: () => win('media-current', {}, { timeoutMs: 15000, outputChars: 600 }),
};

const control = (name: string, op: string, description: string, examples: string[], keywords: string[]): AppTool => ({
  name,
  pack: 'music',
  app: 'Media',
  description,
  args: [],
  examples,
  keywords: [...keywords, 'music', 'song', 'playing', 'spotify'],
  notFor: ['what song is playing', 'what am i listening to'],
  writes: false,
  plan: () => win(op, {}, { timeoutMs: 15000, outputChars: 600 }),
});

const playPause = control(
  'music_play_pause',
  'media-toggle',
  'Pause what is playing on this PC, or resume it when it is paused, in whichever app is playing ' +
  '(Spotify, Media Player, a browser tab). Use this when the owner asks to pause, stop, resume, ' +
  'continue or play the music again. It acts on the player Windows shows in its media controls and ' +
  'nothing else; it never opens an app, picks a song or changes the volume. Returns the track and ' +
  'the new player state, or says that nothing is playing.',
  ['pause the music', 'resume the song', 'stop the music', 'play the music again'],
  ['pause', 'resume', 'stop', 'play', 'continue', 'unpause'],
);

const next = control(
  'music_next',
  'media-next',
  'Skip to the next track in whichever app is playing on this PC. Use this when the owner asks to ' +
  'skip, go to the next song or play the next track. It never opens an app or changes the volume. ' +
  'Returns the track that is playing afterwards, or says that nothing is playing.',
  ['skip this song', 'next song', 'play the next track'],
  ['skip', 'next', 'track'],
);

const previous = control(
  'music_previous',
  'media-previous',
  'Go back to the previous track in whichever app is playing on this PC. Use this when the owner ' +
  'asks for the previous song, the last song again or to go back a track. It never opens an app or ' +
  'changes the volume. Returns the track that is playing afterwards, or says that nothing is playing.',
  ['previous song', 'go back a song', 'play the last song again'],
  ['previous', 'back', 'track', 'last song'],
);

export const MEDIA_PACK: AppPack = {
  id: 'music',
  app: 'Media',
  summary: 'Say what is playing on this PC and pause, resume or skip it, in whichever app is playing.',
  tools: [nowPlaying, playPause, next, previous],
};
