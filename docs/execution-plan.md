# Sherpa execution plan

Build a GitHub App reviewer through V4 in a pnpm TypeScript monorepo. One deployable Worker exports the webhook handler, review Workflow, a per-PR SQLite Durable Object ledger, and the isolated Sandbox class. Packages separate schemas, GitHub, repository tools, providers, review agents, and orchestration.

1. V0: validate signed webhooks, scope installation tokens, durably start a deterministic review job, retrieve the PR, run one validated reviewer, map changed lines, and publish once. Verify an automated round trip before enabling later stages.
2. V1: clone immutable commits in an isolated Sandbox, expose bounded tools, obtain incremental changes, and opt into bounded project validation. Credentials stay in trusted Workers; never expose arbitrary model shell commands.
3. V2: concurrently run relevant specialists through a shared provider contract. Isolate malformed responses and provider failures.
4. V3: deduplicate and arbitrate evidence, support narrow context retrieval, and publish only actionable accepted findings.
5. V4: add path/risk routing, hard service budget ceilings, cost accounting, trusted-base repository config, incremental checkpoints, and repeat-comment suppression.
6. Independently review architecture, security, reliability, cost, and comment quality; fix issues and run formatting, lint, typecheck, tests, and deployment bundle validation.

Independent workstreams: GitHub integration; Sandbox/runtime tools; AI providers/routing/specialists/judge. Parent owns shared contracts, Worker/Workflow, durable ledger, integration tests, docs, and final review.

Security decisions: read repository policy at the base SHA, not the untrusted PR HEAD; no PATs; no repository instructions become system instructions; no model-selected URLs, credentials, or raw commands; no automatic execution of repository scripts by default. Network access and Git credentials are restricted to the exact installation/repository and provisioning phase. Never serialize credentials into Workflow step results.

Publication uses a durable reservation and a stable marker. On an ambiguous GitHub write, reconcile against reviews; never blindly retry a non-idempotent write. Only a published complete review advances the incremental baseline. Refresh the live PR head before publishing and discard stale runs.

Live acceptance requires a configured GitHub App installation, model credentials, and Cloudflare deployment. Keep that verification separate from mocked end-to-end and local runtime evidence.
