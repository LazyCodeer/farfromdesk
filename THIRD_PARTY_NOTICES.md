# Third-party notices

FarFromDesk includes and depends on third-party work. The first-party license does not replace upstream licenses. Verify the exact dependency versions and full distribution obligations before publishing binaries.

| Component | Source / notices |
| --- | --- |
| Baileys | https://github.com/WhiskeySockets/Baileys — review the locked package's license and WhatsApp compatibility |
| whisper.cpp | https://github.com/ggml-org/whisper.cpp — MIT license copied into the speech runtime |
| Whisper model | https://github.com/openai/whisper — model license copied into the speech runtime |
| FFmpeg | https://ffmpeg.org — current build includes LGPL 2.1 notice, exact source archive and build recipe; review configuration-specific obligations |
| Node.js | https://nodejs.org — packaging copies its LICENSE when present; verify completeness before release |
| Poppins and DM Sans | License texts accompany font files in macos/Sources/SessionBridge/Resources/Fonts |
| Native desktop helpers | See native/README.md; redistribution provenance must be resolved before public release |
| Synthetic speech fixture | See test/fixtures/local-english.md for provenance |

Other npm dependencies are pinned in package-lock.json and carry their upstream package notices. The current development package includes node_modules; a public release should include a complete license inventory and review dev-dependency bundling.

The banner in docs/assets is an original FarFromDesk product illustration. It depicts a conceptual flow, not a live customer chat or proof of integration success.
