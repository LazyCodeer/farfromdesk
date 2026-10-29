# Errand mission foundation

This is not a working job-search feature. Nothing here is connected to the
router, session tools, WhatsApp, the F3 contract UI, or a document sender.
There is no production evidence verifier, public-web search provider, automatic
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
  source, link, title, availability and request ownership; use bounded
  responses/timeouts, protect against private-network targets/DNS rebinding,
  revalidate each redirect, and record source/attempt provenance. No such
  adapter exists in this branch, so real shortlists must not be delivered.
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
- The ledger rejects a few recognizable credential patterns in criteria and
  snippets as defense in depth. This is not comprehensive secret detection:
  the future verifier must ensure it supplies only public listing content, and
  the profile adapter must send only the owner's intentionally shared criteria.
- Every async transition rechecks the owner, destination, exact binding and
  native identity, contract authority, mission version and state. Results are
  discarded on cancellation or changed scope. Shortlist entries expire after
  24 hours. A later `draft N` requires a new authenticated owner request in the
  same owner/chat and a trusted check of the original approved contract.
- The `publicListingUrl` lexical check rejects local names, literal IPs,
  credentials, private-looking query parameters and non-HTTPS URLs. It does not
  resolve DNS or prevent rebinding and must not be used alone to fetch a URL.

## Work still required

Implement a safe, genuinely independent search and listing verification source,
the F3-approved contract and scoped profile adapter, Wonder's useful grounded
fit assessment, a usable tailored document with no fabricated qualifications,
WhatsApp shortlist and delivery, and an owner-controlled application-opening
flow. Re-review all source ingestion, profile handling, cancellation, account
changes, prompt injection and the prohibition on submitting or sending. A real
shortlist with working links and a useful draft must be demonstrated before
calling F6 complete.
