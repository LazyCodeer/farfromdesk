import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'cheerio';
import { release } from './src/release.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'SITE_');
  const input = process.env.SITE_URL || env.SITE_URL;
  let origin = null;
  if (input) {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash)
      throw new Error('SITE_URL must be a confirmed HTTPS origin without a path, query or credentials.');
    origin = url.origin;
  }
  return {
    server: { host: '127.0.0.1' },
    preview: { host: '127.0.0.1' },
    plugins: [{
      name: 'farfromdesk-static-content',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          const $ = load(html);
          $('[data-icon]').each((_, element) => {
            const name = $(element).attr('data-icon');
            if (!/^[a-z-]+$/.test(name)) throw new Error('Invalid icon name');
            const svg = readFileSync(resolve(`node_modules/@phosphor-icons/core/assets/regular/${name}.svg`), 'utf8')
              .replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
            $(element).html(svg);
          });
          $('.waveform').html(Array.from({length:32}, (_,i)=>`<i style="--bar:${[12,20,29,17,32,24,14,27,35,21,11,29][i%12]}px"></i>`).join(''));
          if (origin) {
            $('head').append(`<link rel="canonical" href="${origin}/"><meta property="og:url" content="${origin}/"><meta property="og:image" content="${origin}/social-card.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:image" content="${origin}/social-card.png">`);
          } else $('head').append('<meta name="robots" content="noindex, nofollow">');
          const destinations = [
            ['[data-download]', release.downloadUrl, 'Download FarFromDesk for Mac'],
            ['[data-repository]', release.repositoryUrl, 'View FarFromDesk on GitHub'],
          ];
          for (const [selector, value, label] of destinations) {
            if (!value) continue;
            const url = new URL(value);
            if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Release destinations must be public HTTPS URLs');
            const prior = $(selector);
            const link = $('<a></a>').attr('class', prior.attr('class')).attr('href', value);
            link.append(prior.find('[data-icon]')).append($('<span></span>').text(label));
            prior.replaceWith(link);
          }
          const schema = {
            '@context':'https://schema.org', '@type':'SoftwareApplication', name:'FarFromDesk',
            applicationCategory:'DeveloperApplication', operatingSystem:'macOS 14 or later (Apple Silicon preview)',
            description:$('meta[name="description"]').attr('content'),
            ...(origin ? {url:origin+'/'} : {}),
            author:{'@type':'Organization',name:'Codecy Labs',url:'https://codecylabs.com/'},
          };
          $('head').append(`<script type="application/ld+json">${JSON.stringify(schema).replace(/</g,'\\u003c')}</script>`);
          return $.html();
        },
      },
      generateBundle() {
        this.emitFile({type:'asset',fileName:'robots.txt',source:origin ? `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n'});
        if (origin) this.emitFile({type:'asset',fileName:'sitemap.xml',source:`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>`});
      },
    }],
  };
});
