# Desktop update notifications

The next desktop build shows a compact **Update available** button in the top-right bar. The left side shows only FarFromDesk; the refresh icon and connection/page labels have been removed. It appears on Home, Activity and Settings only when a newer compatible release is known. The dialog shows the release version, installed version, download size, release notes, Later and Download update. Download opens the exact official asset URL in the default browser. It never runs an installer or stops the backend.

Settings also includes **Check for updates**. Checks are independent of the three-second local status polling, group/session discovery and backend connectivity. The native checker runs on app startup and subsequently at most once per six hours, with a one-minute limit for manual rechecks. Concurrent checks share one request. A small cache in the existing application state directory avoids repeated requests after reopening. The UI timer and HTTP client close when the app window is disposed. Native smoke tests skip external update checks.

## Distribution prerequisite

The current feed is the public GitHub Releases API for `LazyCodeer/farfromdesk`, queried anonymously. No user messages, machine IDs, local tokens or provider credentials are sent. **The repository currently remains private**, so ordinary installations cannot discover its private releases. A 404, rate limit, timeout or malformed feed is shown as unavailable in Settings, never as proof that the app is up to date. A previous verified update can remain visible while the network is unavailable.

Before distributing this feature publicly, provide anonymously accessible releases (either make the intended release repository public with explicit owner authorization, or configure a separate public distribution source in a future build). This change does not change repository visibility, publish installers, deploy the website or make the planned curl install URL live. Already installed older app builds need one manual update to acquire the notification feature.

## Version and asset rules

- `FFD_VERSION` is supplied by the release build. Development builds default to 0.7.0.
- Versions use semantic ordering; preview.10 follows preview.9. Equal/older versions are ignored; build metadata alone is not an upgrade.
- Stable installations ignore prereleases. Preview installations can see newer previews and stable releases.
- Only non-draft releases with an uploaded asset and matching checksum asset for the running platform/architecture qualify. A source ZIP alone does not qualify.
- Apple Silicon and Intel Macs receive their respective DMG (or ZIP fallback); Windows x64 receives ZIP, Linux x64 receives tar.gz. Unsupported architectures do not receive another architecture's installer.
- Download URLs must exactly match the official repository/tag/asset identity. No executable is downloaded or run during checking. The browser download is manual; checksum presence is not a claim that this notifier has downloaded and verified installer bytes.
- Requests time out after 12 seconds, redirects are disabled for metadata, and metadata is limited to 512 KiB. Only the newest 20 visible release entries are considered; the UI says “No newer compatible release found,” not that all possible historic releases were scanned.

## Installing while work is pending

Downloading does not stop sessions or change queued requests. Before replacing the app, finish current work, pause background forwarding in Settings and quit FarFromDesk. Request data and WhatsApp pairing remain in the application state directory. This notification feature does not implement silent updates, automatic installation/restart or a migration/rollback updater.

## Validation

Unit tests cover version ordering, platform/CPU selection, drafts, checksum presence, malicious download URLs, private/rate-limited feeds, malformed/oversized responses, parallel checks, persisted cache and failed refresh retention. Widget tests verify banner position across all three pages at the minimum window size, Later, deliberate download opening and absence of backend mutation from the update flow. Release checks use fake HTTP responses in tests; no production release is invented.
