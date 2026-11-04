/** Meta Model API contract. Credentials and transport are supplied by the caller. */
export type MetaImageTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface MetaImage { bytes: Uint8Array; mimeType: 'image/jpeg' }

const endpoint = 'https://api.meta.ai/v1/images/generations';
const maxEncodedLength = 20_000_000;

/** The caller must explicitly supply both a key and transport. */
export async function generateMetaImage(
  input: { prompt: string; apiKey: string },
  transport: MetaImageTransport,
): Promise<MetaImage> {
  const prompt = input.prompt.trim();
  if (!prompt || !input.apiKey.trim()) throw new Error('A prompt and Meta Model API key are required.');
  let response: Response;
  try {
    response = await transport(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'muse-image-1.0', prompt, n: 1,
        response_format: 'b64_json', output_format: 'jpeg',
        tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
      }),
    });
  } catch {
    throw new Error('Meta image request failed; its outcome is unknown.');
  }
  if (!response.ok) throw new Error(`Meta image request failed (HTTP ${response.status}).`);
  let body: unknown;
  try {
    const reader = response.body?.getReader(); if (!reader) throw new Error('empty');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > maxEncodedLength + 100_000) { await reader.cancel(); throw new Error('large'); } chunks.push(value); } } finally { reader.releaseLock(); }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new Error('Meta returned an invalid image response.'); }
  const value = body as { output_format?: unknown; data?: Array<{ b64_json?: unknown }> };
  const encoded = value?.data?.[0]?.b64_json;
  if (value?.output_format !== 'jpeg' || typeof encoded !== 'string' || !encoded || encoded.length > maxEncodedLength || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Meta returned an invalid image response.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new Error('Meta returned an invalid JPEG.');
  }
  return { bytes, mimeType: 'image/jpeg' };
}
