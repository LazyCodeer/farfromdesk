# Errand mission foundation

This is not a working job-search feature. Nothing here is connected to the
router, session tools, WhatsApp, the F3 contract UI, or a document sender.
There is no integrated production evidence verifier, public-web search provider, automatic
browser navigation, application opener or submit action. A selected page is
not by itself proof of a current job listing or a working query-stripped URL.

The ledger supports a scoped approved mission, a bounded source-verifier seam,
an immutable numbered shortlist and a local draft. It does not submit forms,
sign in, enter a password or personal ID, contact anyone, make purchases, or
send a message. The draft is an intentionally generic starting point and is not
yet the tailored document required by the approved plan.

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
  adapter is integrated, so real shortlists must not be delivered.
- `errand-greenhouse.ts` is an isolated, unwired source for exact Greenhouse
  board and job IDs, not a search provider. It independently checks the fixed
  Greenhouse API and the matching public listing URL, and returns a distinct
  published-listing evidence type with application availability unverified.
  It requires an explicit future deadline, and rejects recognizable closed
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
  service and needs a trusted request-bound ID source and authority adapter
  before use. API or page changes, redirects and links with query
  parameters fail closed. The generic API and page checks are not proof that a
  job matches the owner's criteria.
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
  discarded on cancellation or changed scope. Shortlist entries expire after
  24 hours or at their explicit deadline, including after ranking completes.
  Shortlists state that page identity and application availability are
  unverified. A later `draft N` requires the
  exact text of a new top-level authenticated owner request in the same
  owner/chat and a trusted check of the original approved contract.
- Draft selection also requires a bridge-owned ingress ordering proof for the
  authenticated owner message and the exact delivered shortlist. No such
  adapter exists here: selection fails closed by default. `inbox.received_at`
  is set after asynchronous routing and must never be used as ingress time.
  The future adapter must durably capture order before any async work, and
  prove the selected shortlist was delivered before the owner sent the reply.
- Expired evidence requires a new owner request and a new mission. Existing
  missions cannot be reset or reused. A draft claim and its local result are
  committed together and a repeated identical request recovers that result;
  a future sender must still atomically queue delivery or make it idempotent.
  A dispatched owner job marked uncertain during bridge recovery is not an
  active request here, so its saved draft cannot yet be recovered through this
  API. Design and test that recovery before connecting delivery.
- The `publicListingUrl` lexical check rejects local names, literal IPs,
  known credential patterns, queries, fragments and non-HTTPS URLs. It does
  not silently strip a query and claim the result works. It does not resolve
  DNS or prevent rebinding and must not be used alone to fetch a URL. Links
  requiring query parameters are currently unsupported.

## Work still required

Implement a safe, genuinely independent search and listing verification source,
the F3-approved contract and scoped profile adapter, Wonder's useful grounded
fit assessment, a usable tailored document with no fabricated qualifications,
WhatsApp shortlist and delivery, and an owner-controlled application-opening
flow. Re-review all source ingestion, profile handling, cancellation, account
changes, prompt injection and the prohibition on submitting or sending. A real
shortlist with working links and a useful draft must be demonstrated before
calling F6 complete.
