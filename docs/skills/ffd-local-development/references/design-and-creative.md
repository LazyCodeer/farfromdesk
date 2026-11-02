# Accepted direction and current behavior

The owner wants the existing near-black/orange FarFromDesk theme, not a new design system. Use `desktop/lib/bridge_theme.dart`; native Flutter controls provide focus, hover, disabled and selection behavior.

## Social interface

- Keep Calendar, Drafts, Ideas, Brand, Templates.
- Calendar shows **one day**, default today. Previous/next, date picker and Today sit on the right of the same tab row on wide windows, and wrap on narrow windows.
- No right preview column for Drafts or Templates. Cards show media and captions; selected cards expose full media/slide/export actions in place.
- Every draft image area is **320 logical pixels high**. Fit proportionally inside it with `BoxFit.contain`; do not crop or expand the card to the image's intrinsic height.
- Show full captions without clicking each card. Creative briefs/scripts can expand inline. Do not fabricate missing images or confuse a script with a video.
- Cache unchanged thumbnail bytes. Routine refresh must not blank images, reset date/filter/scroll state, select another draft or rewind the carousel.
- Show default image source + availability + Change on Social. Local SVG needs no image API key; session subscription/quota still applies. Meta shows saved/missing key state and has obscured key management on this page.
- Use coloured recognizable brand marks in filters, cards and Generate choices. X/Threads retain their monochrome brand appearance. Current marks derive from Font Awesome Free Brands 7.3.1, rasterized/recoloured for the dark UI, with CC BY 4.0 attribution in assets/social. Do not falsely call them downloaded official brand packs.
- Generate has a short brief, explicit session selection, platform choices with logos and a source choice. Avoid raw IDs and infrastructure details where they do not help the user choose; exact routing still uses IDs internally.

## Creative output

The approved creative work uses dimensional SVG illustrations, not generic text cards for every topic. Give agents actual brand logos, palette, product facts, audience, objective, platform format and chosen visual direction. Research claims only through permitted tools; ask only material missing questions. Do not assume every brand is Splice AI.

For Splice AI examples: indigo/lavender dimensional art, Bricolage Grotesque headlines, Instrument Sans body, exact supplied Splice logo. The portable `ffd-social-creative` skill contains licensed fonts, scenes (cart/channels/knowledge/rules/review), structured original drawing support and rendering tools. Local render size is currently 1080×1350, up to eight slides. Do not promise arbitrary platform sizes or video rendering without implementing and testing them.

Approved/example artifacts (same Build root as current-state):
- `social-cart-recovery-20261031/review.html`
- `social-brand-framework-20261031/review.html`
- `social-brand-formats-20261031/review.html`

App reference document:
`/Users/sagar/Documents/ChatGPT/Personal/whatsapp-session-bridge/FarFromDesk Screens (standalone).html`
Later explicit user changes in this reference override older weekly-calendar mockups. A browser ambient URL is context, not authorization to act on unrelated pages.

Inspect rendered images at full size and phone size. No invented recovery rates or other performance claims. The renderer can check data/overflow, not taste. Existing templates are illustrative examples, not live generated output or proof that connected accounts can publish.
