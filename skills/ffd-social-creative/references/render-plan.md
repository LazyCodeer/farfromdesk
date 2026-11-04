# Rendering

Use the tool-provided schema as the contract. Example: `assets/example-plan.json`. `mode: svg` needs no image key. `mode: hybrid` needs a valid image already saved to the draft. The owner image source is enforced by the request tools.

Within FarFromDesk:
- `FFD social-creative REQUEST-ID`
- `FFD social-render REQUEST-ID DRAFT-ID` with `{ "revision": 1, "plan": ... }` on stdin.

Standalone:
- Node 22 or later, dependencies from package.json (`npm install --omit=dev` if absent).
- `node scripts/render.mjs schema`
- `node scripts/render.mjs render assets/example-plan.json /absolute/new-output-folder`

The output folder must be new to avoid overwriting reviewed work. Outputs: numbered JPEGs, phone thumbnails and a manifest with dimensions, hashes and alt text. Inspect them before delivery. Hybrid/Meta requests are available through FarFromDesk's request-bound tools, not the standalone CLI. A timeout or failure is not a completed asset.

Draft rendering preserves stale-revision checks and request/session ownership. A retry of an identical completed plan returns the existing result. Do not repeat a Meta request after an uncertain response.
