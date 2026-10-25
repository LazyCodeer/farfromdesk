# Security policy

Sidekick can relay requests to agents with access to your files. Treat the Mac, WhatsApp linked device, selected sessions, and native account permissions as security-sensitive.

## Reporting a vulnerability

Do not disclose credentials, exploit details involving private data, or live recordings in an ordinary issue. If GitHub private vulnerability reporting is enabled, use the repository Security tab to submit a private report. Otherwise contact the repository owner through an existing private channel to arrange a confidential report. Do not assume a public security inbox exists.

Provide the affected revision, sanitized reproduction steps, expected boundary, observed result, and a minimal synthetic example. Do not test against another person's account or sessions.

## Boundaries

- Owner/destination checks happen before remote input enters routing.
- Native bindings and session credentials restrict reply access.
- Local admin endpoints require authentication and loopback/host/origin checks.
- Prepared attachments are bound to request/session permissions and validated before dispatch.
- Native approvals remain authoritative; remote instructions are not blanket authorization.
- Transcription output is untrusted user input, never a privileged approval shortcut.

No claim of immunity to compromise is made. An agent with broad file access retains that access. An attacker controlling the owner's WhatsApp account or local Mac is outside a simple message-filtering defense. Prompt injection, native transport changes, and dependency vulnerabilities require ongoing review.

## Sensitive material

Never commit the application's state directory, linked-device credentials, admin tokens, session credentials, journals, recordings, or environment secrets. Use fixture data in bug reports and review staged files before pushing. Local logs may contain user content even when credential logging is avoided.

## Support status

Only the current private development branch is maintained. No public security SLA or supported release range is established yet. Public release requires the checks in docs/RELEASING.md.
