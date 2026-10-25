# FarFromDesk spatial redesign

25 October 2026. User requested a substantially more interactive website with a 3D theme.

## Direction

A developer-product site with tactile, spatial illustration. Single light theme, navy typography, the existing indigo FFD identity. Outfit display and DM Sans body text. No external stock imagery, generic gradients, fabricated testimonials or borrowed product screenshots.

The first version used a dark editorial layout with static phone/Mac illustrations. This revision replaces that hero and stylesheet while retaining product content, the Vite/GSAP stack, setup tabs, FAQ and privacy dialog.

## Interaction contract

The 3D scene shows three physical places: phone, local bridge and workspace. Overview/phone/desk buttons change the camera; pointer movement gives restrained perspective feedback; Send a message animates one sample packet. These interactions explain the real route without claiming an active account connection.

The second section is a working request simulator. Three scenarios alter the request and sample reply. Sending exposes routing progress and a live completion message. Switching scenarios cancels previous progress so an old result cannot overwrite the current choice. No network calls or audio recording are involved.

## Performance and access

Mobile and reduced-motion visitors see a WebP poster of the scene first. They may load 3D explicitly. Desktop loads the separate scene module as the hero becomes visible. Rendering is on demand; no animation loop runs at idle. Offscreen/hidden documents skip rendering. Context loss and unavailable WebGL fall back to the poster.

Existing keyboard tabs, semantic disclosure and native dialog remain. Live status explains demo transitions without relying on the canvas. The canvas is decorative to assistive technology. Headings/content are static HTML and remain available before JavaScript.

## Design checks

No horizontal overflow at 320, 390, 768, 1024 or 1440px. All surfaces stay in the same pale color family. Small label contrast was corrected using an automated accessibility audit. Local mobile/desktop Lighthouse results and limits are recorded in QA.md.
