# Next release: optional macOS desktop control

Base: published v0.7.8. Release history currently makes the next version v0.7.9; the planner checks again at build time.

User-visible changes:

- Choose apps and browser windows from discovery results.
- Create, select, navigate and close tabs in an existing selected window.
- Read selected windows/pages using Accessibility.
- Reuse known Gemini/Claude controls for authorized tasks, with separate drafting and sending.
- Opt in, review native permissions and stop/disable from Settings.

Release gates:

- Backend, HTTP, widget and release tooling checks pass on the isolated release branch.
- All four native jobs and packaged startup checks pass before stable publication.
- Driver hashes, original vendor signature and notices survive packaging.
- The actual FarFromDesk host receives its own OS grants for live app-action validation; lab grants are not integration approval.

Comet was live-tested in the lab. Other Chromium adapters need compatibility validation. Safari/Firefox direct-tab actions, visual-model planning and unattended arbitrary-app reliability are not claimed. Ad-hoc signing and permission reapproval remain documented limitations.

The owner has requested publication after the release gates pass. Main remains owner-controlled; repository protection is not changed by this feature.
