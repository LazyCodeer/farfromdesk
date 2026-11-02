# Social design versus installed implementation

Compared the six Social screens in FarFromDesk Screens (standalone).html with the Flutter source used for Local build 2311 and the supplied live Calendar screenshot. This is a source-based comparison plus that screenshot, not a pixel-by-pixel capture of every live tab. Other app sections are outside this audit.

## Findings

| Screen | Reference | Actual implementation | Assessment |
| --- | --- | --- | --- |
| Shared shell | Consistent app navigation and Social identity | screens.dart:425 deliberately shrinks sidebar to 140 px in Social versus 202 px elsewhere; different subtitle and icon | Inconsistent |
| Calendar, populated | Three-column rich artwork cards, status, descriptions, tags and actions | Working dated counts and platform filters; basic cards with image, title and format, without designed status, descriptions, tags or overflow menu | Partial |
| Calendar, empty | 929 x 268 phone-to-platform illustration, 36 px heading, explanatory copy, four example cards | 148 x 90 generic icon box, 20 px heading and three small outline buttons | Major visual mismatch |
| Drafts | Search, sorting, rich cards, closeable detailed side panel, thumbnail strip and metadata | Platform filters, selection, caption copying and slide export work; search/sort absent; 300 px detail panel versus reference 438 px; previous/next arrows instead of thumbnails; missing designed metadata and close control | Partial |
| Drafts, empty | No separate approved reference screen found | Single text panel | Needs an intentional empty-state design |
| Ideas | Research-backed card gallery, platform filters, sorting, idea rationale, references and Generate action | Not connected placeholder with static empty details | Unimplemented feature |
| Brand | Editable profile, audience, voice, themes, palette, assets and example posts | Six descriptive cards marked Not connected, with no editable fields or saved brand integration | Unimplemented feature |
| Templates | Artwork gallery, filters/search/sorting, detailed preview and workflow explanation | Four hardcoded prompt starters with gradient/text artwork; basic preview; no filters/search/sorting | Major mismatch |
| Generate dialog | Prompt-driven generation overlay | Actual generation is supplied through SocialScreen; not visually captured in this audit | Further visual comparison needed |

## Source evidence

All paths below are relative to .local/social-session-wiring-20261031:
- desktop/lib/screens.dart:425: Social-only sidebar width override.
- desktop/lib/social_workspace.dart:411: generic empty Calendar illustration and buttons.
- desktop/lib/social_workspace.dart:492: Calendar groups drafts by creation date.
- desktop/lib/social_workspace.dart:769: reduced draft card composition.
- desktop/lib/social_workspace.dart:883: preview and export controls.
- desktop/lib/social_workspace.dart:1035: Drafts empty state, filters and layout.
- desktop/lib/social_workspace.dart:1119: Ideas placeholder.
- desktop/lib/social_workspace.dart:1226: Brand placeholders.
- desktop/lib/social_workspace.dart:1389: four template definitions, followed by synthetic artwork and simple preview.

## Important distinctions

The screenshot has two drafts on Saturday and an empty selected Sunday. Showing No drafts for this day is correct for that state; the missing reference illustration and layout are separate problems. Overview appears highlighted too, but code only selects one navigation item; that appearance may be hover and is not a confirmed selection bug.

Calendar is a creation-date browser, not a content scheduling system. Matching the reference layout must not imply scheduling exists. The HTML contains illustrative dates, counts and unsupported sample business results; those must not be copied as real app data. Its template header says 12 while nine cards are present, so real counts must be computed from actual templates.

Passing earlier renderer and widget tests does not establish design fidelity. The new creative skill renders post assets, but it does not implement the Ideas and Brand workspace features.

## Recommended completion order

1. Shared shell, exact approved empty-state artwork, typography and example cards.
2. Calendar and Drafts card hierarchy, responsive detail pane, search/sort and thumbnail navigation.
3. Template catalogue and artwork matching the approved visual structure, with real counts.
4. Persistent Brand editing and agent context integration.
5. Research-backed Ideas storage, review and conversion into generation requests.
6. Compare each populated, empty, loading and failure state at the same viewport before calling the UI complete.

No application code or installed app was changed during this audit.
