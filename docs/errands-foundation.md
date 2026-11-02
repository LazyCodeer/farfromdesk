# Errand mission foundation

This is an experimental WhatsApp-only Greenhouse workflow, not a general job
search. In a direct WhatsApp owner chat, a typed request can use `greenhouse jobs; board=example;
role=Engineer; location=Bangalore`, with optional `salary=`, `avoid=` or
`skills=Dart, Flutter` fields. Only skills explicitly supplied in that request
are used to annotate literal title mentions without changing the ranking.
Those mentions do not establish a requirement, qualification or fit.
The owner may list up to three distinct boards in `board=alpha,beta,gamma`.
It searches only those public boards, preserves F3 review when applicable, and
prepares an owner-only `.txt` draft document after a delivered shortlist and a reply with
the displayed code, for example `draft 2 1a2b3c4d`. A bare `draft 2` works only
while exactly one shortlist has been delivered in that owner chat.
There is no general web search, resume integration, automatic browser
navigation, application opener or submit action. A selected
page is not by itself proof of a current job listing or a working query-stripped URL.

The ledger supports a scoped approved mission, a bounded source-verifier seam,
an immutable numbered shortlist and a local draft. It does not submit forms,
sign in, enter a password or personal ID, contact anyone, make purchases, or
send a message. The draft names the selected listing, shows its public location
and page-title employer label when available, and asks the owner to choose a
responsibility and add a verified example. Those source labels do not establish
eligibility or independently verify the employer. At draft selection, it can add
up to three verbatim, owner-attributed About-you lines with independently recorded
direct-text provenance. It does not copy the stated skill terms into the draft.
The existing bridge persists the owner's typed request and criteria, and the
normal owner-only outbox and draft claim retain selected profile notes.

## Trust boundaries

- Before exposing any route, create a bridge-owned F3 authority adapter that
  rechecks the exact root contract and current authenticated owner request,
  destination, coordinator binding, native session and route. Never let the
  caller supply a boolean saying a contract or identity is approved. Legacy
  records without owner provenance must fail closed. The current Store origin
  path is WhatsApp-only; do not advertise Telegram support.
- A `VerifiedListingReader` is a trust boundary, not an implementation of
  verification. A session report, user-supplied URL, model response, HTTP 200,
  matching title, or `public-listing-verified` string alone is not proof. A
  future trusted adapter must independently check the exact current public job
  source, link, title and request ownership and state what availability is
  known; use bounded
  responses/timeouts, protect against private-network targets/DNS rebinding,
  revalidate each redirect, and record source/attempt provenance. No such
  adapter has been validated live end-to-end, so do not release this workflow.
- `errand-greenhouse.ts` is an experimental source for exact Greenhouse
  board and job IDs, plus a board-local search. It independently checks the fixed
  Greenhouse API and the matching public listing URL, and returns a distinct
  published-listing evidence type with application availability unverified.
  It accepts a valid future deadline or an absent deadline, and rejects recognizable closed
  or removed notices. It also parses a narrow observed layout requiring a
  matching og:url, title, heading and form metadata, ignoring script, comment
  and inert SVG, template and textarea content. One saved public sample matched
  offline; this observed layout is not an official contract, and the
  recognizer uses pinned MIT-licensed parse5 and its entities dependency,
  rejects common inline hidden markers on evidence and ancestors, and caps
  input size, traversed nodes, nesting and captured text. Static parsing does
  not prove visibility under CSS or scripts, or that applications remain open.
  Unknown markup fails closed; page identity
  remains labelled unverified until integration and live validation.
  It uses no credentials,
  accepts no query parameters, does not follow redirects, restricts hosts and
  pins a public IPv4 DNS answer for each bounded HTTPS request. It does not
  attest workplace mode, eligibility, salary or geographic restrictions. It
  has only offline synthetic tests, has not been verified against the live
  service end-to-end. API or page changes, redirects and links with query
  parameters fail closed. The generic API and page checks are not proof that a
  job matches the owner's criteria.
  The board search sends only the board identifiers and filters role and
  location locally. Across the selected boards it checks at most ten candidates,
  divided into fixed per-board quotas (5/5 or 4/3/3). Unused slots are not
  reassigned, and unverifiable candidates consume a slot. Failures propagate
  without returning a partial shortlist. The source operation has a 30-second
  overall limit and may time out on slow boards. It is not general internet search and does not verify salary or
  workplace eligibility. The separately stored public location is the API's
  field, not an inference from the owner's requested location; it does not
  establish geographic eligibility. The employer label is a bounded page-title
  suffix, not independently verified identity; unsafe labels are omitted.
  The Greenhouse [Job Board API documentation](https://developers.greenhouse.io/job-board.html)
  describes published jobs and includes an `application_deadline` field. A
  published listing or future or absent deadline does not establish that it is
  still accepting applications, and matching HTML text cannot resolve that
  question. Do not infer an open status from an undocumented field. The
  documentation was not fetched during the offline tests.
- `existingTabListingReader` only reads tabs already selected for the exact
  browser request scope. It returns `selected-page` observations, deliberately
  not `public-listing-verified` listings. BrowserTabs strips URL queries, so a
  second independently verified link is needed. The adapter hashes visible
  page text but forwards/stores only the title, not the full page text. Page
  data is untrusted and never authorizes anything.
- The Wonder ranker receives only approved role/location/optional salary and
  exclusion criteria plus bounded candidate title and excerpt. The model may
  only return existing IDs; duplicate or invented IDs fail closed. Web text is
  untrusted. Displayed reasons are generated locally from exact text matches,
  not model claims. This is not a reliable salary/eligibility check and does
  not yet use a resume or justify an application.
- The owner can explicitly enter up to five short skill terms in the same
  request. These terms are not sent as a separate field to the Greenhouse
  source or ranking model, although listing text sent to the ranker can contain
  the same words. If F3 review is enabled, its existing Meta interpretation
  receives the whole typed request, including these terms. No profile is sent
  to the ranker. A literal title mention may be negated or irrelevant; it
  does not change candidate order or establish the owner's qualifications.
- On an authenticated direct `draft N`, the profile reader uses a bounded,
  no-follow file read and selects only whole lines matching owner-supplied role
  or skill terms. Each line must trace through continuous About-you history to
  an exact complete direct typed owner message with the current owner generation.
  Model paraphrases, voice, forwarded content, local-editor writes, old messages
  without ingress provenance and ambiguous duplicate lines are omitted. No new
  owner confirmation is requested. The draft labels the notes as unverified,
  preserves them in a code block, and never turns them into claims. It stores
  those notes in the normal guarded owner-only draft and outbox; they are not
  sent to Meta for ranking. Direct-text ingress records a body hash, owner
  generation and first-ingress eligibility to prevent replay from laundering
  forwarded or group text. Completed turns that did not write About-you have
  this record removed, including on restart; interrupted turns and memory-writing
  turns retain it. Deletion does not erase WAL, free pages or backups, and these
  hashes are not a privacy boundary. A changed file, history or authorized-line set
  invalidates a queued draft on the next delivery check. File metadata and
  content checks are best-effort, not a guaranteed monotonic external-edit log;
  a rapid change-and-revert on a coarse filesystem or directory swap can be
  missed. Windows currently falls back to a generic draft. The reader considers
  at most 64 candidate lines and 500 history entries; missing provenance also
  produces a generic draft. These constraints need live validation and review.
- Exclusions currently support only `onsite`, `on-site` or `on site` (with an
  optional no/avoid/exclude prefix). Only a trusted independently verified
  `remote-only` workplace attestation qualifies; onsite, hybrid and unknown
  fail closed. Excerpts, sessions and models may not mint the attestation. It
  must be bound to the exact source/listing hash and request, and regional
  restrictions require independent verification. No such verifier exists yet.
  Other exclusion wording fails closed; this is not a general language
  understanding or salary verification system.
- The ledger rejects a few recognizable credential patterns in criteria and
  snippets as defense in depth. This is not comprehensive secret detection:
  the future verifier must ensure it supplies only public listing content, and
  the profile adapter must send only the owner's intentionally shared criteria.
- Every async transition rechecks the owner, destination, exact binding and
  native identity, contract authority, mission version and state. Results are
  discarded on cancellation or changed scope. Durable generation markers also
  invalidate in-flight work when the owner, session or route changes and then
  changes back. Shortlist entries expire after 24 hours or at their explicit
  deadline, including after ranking completes. Listings without a deadline
  are labelled and expire after one hour; their availability is unverified.
  Shortlists state that page identity and application availability are
  unverified. A later `draft N` requires the
  exact text of a new top-level authenticated owner request in the same
  owner/chat and a trusted check of the original approved contract.
  Search, shortlist and draft output are limited to the direct owner chat;
  owned-group membership is not treated as proof of private delivery. A group
  gets only a fixed instruction to use the direct chat.
  The root owner-request body (including all selected boards) is bound to the
  mission. Root body, identity, destination, binding or unsafe status/outcome changes
  invalidate it even if the previous value is restored; legacy missions lacking
  this binding fail closed. If the root ID is changed and never restored, the
  moved inbox row needs manual recovery; guarded output remains blocked.
- Draft selection also requires a bridge-owned ingress ordering proof for the
  authenticated owner message and the exact delivered shortlist. An initial
  WhatsApp adapter captures a typed draft choice before async group checks,
  confirms the owner afterward, and records a participant-specific shortlist
  receipt in the same database sequence. Callback order does not prove when
  the owner authored or saw a message on another device. A later shortlist
  requires its displayed code, and an ambiguous code collision fails closed,
  so delayed bare replies cannot select a newer shortlist. Group
  aggregate ACK is not treated as an owner receipt. `inbox.received_at`
  is set after asynchronous routing and must never be used as ingress time.
  The future adapter must durably capture order before any async work, and
  prove the selected shortlist was delivered before the owner sent the reply.
- Expired evidence requires a new owner request and a new mission. Existing
  missions cannot be reset or reused. A draft claim and its local result are
  committed together and a repeated identical request recovers that result;
  a digest binds the draft to its selected listing snapshot at delivery. Older
  queued drafts without a snapshot digest fail closed and need a new request.
  The sender atomically queues delivery with the claim.
  A dispatched owner job marked uncertain during bridge recovery is not an
  active request here, so its saved draft cannot yet be recovered through this
  API. An interrupted document upload or relay is marked uncertain and is not
  automatically retried; the owner should check the chat before trying again.
  If the guard itself is missing, recovery settles a matching request but cannot
  safely send its usual owner notice.
- The draft document is encrypted and uploaded before a synchronous recheck of
  the exact outbox row, owner, socket, mission, listing and applicable profile
  revision immediately before relay. A changed guard or scope blocks relay.
  A crash or failure after the send is claimed is treated as uncertain. WhatsApp
  automatic retry lookup excludes errand messages, and the socket disables its
  in-memory recent-message retry cache; ordinary messages use persisted retry
  lookup. This can reduce retry availability for messages absent from storage.
  Synthetic tests exercise this boundary; real transport remains unvalidated.
- The `publicListingUrl` lexical check rejects local names, literal IPs,
  known credential patterns, queries, fragments and non-HTTPS URLs. It does
  not silently strip a query and claim the result works. It does not resolve
  DNS or prevent rebinding and must not be used alone to fetch a URL. Links
  requiring query parameters are currently unsupported.

## Work still required

The independent review of the unwired profile prototype is in
[errand-profile-review.md](errand-profile-review.md).

Implement general search and a live-validated listing verification source,
profile-grounded fit assessment, further document tailoring without fabricated
qualifications, and an owner-controlled application-opening flow. Re-review
all source ingestion, profile handling, cancellation, account
changes, prompt injection and the prohibition on submitting or sending. A real
shortlist with working links and a useful draft must be demonstrated before
calling F6 complete.
