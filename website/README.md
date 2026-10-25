# FarFromDesk website

A product website for FarFromDesk, the local Mac app that connects WhatsApp to selected coding sessions. This repository contains website files only, not the app, bridge, credentials or real session content.

## Run

Node.js 22.13+ recommended.

```sh
rtk npm ci
rtk npm run dev -- --port 4186
rtk npm test
rtk npm run preview -- --port 4187
```

The build is in `dist/`. Without a confirmed `SITE_URL`, it emits `noindex, nofollow`, a blocking robots file, and no canonical domain. For launch, set `SITE_URL` to the verified HTTPS origin in `.env.local`, then rebuild. Never deploy the source checkout or a parent directory.

## Design and content

A light, spatial product site built on the existing Vite, CSS and GSAP foundation. Self-hosted Outfit/DM Sans, navy type, pale surfaces and the original indigo FFD identity.

- A Three.js scene connects a phone, FFD hub and laptop. Three camera views, pointer response and a user-triggered message path explain the connection.
- A request simulator supports update, voice-note and quoted-session examples with accessible live status and sample replies. It never contacts WhatsApp or coding sessions.
- Mobile and reduced-motion users get a lightweight WebP rendering first and explicitly choose to load 3D. The message simulator is immediately available.
- Rendering happens on demand; there is no perpetual render loop. Device-pixel ratio is capped, offscreen rendering stops, and unavailable/lost WebGL leaves a static poster.
- Three-step setup supports ArrowUp/Down, Home and End. Privacy dialog supports Escape and focus restoration. Mobile navigation closes after selection or Escape.
- Product illustrations and example content are synthetic and labelled. No tracking, forms, user data or application APIs.

Three.js is lazy-loaded separately (about 139 KB gzip) and its MIT license is included under public/licenses. scene-poster.webp is a rendered image of our own scene, used as an intentional fast fallback. The social card reflects the current design.

## Release links

`src/release.js` is intentionally empty until a real public download and product repository exist. Do not add a guessed GitHub repository, a local app path or an unsigned preview installer. Update the release prose and FAQ when public availability changes; links alone do not change release status.

See [launch preparation](docs/LAUNCH.md), [content evidence](docs/CONTENT.md), [design decisions](docs/DESIGN.md), and [verification](docs/QA.md).

## Licensing

Fonts are self-hosted under the SIL Open Font License; license files accompany them. Phosphor icons are MIT licensed and GSAP/Vite dependencies retain their upstream licenses. The website is being integrated into the existing private FarFromDesk product repository; the main repository controls original-source licensing. Third-party notices remain with their assets.
