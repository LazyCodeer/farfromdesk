import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { load } from 'cheerio';
import { loadEnv } from 'vite';
import { release } from '../src/release.js';

const html = readFileSync('dist/index.html','utf8');
const $ = load(html);
const siteUrl = process.env.SITE_URL || loadEnv('production', process.cwd(), 'SITE_').SITE_URL;

test('all local anchors, assets and tab relationships resolve', () => {
  assert.equal($('h1').length,1);
  assert.equal($('[role="tab"]').length,3);
  const ids = $('[id]').map((_,e)=>$(e).attr('id')).get();
  assert.equal(new Set(ids).size,ids.length);
  $('a[href^="#"]').each((_,e)=>{const id=$(e).attr('href').slice(1);if(id)assert.ok(ids.includes(id),`Missing anchor ${id}`);});
  $('[role="tab"]').each((_,e)=>{
    const panel=$('#'+$(e).attr('aria-controls'));
    assert.equal(panel.attr('role'),'tabpanel');
    assert.equal(panel.attr('aria-labelledby'),$(e).attr('id'));
  });
  assert.equal($('[role="tabpanel"]:not([hidden])').length,1);
  assert.equal($('[role="tab"][aria-selected="true"]').length,1);
  $('img[src^="/"],script[src^="/"],link[href^="/"]').each((_,e)=>{
    const file=$(e).attr('src')||$(e).attr('href');
    assert.ok(statSync('dist'+file).isFile(),file);
  });
});

test('unavailable releases never become fabricated download or GitHub links', () => {
  if (!release.downloadUrl) {
    assert.match($('[data-download]').text(),/not yet available/);
    assert.equal($('[data-download]').is('a'),false);
    assert.equal($('a[download]').length,0);
  }
  if (!release.repositoryUrl) assert.equal($('a[href*="github.com/"]').length,0);
  assert.match($('#get-farfromdesk').text(),/local preview/);
  assert.match($('#compatibility').text(),/Apple Silicon, macOS 14/);
});

test('preview build is not indexed and no guessed domain is emitted', () => {
  if (siteUrl) {
    assert.equal($('link[rel="canonical"]').attr('href'),new URL(siteUrl).origin+'/');
    assert.match(readFileSync('dist/robots.txt','utf8'),/Allow: \//);
    assert.ok(statSync('dist/sitemap.xml').isFile());
    assert.ok(statSync('dist/social-card.png').isFile());
    assert.equal($('meta[property="og:image"]').attr('content'),new URL(siteUrl).origin+'/social-card.png');
  } else {
    assert.equal($('meta[name="robots"]').attr('content'),'noindex, nofollow');
    assert.equal($('link[rel="canonical"]').length,0);
    assert.match(readFileSync('dist/robots.txt','utf8'),/Disallow: \//);
  }
  const schema=JSON.parse($('script[type="application/ld+json"]').text());
  assert.equal(schema.name,'FarFromDesk');
  assert.equal(schema.offers,undefined);
  assert.equal(schema.aggregateRating,undefined);
});

test('built output has no private paths, credentials, application state or tracking integrations', () => {
  function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(`${dir}/${e.name}`):[`${dir}/${e.name}`]);}
  for(const file of files('dist')) {
    assert.doesNotMatch(file,/\.(pem|key|sqlite|db|map)$|\/\.env/);
    if(!/\.(html|js|css|txt|svg|xml)$/.test(file))continue;
    const source=readFileSync(file,'utf8');
    assert.doesNotMatch(source,/\/Users\/[^/\s]+|personal-revenue|revenue-sprint|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}/);
    assert.doesNotMatch(source,/googletagmanager\.com|google-analytics\.com|posthog\.com/);
  }
});

test('illustrations and requirements retain their qualifications', () => {
  assert.match($('.hero-art figcaption').text(),/sample content/);
  assert.match($('#panel-2').text(),/Scan the real QR inside the Mac app/);
  assert.match($('.voice-copy').text(),/Audio still travels through WhatsApp/);
  assert.match($('#faq').text(),/does not override manual sleep, lid closure/);
  assert.equal($('[data-icon] svg').length,$('[data-icon]').length);
});
