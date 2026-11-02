# Illustration vocabulary

Use `layout: "illustration"` with either `illustration` OR `drawing`, not both. This layout has headline, optional body/eyebrow/footer and `tone: "dark" | "light"`. Other layout treatments cannot be mixed into the same slide. The renderer is portrait 1080 × 1350; do not promise other ratios from this tool.

Bundled `illustration` choices:
- `cart`: a dimensional cart and parcels for checkout/ecommerce.
- `channels`: a coordinated communication still life.
- `knowledge`: a dimensional open book for business context.
- `rules`: physical control rails for rules/settings.
- `review`: conversation record and magnifier for review.

These are reusable illustration assets, not screenshots or data. Do not use the wrong object merely because it exists. Choose an original `drawing` for topics outside the library.

## Original drawing
The creative tool returns the exact JSON schema. `drawing` contains up to 16 linear gradients and 220 ordered shapes. Work in a 1000 × 650 plane. Supported shapes are path, rect and ellipse. Each has fill, stroke, strokeWidth and opacity. Gradients use IDs g0 through g99, normalized endpoints and 2 to 8 ordered colour stops. Paint is a six-digit hex colour, `none`, or `url(#g0)` for a declared gradient.

Paths support normal SVG path commands through the validated `d` string. All drawing coordinates are bounded. Build depth by layering shadow ellipses, object side faces, front faces, narrow highlight strokes and reflected edges. Prefer a few carefully constructed objects to many unrelated shapes. Keep shadows inside the plane and build them with transparent layered shapes; arbitrary filters are not accepted.

No raw SVG, HTML, JavaScript, remote image URLs, local file paths, font declarations or model-defined filters are executed. Do not work around a rejected field. Simplify geometry or use a supported layout. Exact logos are composed separately; never trace a fake logo into a drawing. The optional `brand.logo: "spliceai"` is for the Splice AI name only.

The source-approved SVGs and font notices live in assets/. Those files are fixed renderer resources, not model-provided markup. The package does not bundle Meta's third-party logo packs for redistribution.
