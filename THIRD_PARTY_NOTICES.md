# Third-party notices

FarFromDesk includes and depends on third-party work. The first-party license does not replace upstream licenses. Verify the exact dependency versions and full distribution obligations before publishing binaries.

| Component | Source / notices |
| --- | --- |
| Baileys | https://github.com/WhiskeySockets/Baileys — review the locked package's license and WhatsApp compatibility |
| whisper.cpp | https://github.com/ggml-org/whisper.cpp — MIT license copied into the speech runtime |
| Whisper model | https://github.com/openai/whisper — model license copied into the speech runtime |
| FFmpeg | https://ffmpeg.org — current build includes LGPL 2.1 notice, exact source archive and build recipe; review configuration-specific obligations |
| Node.js | https://nodejs.org — the complete LICENSE for the bundled Node version is included in backend/runtime/Node-LICENSE.txt |
| Microsoft Visual C++ runtime | Windows bundles the release redistributable DLLs selected by CMake InstallRequiredSystemLibraries; https://learn.microsoft.com/cpp/windows/redistributing-visual-cpp-files |
| Flutter | https://github.com/flutter/flutter — third-party notices are bundled in Flutter assets |
| Poppins and DM Sans | License texts accompany font files in macos/Sources/SessionBridge/Resources/Fonts |
| Native desktop helpers | See native/README.md; redistribution provenance must be resolved before public release |
| werift 0.25.2 | https://github.com/shinyoshiaki/werift-webrtc (MIT), used for phone control. Brings mediabunny 1.62.1 (MPL-2.0, unmodified, source https://github.com/Vanilagy/mediabunny) and tweetnacl 1.0.3 (Unlicense); their license files ship in node_modules |
| Synthetic speech fixture | See test/fixtures/local-english.md for provenance |

Other npm dependencies are pinned in package-lock.json and carry their upstream package notices. The current development package includes node_modules; a public release should include a complete license inventory and review dev-dependency bundling.

The banner in docs/assets is an original FarFromDesk product illustration. It depicts a conceptual flow, not a live customer chat or proof of integration success.

## Cua driver 0.38.0 (macOS desktop control)

The macOS backend bundles the unmodified universal Cua driver under MIT, copyright 2025 Cua AI, Inc. Source: https://github.com/trycua/cua/tree/cua-driver-rs-v0.38.0/libs/cua-driver/rust . The build verifies pinned archive and executable SHA-256 hashes and preserves the vendor signature. Full license and upstream dependency notices are bundled in backend/native/cua-driver. OpenBot application code and optional model detectors are not included.
