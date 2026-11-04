# Checks and test limits

Run from current source, using the repository isolation launcher for backend tests:

```sh
rtk proxy npm run test:file -- test/social-creative.test.ts test/social-session.test.ts test/social-session-http.test.ts test/social-meta-image.test.ts test/social-assistant.test.ts test/social-http.test.ts
```

Choose the affected subset; do not bypass the launcher with raw node tests against production paths. Tests use synthetic state, credentials and provider transport. Preserve the launcher's realpath/symlink protection for production/coordinator directories.

From desktop:

```sh
rtk proxy /Volumes/Personal/DevTools/flutter/bin/flutter test --no-pub test/social_workspace_test.dart test/social_carousel_test.dart test/social_live_workspace_test.dart test/social_generate_dialog_test.dart test/social_image_settings_test.dart test/chat_message_text_test.dart test/inbox_attention_voice_test.dart test/inbox_session_label_test.dart
rtk proxy /Volumes/Personal/DevTools/flutter/bin/flutter analyze --no-pub lib/social_screen.dart lib/social_workspace.dart lib/social_generate_dialog.dart lib/social_image_settings.dart lib/social_platform_logo.dart lib/chat_message_text.dart lib/app.dart lib/studio_panes.dart
```

Meaningful regressions:
- Explicit session/provider identity cannot change through retry, event reuse or owner/session switch.
- Local rejects Meta before key access/network. Saved keys never enter session prompts, responses or dispatch payloads.
- Meta selection needs configuration; default change persists and reaches Generate; active request proof remains immutable.
- All captions appear without selection; summaries exclude full media bodies.
- Same-height media uses contain-fit; unchanged rebuilds reuse the image provider/bytes.
- Quiet refresh preserves the selected slide and avoids overwriting edits, stale async results or loaded older pages.
- One conversation scroll surface, no editable inner text/animation, normal text selection still works.
- Narrow/wide layouts, empty/error/loading states and missing media are honest.

`desktop/test/social_visual_review_test.dart` renders synthetic Flutter widgets to screenshots. Check its output directory before running; do not overwrite unrelated review work. It uses FontLoader for real text. On a fresh MaterialApp, use the same complete review theme and a fresh key to avoid theme-interpolation errors; missing test fonts show Ahem boxes, not a proven production text bug. View the actual PNGs. These are synthetic widget renders, not screenshots of the live native app; do not bypass disabled native capture restrictions.

Current evidence is in the dated artifact RESULTS.md files, not a permanent green guarantee. After new edits rerun affected checks. The following still need owner/live testing when requested and authorized:
1. A real Codex/Claude Social request: clarification, research if requested, ordered saved drafts/slides, correct reply route.
2. Live Meta artwork using the selected Local key, with applicable cost/access authorization.
3. macOS permission state after ad-hoc signing. Leave prompts to the owner.
4. Visual quality of actual generated content. Automated render validation is not a taste evaluation.

Do not ask for unrelated private logs/credentials or re-read production state merely because a test needs evidence. Use an approved diagnostic scope if available, or synthetic reproduction first.
