# Existing native design parity

The user explicitly chose the existing FarFromDesk desktop design on 25 October 2026. The provisional light interface has been removed. The shared Flutter UI uses the current native Mac screens as its design reference.

Authoritative source, confirmed by the macOS coding chat: commit `74432dd4e9347458d73ee3654004f5acee59bc6a`, FarFromDesk 0.6.2 build 41. The working source and sample renders were read without modifying or rebuilding the active Mac checkout.

| Native reference | Shared Flutter implementation |
| --- | --- |
| BridgeComponents.swift / BridgeTypography.swift | `desktop/lib/bridge_theme.dart` plus shared card/button/tab helpers |
| ContentView.swift | `buildDesk`: 86px icon rail, 40px buttons, title/status toolbar, errors and unfinished banner |
| WhatsAppView.swift | `homeScreen`: pairing/QR steps, linked account/logout, destination/master, voice status |
| DestinationView.swift | `destinationCard`: self/private group choices, recovered groups and explicit group creation |
| MasterSetupView.swift / BridgeAppPicker.swift | `masterForm`, `masterActions`, `openMaster`: app picker, new/existing tabs, automatic/custom name, exact-session list, recovery |
| ActivityView.swift | `activityScreen`: Waiting/Needs review/Answered/Closed filters, history table, row detail, eligible bulk close |
| SettingsView.swift | `settingsScreen`: background/login/awake, coding apps, cleanup, access disclosures and footer |

Tokens: canvas `#17181D`, panel `#202126`, primary text `#F2F2F4`, secondary `#A6A7AE`, action/selection `#5267E4`, accent `#7F91FF`, border `#34353C`, success `#85C7A1`. DM Sans is bundled with its license. Full FarFromDesk name remains in the toolbar; the shared FFD icon is in the rail.

Geometry follows the reference: minimum native window 900×640, content max width 960, horizontal padding 26, top 22, bottom 36, section gap 18, cards padding/radius 24, heading 28, body 13, captions 11, pill buttons radius 22. Native OS window controls remain native. Flutter rendering is not claimed pixel-identical to AppKit; native per-platform visual validation remains outstanding.

Deliberate platform differences: generic or OS-specific wording replaces Mac-only claims; unverified Desktop delivery stays unavailable; local speech tool configuration is inside an Access & availability disclosure because this shared preview does not yet bundle speech binaries/models. Existing native login-items links and native-chat deep links are not faked on unsupported platforms.

Visual references inspected were the synthetic `.local/ffd-brand/whatsapp-group.png` and `.local/ui-build37/create-dialog-auto.png` from the native checkout. These were viewed as references, not copied as runtime state or shipped in the package. Older Paper & Sage / Poppins HTML studies are explicitly not the reference.

The UI-only preview supports `?fixture=connected`, `?fixture=activity&screen=activity` and `?fixture=connected&screen=settings`. It always identifies itself as sample data. `lib/main.dart` remains the desktop product entry point; `lib/preview.dart` is only a review aid.
