# FarFromDesk launch

Final name approved by Sagar on 25 October 2026: **FarFromDesk**, with **FFD** as the monogram. Website chat owns website/logo/deployment. Main app chat owns native packaging and the existing private GitHub repository rename/integration.

## Destination and DNS

The verified company domain in code, deployment memory and Nginx is **codecylabs.com** (not codeseelabs.com). Intended site: https://ffd.codecylabs.com.

Owner added and public resolver confirmed the DNS record in codecylabs.com: A / ffd / 3.7.162.219 / TTL Auto. Use DNS-only initially for certificate issuance. Preserve unrelated records.

## Deployment

Website-only static build. Isolated Nginx vhost `/etc/nginx/conf.d/farfromdesk.conf`, document root `/var/www/farfromdesk/current`, releases under `/var/www/farfromdesk/releases/`, ACME webroot `/var/www/farfromdesk/acme`.

Deployed HTTPS release: `20261025-ffd-3d-01`. Upload only dist. Validate Nginx before reload; retain the previous Sidekick release and configuration backup for rollback. The old Sidekick origin vhost is retired (saved as sidekick.conf.retired); no DNS for the old name is requested.

HTTPS is enabled with a Let's Encrypt certificate covering ffd.codecylabs.com, expiring 23 January 2027. HTTP redirects to HTTPS except the ACME challenge path. Production config is deploy/nginx-https.conf. The owner added DNS on 25 October 2026; public DNS and the VM resolve correctly, while some local negative DNS caches may take time to expire.

A separate farfromdesk-cert-renew.timer checks twice daily with randomized delay. Its oneshot service renews only this certificate and tests/reloads Nginx after renewal. The company renewal timer is unchanged. Service/timer sources are under deploy/.

Build configuration: `SITE_URL=https://ffd.codecylabs.com` in local ignored `.env.local`. The build emits canonical, OG image URL, robots and sitemap for this destination. A default build without SITE_URL stays noindex.

## Repository integration

The existing product repository was LazyCodeer/sidekick, private. Main app chat owns its rename to LazyCodeer/farfromdesk and integration of this site's sanitized export into website/. Do not create a separate public website repository. Exclude nested .git, node_modules, dist, .env.local, review screenshots, credentials and personal-workspace material. Include .env.example, source, public assets/licenses, tests, deployment configuration and documentation. App and website source licensing follows the main repository's policy.

## Public downloads

Keep release.js URLs null while the product repository and release assets remain private. Historical Sidekick preview assets are not new FarFromDesk builds. Main app chat owns signing/notarization, native packaging and clean-install validation. The landing page may go live while honestly reporting that no public download is available.

## Verification record

See QA.md for local checks and the final origin deployment result. No announcement or marketing message has been sent.

## Short hostname change

On 25 October 2026 the owner renamed the DNS label to ffd for easier typing. Product name and GitHub repository remain FarFromDesk/farfromdesk. Rebuilt canonical/OG/schema/sitemap for https://ffd.codecylabs.com. New certificate issued for this hostname, and the existing dedicated renewal service now targets it. Deployment directory stays /var/www/farfromdesk. Prior hostname configuration saved as nginx-before-short-host.conf under that directory.

## Interactive redesign deployment

The 3D redesign is live as release 20261025-ffd-3d-01. Nginx configuration and TLS renewal remain unchanged. Prior release 20261025-ffd-03 is preserved for rollback. Public HTTPS verification matched all 29 dist files; homepage renders the new scene and missing paths return 404. Only static dist was uploaded.
