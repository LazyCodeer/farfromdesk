# FarFromDesk Local design contract

Stack: Flutter desktop widgets, existing bridge_theme.dart tokens, Onest typography. No web or Tailwind stack.

2026-10-31: Owner requests a single-day Social view. Calendar/Drafts/Ideas/Brand/Templates stay in the same tab row; day picker and previous/next controls sit at the right on wide windows and wrap on narrow windows. Platform filters use recognizable vector brand marks. Cards render complete uncropped media, carousel navigation and caption within the card. No right preview column. Image source status and Change are visible above tabs; selection persists and propagates to Generate. Meta availability means saved key, not verified service reachability.

Components: SocialWorkspace, native Social post cards, day navigator, image-source settings dialog. Reuse Flutter controls for keyboard focus, hover, disabled and semantics. Keep loading/error/empty states explicit. No new visual theme.

2026-10-31 follow-up: Generate uses coloured brand marks, native dropdown fields, rounded platform choices and the existing orange accent. Conversation bubbles use accentWash for owner messages, raised for replies, and SelectionArea/Text for stable non-editable text with no inner scrolling or typewriter animation. Inline emphasis is rendered locally without loading links/media.

2026-10-31 polish: Image generation status uses one 12px header gap and an orange-tinted bordered box, with Change aligned right. Unselected draft captions and expanded briefs use ordinary Text so clicks reach card selection; selected details retain selectable text. Artwork, caption, format and padding selection are covered by a regression test.

2026-10-31 card preview polish: Carousel navigation overlays the left/right image edges with the slide count inside the image. Copy, export and delete are tooltip-labelled header icons for the selected card. Headers have a consistent height. Delete retains its confirmation dialog; exports use the current slide.

2026-10-31 compact navigation: Removed the repeated calendar day/count heading and ordinary creation-date caption. Platform filters show brand icons and expand name/count on hover or keyboard focus. Search/sort sit beside Drafts/Templates tabs on wide windows and below them on narrow windows; search controllers preserve input across tab switches and resizing.

2026-10-31 caption-only cards: All cards show share/copy/export/delete icons. Actions load and validate the exact target before acting; failed or cancelled switching cannot target the previous draft. Only caption text is visible beneath media; brief/title, caption label, extra details and format badge are removed. Carousel count uses x / y. Existing metadata stays stored.
