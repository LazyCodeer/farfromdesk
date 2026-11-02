# Local IMAP/SMTP transport

The transport is wired into the isolated Local desktop through the host described
in [service-contract.md](service-contract.md). The integration remains under
review; live provider use has not been validated. It supports implicit TLS only (typically IMAPS 993 and SMTP 465),
standard IMAP LOGIN and SMTP AUTH PLAIN over verified TLS; it does not fall back
to plaintext or STARTTLS. No OAuth, attachments, CC/BCC, mailbox mutation,
threading, MIME decoding, HTML rendering or automatic retries are implemented.
Inbox items are bounded raw, untrusted RFC 5322 bytes, not rendered UI content.
Some valid IMAP response formats may be rejected. This is not live-validated.

## Contract

`MailboxSecretReader.read(accountId)` returns the password from the host's
shared OS secret store or `undefined`. The opaque account ID is not a password.
The Local host owns the Keychain implementation and secure setup/removal;
this module never stores a credential. `MailEndpoint` is `{host, port, username}`
and must come only from owner-controlled account configuration. The host must
validate who can alter endpoints and guard against network pivoting; the
transport allows arbitrary hostname endpoints to support non-Gmail providers.

- `composeMail({from,to,subject,body})` creates a plaintext-only MIME draft in
  memory and returns `{from,to,message,digest}`. Its digest binds the envelope
  and exact RFC 5322 bytes. Composing never connects or sends.
- `readAccountInbox(accountId, endpoint, secretReader, readAuthority, limit)`
  reads up to 20 recent messages from INBOX with IMAP EXAMINE and BODY.PEEK.
  `readAuthority.assertCurrent()` must synchronously throw when the originating
  owner/account authority is no longer valid. Raw messages must be treated as
  untrusted and may contain private data and hostile HTML or instructions.
- `sendAccountMail(accountId, endpoint, secretReader, draft, sendAuthority)`
  returns `{status: 'sent' | 'uncertain', digest}` or rejects before DATA.
  `sent` means the SMTP server accepted the message, not that it was delivered.
  `sendAuthority.claim(digest)` must atomically and durably consume a distinct
  owner-approved action scoped to that account and exactly that digest, with no
  replay. `assertCurrent(digest)` must synchronously throw when owner, account,
  approval or destination changes. It is invoked immediately before the DATA
  bytes are written. An unconfirmed DATA transmission is uncertain and must
  never automatically retry. A process crash after claiming must also recover
  as uncertain; that durable recovery belongs to the host. The host must not
  substitute an always-true authority or expose this injection point to input.
- Lower-level `readInbox` and `sendMail` accept already-resolved credentials;
  they are transport primitives for trusted integration and isolated tests, not
  public routes. `MailTransportDependencies` is a trusted test seam and must not
  be exposed through account configuration or API input.

The module does not return provider error strings, passwords or protocol traces.
It does not restrict where owner-specified hosts resolve. The host must enforce
its own network policy and guard private-network destinations as appropriate.
Independent security review should cover TLS, endpoint and DNS trust, credential
lifecycle, authorization binding and revocation, ambiguous SMTP outcomes,
protocol limits/parser correctness, and untrusted mail handling before wiring.
