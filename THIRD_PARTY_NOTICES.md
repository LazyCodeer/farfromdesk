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
| Provider marks | `desktop/assets/logo-<provider>.png` are each vendor's own mark, used only to identify that vendor's product in a picker: Claude, OpenAI/Codex, WhatsApp, Telegram, GitHub, Muse Code and, for DeepSeek Harness, the whale from the DeepSeek Harness web bundle (`favicon.svg`, recoloured to the vendor's blue on a light tile). They are trademarks of their owners, not FarFromDesk assets, and a public release should confirm each vendor's brand terms |
| Poppins and DM Sans | License texts accompany font files in macos/Sources/SessionBridge/Resources/Fonts |
| Native desktop helpers | See native/README.md; redistribution provenance must be resolved before public release |
| werift 0.25.2 | https://github.com/shinyoshiaki/werift-webrtc (MIT), used for phone control. Brings mediabunny 1.62.1 (MPL-2.0, unmodified, source https://github.com/Vanilagy/mediabunny) and tweetnacl 1.0.3 (Unlicense); their license files ship in node_modules |
| mailparser 3.14.1 | https://github.com/nodemailer/mailparser (MIT), used for bounded email parsing |
| ipaddr.js 2.5.0 | https://github.com/whitequark/ipaddr.js (MIT), used for mail network policy |
| Synthetic speech fixture | See test/fixtures/local-english.md for provenance |

Other npm dependencies are pinned in package-lock.json and carry their upstream package notices. The current development package includes node_modules; a public release should include a complete license inventory and review dev-dependency bundling.

The banner in docs/assets is an original FarFromDesk product illustration. It depicts a conceptual flow, not a live customer chat or proof of integration success.

## Cua driver 0.38.0 (macOS desktop control)

The macOS backend bundles the unmodified universal Cua driver under MIT, copyright 2025 Cua AI, Inc. Source: https://github.com/trycua/cua/tree/cua-driver-rs-v0.38.0/libs/cua-driver/rust . The build verifies pinned archive and executable SHA-256 hashes and preserves the vendor signature. Full license and upstream dependency notices are bundled in backend/native/cua-driver. OpenBot application code and optional model detectors are not included.

## Agency Agents role instructions

Research and Jobs specialist instructions adapt role text from https://github.com/msitarzewski/agency-agents.

MIT License

Copyright (c) 2025 AgentLand Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
