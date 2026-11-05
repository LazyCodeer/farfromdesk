// Test-only preload. This blocks unmocked fetch to non-loopback destinations;
// it is not an OS network sandbox and does not intercept sockets or http.request.
const originalFetch=globalThis.fetch;
globalThis.fetch=function(input,init) {
  let url;
  try {url=new URL(typeof input==='string'||input instanceof URL?input:input.url);}
  catch {return Promise.reject(new Error('Test fetch requires a valid loopback URL.'));}
  const host=url.hostname.toLowerCase();
  const loopback=host==='localhost'||host==='[::1]'||/^127(?:\.\d{1,3}){3}$/.test(host);
  if(!['http:','https:'].includes(url.protocol)||!loopback)
    return Promise.reject(new Error('Unmocked non-loopback fetch is disabled in tests.'));
  // Native fetch follows redirects internally, bypassing this wrapper. Never
  // follow a loopback response to an unexamined remote destination.
  const redirect=init?.redirect??(input instanceof Request?input.redirect:'follow');
  // Tests close a server and open the next one on the same port. A pooled
  // keep-alive socket from the old server can be reused before its close is
  // read, and a POST on it fails with ECONNRESET. One connection per request.
  const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
  headers.set('connection','close');
  return originalFetch(input,{...init,headers,...(redirect==='manual'||redirect==='error'?{}:{redirect:'error'})});
};
