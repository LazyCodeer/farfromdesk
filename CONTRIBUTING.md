# Contributing to Sidekick

Sidekick is a private preview. Repository access does not grant a redistribution license. Read the README, security policy and relevant adapter before changing behavior.

## Local workflow

1. Install the README prerequisites and run `npm ci`.
2. Create a focused branch from `main`.
3. Make a small, reviewable change with tests for behavioral fixes.
4. Run `npm run check`, `npm test`, and native tests for Swift changes.
5. Explain the problem, resulting behavior, validation, and remaining limitations in your pull request.

## Engineering rules

- Preserve native approvals and exact session identity. Do not copy model credentials or bypass account limits.
- Keep transport acceptance separate from actual agent completion.
- Never automatically replay an uncertain consequential request.
- Preserve pairing, selected sessions and durable request state during migrations.
- Use synthetic fixtures. Do not commit real chat history, audio notes, tokens or screenshots with private data.
- Keep protocol/storage names compatible during cosmetic renames.
- Test with a dedicated fixture session. Do not send messages to unrelated chats.
- Keep UI changes accessible and support reduced motion where animation is introduced.

## Reporting issues

Use the bug template with sanitized reproduction steps and versions. Describe whether a result is local, simulated, installed, or verified from a real phone. For security reports, follow SECURITY.md instead of a public issue.

## Scope

Provider compatibility, recovery, onboarding, accessibility, and performance are useful areas to improve. Discuss a new dependency or adapter before a large implementation. Never add speculative claims to documentation or mark planned functionality as shipped.
