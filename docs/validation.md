# Validation record

The build was checked locally on September 14, 2026. This record distinguishes deterministic tests from a live installed GitHub App review.

## Verified

- GitHub package tests cover signature validation, accepted/ignored events, RSA App JWT signing, installation scope, changed-line mapping, own-bot markers, bounded API data and one-shot publication.
- Real local Git tests cover immutable file reads, symlinks/traversal, search, incremental SHAs, force-push fallback, stale commits and malformed/large outputs. The actual Python subprocess supervisor is exercised for output and time limits.
- Provider/Gateway tests cover a single Cloudflare credential for GPT/Claude/Workers AI catalog requests, fixed origins, sanitized failures, content logging/cache controls, validated model/usage responses, no native-key forwarding, and charged bounded retries.
- Model budgets cover concurrent reservations, USD/call/deadline ceilings, cached token pricing, unknown prices, failed-request reservations and final-judge reserves.
- Ledger/dispatch tests cover exclusive leases, idempotent claims after lost replies, bounded persisted data, one-time analysis reservations, partial coverage baselines, uncertain publication, read-only recovery without rewinding a newer baseline, and safe recovery-workflow restarts.
- The complete signed webhook → hypothesis analysis → repository verification → independent judge → GitHub path passes with mocked external APIs. Tests also verify stale-head discard, malformed-model failure, publication reconciliation, preserved priority presentation, and PR prose withheld from initial code analysis.
- Wrangler generated runtime/binding types and successfully built the Worker and matching Sandbox container in a deployment dry run. Nothing was deployed.
- The local Wrangler runtime started successfully. `GET /health` returned `200` with Sherpa liveness; the unconfigured webhook returned `503 WEBHOOK_NOT_CONFIGURED` as intended.
- The container image started with Node.js, Git and Python available. Its nested Bubblewrap check failed closed because the local Docker runtime disallows unprivileged namespace creation. Optional project scripts therefore cannot be claimed as passing in this environment.

## Review and fixes

Independent architecture, security, reliability and cost passes identified and fixed oversized Workflow state; weak publication recovery; replayed analysis budgets; queue/lease timing; full-Git-patch versus API-patch incompatibility; incomplete documentation-only skips; excessive finding deduplication; suppression of reintroduced defects; silent judge-context truncation; unsafe suggested fixes; and false passing outcomes when inline comments are disabled.

The AI Gateway adapter was separately checked against Cloudflare's current REST and authentication documentation. It needs one Cloudflare token with Account → Workers AI → Read; AI-Gateway-management-only permission does not authorize this inference endpoint. Third-party models use Unified Billing. Workers AI catalog models work with the same token, but prepaid-credit behavior must be verified for the selected endpoint/billing settings.

## Hypothesis-driven review rewrite

The starting full suite passed 162 tests. The old prompts and orchestration are frozen with SHA-256 hashes under `tests/evals/baseline/`. Discovery now produces narrow hypotheses without severity or priority; specialist and judge confirmations require successful executor-owned source, baseline and disproof citations. A separate judge investigation precedes final classification.

Independent review found and fixed policy files incorrectly treated as skippable documentation, scoped read ranges incorrectly marked truncated, missing new-file absence attestations, rename baseline paths, lost deletion-only authorization bugs, reintroduced guard deletions incorrectly deduplicated, unusable adaptive source reads, cross-candidate policy mixing, and one invalid candidate discarding unrelated valid findings. Prompts were revised again to reject test-coverage filler and require successful caught-exception reproduction observations.

The final full suite passes 236 tests; four opt-in Docker tests and the deferred live model test are skipped in that command. The four Docker acceptance tests pass when run separately with the built image. `pnpm eval` passes 82 local tests; its live model test is intentionally skipped. Lint, formatting, type checking, and the Worker/container deployment dry run pass. The paired six-trace adversarial replay retains all three supported bugs (the baseline misses the deletion-only guard) and blocks three deliberately fabricated evidence traces which the baseline publishes. Those invalid traces become incomplete reviews, not approvals. This demonstrates protocol enforcement and a repaired anchor gap, not measured model reasoning quality. See [evaluation design and limitations](evaluations.md).

The Docker image contains Semgrep 1.177.0, service-owned rules and checksum-pinned Bubblewrap 0.12.0. A real Semgrep execution detects the vulnerable Python fixture. OSV dependency tests validate exact npm lockfile v2/v3 coordinates, fixed API origin, bounded response processing and advisory-ID-only evidence; no advisory identifier automatically becomes a finding. Generated reproduction source uses disposable immutable snapshots and opt-in execution, with explicit failure where nested namespaces are unavailable.

## Installed App troubleshooting, September 14

The initial validation above preceded deployment. The user subsequently deployed Sherpa, installed its GitHub App, saved an installation gateway, and received real incomplete-review comments. Those runs exposed repository-access failures and invalid specialist output. Gateway response bodies were unavailable because Sherpa disables payload logging; the exact invalid field in those historical responses could not be recovered.

A real local Wrangler/Sandbox 0.12.9 run reproduced Git's `gnutls_handshake()` failure before the trusted HTTPS outbound handler ran. Using the internal HTTP proxy hop with mandatory HTTPS forwarding then fetched `marcialc/sherpa` PR #2, verified head `20ab1819b86719a345abbc5d11c5b7821c98ebb2`, found its merge base, checked out the head, and returned the changed `packages/github/src/oauth.ts` diff. This used the actual container, ContainerProxy, and GitHub App installation authentication; no model calls or PR writes were made by this probe.

Regression tests cover HTTP/HTTPS Git discovery and POST-body forwarding to HTTPS, repository/host/method/phase restrictions, and credential/header handling. Model tests cover a single format correction, original-schema enforcement, bounded diagnostic paths, usage accounting, and judge reserves. Protocol replay repairs a missing specialist reason while still rejecting fabricated evidence; an attested authorization regression still reaches Must Fix. These are deterministic protocol tests, not a measured improvement in model reasoning.

After these fixes, the full suite passes 286 tests with five opt-in tests skipped. `pnpm eval` passes 84 local checks with the paid test skipped. Lint, type checking, formatting, and the Worker/container deployment dry run pass. The public-PR sandbox probe above is additional runtime evidence; private/fork repositories and the production proxy still require live acceptance.

## Live acceptance still required

The user explicitly deferred the live before/after model evaluation. Its runner is ready as `pnpm eval:live`; configure gateway/model/pricing values and an explicit comparison spend cap when resuming. A complete deployed review after the runtime fixes still needs to be verified.

That run must confirm actual outbound Git credential interception, private/fork PR fetching, workflow/container lifecycle, model output compatibility/quality, valid real inline comments, redelivery behavior, incremental fixes and gateway usage accounting. Verify nested script isolation on the deployed container before enabling project validation; leave it disabled where the runtime does not support it.

## Repository index foundation, September 15

Repository indexing is implemented with scoped D1 metadata/postings, immutable revision membership, fenced atomic publication, JS/TS AST extraction, bounded installation-Gateway summaries, default-branch push updates and independent PR bootstraps. Discovery hints remain outside executor evidence and judge inputs.

Validation completed:

- `pnpm exec vitest run --maxWorkers 4`: 455 passed, five opt-in tests skipped, across 38 files. The first unrestricted `pnpm test` run timed out in an existing real-Git sandbox test; the bounded-concurrency full rerun passed.
- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, and `git diff --check`: passed.
- `pnpm typegen`: generated the D1 and indexing Workflow bindings.
- Local `wrangler d1 migrations apply`: all eight migration statements applied successfully.
- `pnpm build`: Worker/container deployment dry run passed; Worker gzip bundle approximately 2.1 MiB.
- `pnpm test:index-runtime`: actual local workerd parsed TypeScript, staged/published D1 metadata and retrieved an exact path/symbol. This exposed and fixed the compiler's bundled CommonJS filename initialization; Wrangler now supplies virtual filename/directory defines.

New tests exercise source filtering/malformed input, bounded summaries, immutable GitHub blobs, incremental modifications/additions/deletions/renames, interrupted/idempotent builds, expired writers, bootstrap races, version upgrades, tenant isolation, ranking, nested ignore patterns, stale-context exclusion, model failures and logging privacy. Reviewer regressions retain actual HEAD/baseline investigations, reject specialist/judge index-only citations, and prevent index-influenced routing from removing deterministic reviewers.

No production database migration, deployment, GitHub review publication or paid model acceptance was performed for this feature. Before rollout, provision/migrate remote D1, enable Push webhooks and run a private-repository push/PR smoke test. Embeddings and cross-repository retrieval remain outside v1.
