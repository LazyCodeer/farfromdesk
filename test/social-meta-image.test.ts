import test from 'node:test';
import assert from 'node:assert/strict';
import {generateMetaImage} from '../src/social-meta-image.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
test('Meta image request uses fixed provider and returns JPEG bytes with a fake transport', async () => {
  let calls = 0;
  const image = await generateMetaImage({prompt:'  sample scene  ', apiKey:'synthetic-key'}, async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.meta.ai/v1/images/generations');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init.body)), {
      model:'muse-image-1.0', prompt:'sample scene', n:1, response_format:'b64_json', output_format:'jpeg',
      tool_enablement:{enable_image_search:false,enable_web_search:false,enable_shell:false},
    });
    return Response.json({output_format:'jpeg',data:[{b64_json:jpeg.toString('base64')}]});
  });
  assert.equal(calls,1);
  assert.deepEqual(Buffer.from(image.bytes),jpeg);
  assert.equal(image.mimeType,'image/jpeg');
});

test('rejects invalid inputs, provider errors and malformed image responses without leaking provider text', async () => {
  let calls = 0;
  const transport = async () => { calls++; return Response.json({error:'synthetic-key'}, {status:401}); };
  await assert.rejects(generateMetaImage({prompt:' ',apiKey:'synthetic-key'},transport), /prompt and Meta/);
  assert.equal(calls,0);
  await assert.rejects(generateMetaImage({prompt:'test',apiKey:'synthetic-key'},transport), (error: Error) => error.message === 'Meta image request failed (HTTP 401).');
  await assert.rejects(generateMetaImage({prompt:'test',apiKey:'synthetic-key'},async () => Response.json({output_format:'jpeg',data:[{b64_json:'not-base64!'}]})), /invalid image response/);
  await assert.rejects(generateMetaImage({prompt:'test',apiKey:'synthetic-key'},async () => { throw new Error('synthetic-key'); }), (error: Error) => !error.message.includes('synthetic-key'));
});

test('valid large base64 response does not overflow the regexp stack', async () => {
  const bytes=Buffer.alloc(7_500_000,0x40);bytes[0]=0xff;bytes[1]=0xd8;bytes[bytes.length-2]=0xff;bytes[bytes.length-1]=0xd9;
  const encoded=bytes.toString('base64');assert.equal(encoded.length,10_000_000);
  const image=await generateMetaImage({prompt:'synthetic',apiKey:'synthetic'},async()=>Response.json({output_format:'jpeg',data:[{b64_json:encoded}]}));
  assert.equal(image.bytes.length,bytes.length);
});
