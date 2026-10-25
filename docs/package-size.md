# Desktop package size

Measured on the staged macOS Apple Silicon backend on 25 October 2026 (logical file sizes):

| Component | MiB |
|---|---:|
| Backend before pruning | 458.5 |
| SDK's unused bundled Claude executable | 261.4 |
| Node runtime | 106.2 |
| Bundled speech runtime/model/licenses | 168.7 |
| Multilingual base voice model within speech bundle | 141.1 |

The application already selects the installed Claude CLI explicitly through `pathToClaudeCodeExecutable`. `script/prune_desktop_backend.mjs` removes only the SDK's optional platform executable packages from the staged distribution after `npm ci`. It retains the SDK itself, its dependencies, image libraries, Node, speech model and tools, and redistributed licenses. This is not `--omit=optional`: that broad flag would also remove required native image dependencies.

A copy of the actual staged backend was pruned successfully. Importing its actual SDK and intercepting its documented spawn hook confirmed selection of the explicitly supplied CLI path without a bundled fallback, without starting a native model process. Isolated regression tests also verify the package allowlist, retained runtime/license files and idempotence.

The removed Apple Silicon Claude executable is 261.37 MiB uncompressed and 116.54 MiB using ZIP-compatible DEFLATE at level 6. This is a component measurement, not a newly built installer. Expect a substantial archive reduction; publish exact ZIP/DMG sizes only after a release rebuild. Windows/Linux/Intel savings depend on their own native executable sizes.

The installed native Claude CLI remains a prerequisite, as it was before this optimization. The model remains bundled so first-use transcription requires no download. Further model quantization would require language/quality benchmarking before changing the default. Source archives retained for bundled third-party license compliance are not removed for size savings.
