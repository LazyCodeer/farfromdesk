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

The website adapts the existing Codecy Labs Vite, semantic HTML, CSS and GSAP approach: its split hero, rounded arrow buttons, self-hosted Outfit / DM Sans / Instrument Serif, native FAQ disclosures and reversible reduced-motion animation contexts. FarFromDesk supplies the dark neutral / indigo palette and mark.

The phone, Mac, pairing, session graph and voice-note visuals are labelled illustrations with synthetic content. They are not screenshots of a user's sessions. The QR is an icon, not a usable pairing code. Motion explains request/reply order, setup transitions, session scope and local transcription. Nothing loops indefinitely.

- Three-step walkthrough supports keyboard arrows, Home and End.
- Native privacy dialog supports Escape and focus restoration.
- Mobile navigation closes after selection or Escape.
- Content is built into static HTML; no tracking, forms, user data or application APIs.
- Default OS reduced-motion preferences disable animated transitions.

## Release links

`src/release.js` is intentionally empty until a real public download and product repository exist. Do not add a guessed GitHub repository, a local app path or an unsigned preview installer. Update the release prose and FAQ when public availability changes; links alone do not change release status.

See [launch preparation](docs/LAUNCH.md), [content evidence](docs/CONTENT.md), [design decisions](docs/DESIGN.md), and [verification](docs/QA.md).

## Licensing

Fonts are self-hosted under the SIL Open Font License; license files accompany them. Phosphor icons are MIT licensed and GSAP/Vite dependencies retain their upstream licenses. The website is being integrated into the existing private FarFromDesk product repository; the main repository controls original-source licensing. Third-party notices remain with their assets.
