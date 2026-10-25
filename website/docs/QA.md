# Website verification

25 October 2026. Website-only verification; this does not validate or certify the native app.

## Automated

- `npm test`: five checks passed for built anchors/assets, three-step panel wiring, truthful release availability, preview indexing configuration, private-content exclusion and qualified product claims.
- The same checks passed with a synthetic HTTPS origin to verify launch canonical/sitemap generation; the default non-indexable preview was restored afterward.
- Dependency installation: npm reported zero known vulnerabilities.
- Mobile Lighthouse against the production build: performance 99, accessibility 100, best practices 100. Lab FCP 1.2 seconds, LCP 1.8 seconds, TBT 0 ms, CLS 0. These are local simulated results, not field measurements.
- SEO score 66 is expected for the unpublished build: indexing is explicitly blocked until the actual domain is confirmed. Metadata and semantic content are present.

## Browser

- Production-build layout inspected at 320, 390, 768, 1024 and 1440 CSS-pixel viewport widths. Document width matched client width at all five after fixing decorative-orbit overflow.
- Desktop and mobile setup tabs change panels. ArrowDown selects/focuses the next tab; only one panel is exposed at a time.
- Mobile navigation opens and closes on selecting a section.
- FAQ disclosure expands the actual answer.
- Website privacy opens as a native modal. Escape closes it and restores focus to the originating button.
- No warnings/errors observed in the inspected browser log.
- OS reduced-motion paths are implemented in CSS and GSAP. A real OS preference toggle and assistive-technology session were not exercised in this browser tool.

Review screenshots and raw Lighthouse reports are local-only in ignored `review/`. Temporary responsive viewport overrides are reset before delivery.

## Boundaries

No app build, restart, real WhatsApp message, private screenshot, native session change or installer upload was performed. The earlier preview results above predate the FarFromDesk rename. Deployment and current verification are recorded below. The owner controls DNS; no DNS record has been changed by this chat.


## FarFromDesk rename and origin verification — 25 October 2026

- Renamed site copy, title, schema, metadata, anchors and package; installed new ascending FFD logo, outlined wordmarks and 1024px native icon source. Regenerated social card.
- npm test: all five checks pass with the actual FarFromDesk HTTPS destination configured. Prior Lighthouse numbers above are historical, not a fresh audit of this revision.
- Retested 320, 390, 768, 1024 and 1440 viewport widths: no horizontal document overflow. Moved mobile header release CTA into its existing menu to accommodate the full name.
- Mobile navigation closes on selection; setup tab clicks and ArrowDown select the correct panel; privacy dialog opens and Escape closes/restores focus.
- HTTP origin deployed to /var/www/farfromdesk/releases/20261025-ffd-02 and current symlink. nginx -t passed and reload succeeded.
- All 26 dist files fetched from the public VM with the FarFromDesk Host header matched local bytes. Homepage 200, unknown path 404. Existing codecylabs.com and sagarkumar.dev remained HTTPS 200; their Nginx configuration hashes and sarvam.conf were unchanged.
- DNS still absent at verification. HTTPS is pending owner DNS addition and subsequent certificate issuance. No public DNS or certificate success is claimed.
- Previous Sidekick release retained; old vhost saved as /etc/nginx/conf.d/sidekick.conf.retired and /var/www/sidekick/nginx-before-farfromdesk.conf. For rollback disable farfromdesk.conf, restore sidekick.conf, test Nginx and reload. No company host edits required.


## HTTPS activation after owner DNS addition

- Owner confirmed DNS addition. Cloudflare public resolver and VM resolver return 3.7.162.219. VM fetched the public HTTPS URL by normal DNS with status 200.
- Let's Encrypt certificate issued for farfromdesk.codecylabs.com; expires 23 January 2027. Nginx HTTPS configuration tested and reloaded. All 26 deployment files byte-match over TLS with certificate verification enabled. HTTP returns 301 to HTTPS; unknown HTTPS path returns 404.
- Added isolated FarFromDesk renewal service/timer; existing company renewal service remains unchanged.
- This desktop's resolver/browser initially retained NXDOMAIN; local preview visual checks remain the browser evidence until that cache expires. No certificate-verification bypass was used.

- Certificate renewal dry-run succeeded, including the Nginx validation/reload deploy hook. Timer is active.
- Local DNS issue isolated to the Wi-Fi/router resolver returning cached NXDOMAIN (negative TTL about 28 minutes); 1.1.1.1 and 8.8.8.8 resolve correctly. Owner advised mobile data or browser Secure DNS.


## Short URL deployment — 25 October 2026

Owner changed DNS to ffd.codecylabs.com; full product name remains FarFromDesk. Release 20261025-ffd-03 uses the new canonical/OG/schema/sitemap origin. All five site tests pass. All 26 deployed files byte-match over normal DNS and verified HTTPS; HTTP redirects with 301 and unknown paths return 404. Company/portfolio remain HTTPS 200. New hostname certificate issued and renewal dry-run including Nginx reload passed; dedicated timer remains active. Live browser successfully opened https://ffd.codecylabs.com/, confirmed canonical and loaded images. Screenshot: ignored review/ffd-live.png.
