# Local mail service integration contract

The service is wired to isolated Local desktop routes, UI, a native approval helper and a Keychain broker. It has not been validated with live accounts. See `docs/local-email/INTEGRATION.md` for the review status.
It uses the IMAPS/SMTP-over-TLS transport; Gmail may work with an app password
where the Google account supports one. No OAuth or STARTTLS is implemented.
A configured account has saved credentials; it has not been authenticated or
verified against a server. Test and review the complete integration before use.

Construct `LocalMailService(db, secrets, authority)` with a dedicated SQLite
connection (not a connection used by host transactions), a trusted Keychain
adapter, and trusted host authority. The connection uses top-level transactions
and FULL synchronous writes before external I/O. The database and its WAL/backups
contain account configuration, plaintext draft bodies, and send claim metadata;
protect and retain them under the owner's existing local data policy. Passwords
are stored only via the injected Keychain adapter, under opaque random keys, not
in SQLite, settings, events or error messages. The host must never log request
bodies, credentials, provider exceptions, inbox content or protocol traffic.

`MailSecretStore` is `{kind:'macos-keychain', available():boolean,
read(key):Promise<string|undefined>, save(key,password):Promise<void>,
remove(key):Promise<void>}`. Use `macKeychainStore(vault, available)` in `keychain-adapter.ts` with the
shared `MailboxCredentialVault` (`read`, `write`, `remove`); secret slots are
32-character lowercase hexadecimal values. The adapter is structural and does
not ship or install the helper. This service owns credential lifecycle; do not
layer a second independent mailbox lifecycle over it. `available` is a synchronous check of
adapter availability, not proof that Keychain is unlocked. `save` must not settle until its helper has exited and can no longer write;
`remove` must be idempotent for absent keys. The Local broker wrapper waits for an operation response or process exit; it still requires packaged-app review and live platform validation. Failed
removals remain in a durable, owner/account
scoped queue; `cleanupCredentials()` retries, and `cleanupPending(id?)` reports
only the current owner's queued keys. Staged writes are excluded from cleanup. A failed or ambiguous `save` stays
staged, even after its promise rejects, until exclusive recovery on a later boot confirms that
all helper processes have exited. Ordinary cleanup cannot release that stage.

`status()` returns `{available,state,credentialStorage,
credentialsCleanupPending,credentialsRecoveryRequired,accounts}`. Account entries contain `{id,address,
imap:{host,port,username},smtp:{host,port,username},status,generation,
credentialsCleanupPending,credentialsRecoveryRequired}`; they contain no passwords. `state` is one of
`unavailable`, `attention`, `updating`, `configured`, `not_configured`.
Per-account status is `configured`, `updating`, or `setup_failed`. `configured`
is explicitly unverified. `credentialStorage` is `macos-keychain` or
`unavailable`. Surface both flags; recovery-required means cleanup must wait for a verified
exclusive restart and cannot be resolved by ordinary cleanup.

`configure({address,imap:{host,port,username,password},smtp:{host,port,
username,password}}, id?)` creates or replaces credentials. An existing `id`
rotates the account generation and invalidates in-flight work before writes.
Omitting `id` creates an account; the service supports multiple accounts.
A host may authenticate the local desktop owner and configure without pairing.
The host must map a paired, authenticated chat to the same stable owner
principal before allowing chat access; unpaired chat must never acquire it. Separate passwords are supported; they may be
the same app password. The original host input must never be echoed or logged.
`disconnect(id)` disables and removes the account and its stored drafts before
attempting Keychain deletion; `{credentialsCleanupPending:true}` means the host
must offer a later cleanup retry. Host configuration endpoints and their network
policy must be owner-controlled: this service accepts provider hostnames and
does not itself prevent private-network connections or DNS rebinding.

Draft APIs are `saveDraft(accountId, draftId|undefined, {to,subject,body})`,
`getDraft(id)`, `listDrafts(accountId)`, and `deleteDraft(id)`. The sender is
fixed to the configured account address; editing creates a new revision and
invalidates pending sends. `inbox(accountId,limit?)` returns bounded raw RFC 5322
bytes. Mail content is untrusted; render safely and never treat it as agent
instructions. No attachments, mailbox writes or MIME/HTML decoding are offered.

`sendDraft(accountId,draftId,approvalRef)` claims an explicit approval before
any send, returns `{claimId,status:'sent'|'uncertain'}`, and never retries.
`sent` means SMTP acceptance, not final delivery. `sendStatus(claimId)` lets the
same current owner inspect a durable claim. A changed owner, account generation,
draft revision or approval prevents further envelope/data writes; an already
started SMTP transmission can still be ambiguous. The same approval event and
same draft revision cannot be automatically replayed. Owner changes suppress
the immediate result, leaving the claim available to the original owner later.

The host MUST implement `HostMailAuthority` as a trusted synchronous adapter:

- `capture()` returns authenticated direct owner `{id,generation}`;
  `isCurrent(owner)` returns literal `true` only for that still-current owner
  generation. Generations must be durable and monotonically change on revocation,
  replacement and change-away-and-back.
- `verifyExplicitSend(scope)` independently verifies the owner's explicit send
  decision for the **exact** account generation, draft revision and digest, and
  returns a durable unique `eventId`. `approvalRef` is only a lookup reference,
  not proof. The verifier must not accept agent text, a bare boolean, a quoted,
  forwarded or stale message, or a decision for another draft or account.
- `approvalCurrent(scope,eventId)` returns literal `true` only while that exact
  approval remains valid. Revocation must be durable and cannot be undone for
  the same event; a new approval needs a new event. These checks run at claim,
  before SMTP authentication and before each envelope/DATA boundary.
- `assertExclusiveRecovery()` returns literal `true` only while a host-held
  cross-process singleton lock proves no other service instance, in-flight
  operation, or surviving credential helper can access this database or write
  a staged credential. The host must retain that lock for its
  entire service lifetime. Promise/truthy objects are rejected. The lock and proof that helpers have exited are not
  implemented by this module.

At exclusive startup, call `recover()` before handling requests: it marks all
interrupted claimed/sending actions uncertain, marks incomplete configuration
failed. Staged keys from a different, recorded macOS boot become eligible for cleanup; same-boot or unrecorded stages remain protected. Then call
`cleanupCredentials()` for the current owner. Never call recovery alongside live
work and never auto-replay an uncertain send. A host adapter must also enforce
owner authorization for configuration, draft and inbox routes.

Before integration, independent review must cover the host lock and authority
adapters, Keychain packaging and credential lifecycle, network destination and
DNS policy, safe message rendering, SMTP ambiguity, and the restricted IMAP
parser. The isolated tests use synthetic data and loopback TLS servers only.
