/**
 * The last step between a brain answer and the owner's phone.
 *
 * Answers are assembled from three places and only one of them writes for a person: code
 * writes "Opened Comet.", the desktop driver writes "full read (no usable earlier read of
 * this window to diff against)", and the model writes chat prose. Measured live on the
 * owner's Mac, the driver's bookkeeping reached the chat verbatim, and a window's labels
 * arrived as one semicolon-joined line.
 *
 * So this runs once, at the single point every brain answer passes through, and a new
 * caller cannot reintroduce that shape. It is idempotent: text that is already an owner
 * message comes back byte-identical, which also keeps the reply receipt's text hash stable
 * across a retry.
 */

/**
 * Bookkeeping from the driver and the pipeline: true, and useless to the owner. A line
 * that matches is dropped, never rewritten, because the rest of the answer says what
 * happened anyway.
 */
const BOOKKEEPING = [
  /^(?:initial|full|partial|incremental|complete|first) read\b/i,
  /^no change since\b/i,
  /^nothing changed since\b/i,
  /^focused element is\b/i,
  /^tree[_ ]diff\b/i,
  /^\[\s*\{\s*"type"\s*:/,
  /^s\d{6,}\b/,
];

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const LONG_DASH = /\s*[\u2014\u2013]\s*/g;
/**
 * The width at which a line is plainly unwrapped rather than merely long. A phone shows
 * about forty characters per line, but wrapping there would reflow every sentence, and the
 * chat client already folds text to its own width. This only stops one paragraph from
 * arriving as a single unbroken run.
 */
const PHONE_LINE = 320;

export function isBookkeeping(line: string): boolean {
  const value = line.trim();
  return !!value && BOOKKEEPING.some(pattern => pattern.test(value));
}

/** Break one over-long line at spaces. No break point half way is better than a broken word. */
function wrap(line: string, width = PHONE_LINE): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    const cut = rest.lastIndexOf(' ', width);
    if (cut <= width / 2) break;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut + 1).trim();
  }
  out.push(rest);
  return out;
}

/**
 * A semicolon dump is a list its writer never broke into lines. Four or more parts is
 * decisively a dump: two or three are ordinary prose ("sent to session; no reply yet").
 */
function asBullets(line: string, limit = 10): string[] | null {
  if (!line.includes('; ')) return null;
  const parts = line.split(/;\s+/).map(part => part.trim()).filter(Boolean);
  if (parts.length < 4) return null;
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    rows.push(part);
    if (rows.length >= limit) break;
  }
  return rows.map(row => `- ${row}`);
}

/** An MCP content envelope is a transport detail: the owner gets the sentence it carries. */
const ENVELOPE = /\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}\s*\]/g;
function unenvelope(text: string): string {
  return text.replace(ENVELOPE, (_whole, body: string) => {
    try { return String(JSON.parse(`"${body}"`)); } catch { return body; }
  });
}

export function ownerReply(text: string): string {
  if (!text) return text;
  const cleaned = unenvelope(String(text))
    .replace(CONTROL, ' ')
    .replace(LONG_DASH, ', ')
    .replace(/,(\s*,)+/g, ',')
    .replace(/[ \t]+/g, ' ');
  const lines = cleaned.split('\n').map(line => line.trim());
  // A reply that is nothing but bookkeeping keeps its own words: an empty answer would
  // fail the receipt's identity check and hide the fact that something did happen.
  const kept = lines.filter(line => !isBookkeeping(line));
  const body = kept.length ? kept : lines.slice(0, 1);
  const out: string[] = [];
  for (const line of body) {
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    const bullets = asBullets(line);
    if (bullets) out.push(...bullets.flatMap(bullet => wrap(bullet)));
    else out.push(...wrap(line));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}