# F6 profile provenance review

The separate prototype at commit `7828c2a` is not wired into F6. Its tests use
synthetic profiles. It checks direct-owner context, selected whole lines, the
shortlist receipt, the selected listing, the mission and current profile hash.
Those checks are useful but do not establish all of the guarantees needed for
delivery of About-you content.

The later F6 implementation is separate from that prototype. With the owner's
authorized job request it retains selected notes in the existing owner-only
draft/outbox, and traces each note to an exact direct typed owner input. It
rechecks file metadata, content, history and the authorized line set before
delivery. This is not a guaranteed monotonic external-edit history, and legacy
or ambiguous records fail closed. See `errands-foundation.md` for limits.

- `queue()` puts the selected excerpts in the normal `outbox.body`. The normal
  queue and its database journals/backups can retain plaintext independently of
  the adoption table. A future route could also retain a selection command in
  inbound history. Removing a row later would not prove removal from journals
  or backups. The adoption table's unsalted line hashes can also be guessed for
  predictable short lines; they are not a privacy boundary.
- Comparing `hash(profile)` at selection and delivery cannot detect profile
  A-to-B-to-A changes. `OwnerMemory` records app writes, but external edits are
  picked up only by `scan()`, so its history is not a complete monotonic
  revision source. A process restart can miss external changes too. File
  timestamps alone are not a reliable substitute for a trusted revision.
- `OwnerMemory.read()` uses a path check followed by a separate read; the
  prototype has no reviewed bounded, no-follow file reader or protection
  against replacement between those operations. It also lacks a real ingress
  adapter and a final transport guard, so the synthetic calls to `capture()`
  do not demonstrate owner authorization or delivery in the real path.
- The preview quotes selected lines beside a generic letter; it does not
  establish that those lines are relevant, accurate or suitable to send.

Before integration, define the retention policy and a transport design that
enforces it across inbound, outbox, crash recovery, journals and backups. Bind
explicit owner consent to the exact listing and selected content, and use a
trusted profile revision that accounts for external edits and restart, or
reconfirm the exact content at delivery with an equivalent reviewed guarantee.
Review the file-reading boundary and prevent an unguarded send on every failure
or recovery path. Test changes and reversions of profile, owner, session and
route; delayed replies; stale listings; cancellation; interrupted sends; and
absence of plaintext from every storage surface covered by the chosen policy.
No profile values should be sent to a model without the owner's authorized
scope. These requirements do not authorize reading production memory.
