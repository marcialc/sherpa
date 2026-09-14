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

## Live acceptance still required

No production Cloudflare deployment, paid model request, GitHub App installation or real PR comment was performed. The user explicitly deferred the live before/after model evaluation. Its runner is ready as `pnpm eval:live`; configure gateway/model/pricing values and an explicit comparison spend cap when resuming. Configure GitHub App secrets separately before following the README's first-real-review procedure on an installed private test repository.

That run must confirm actual outbound Git credential interception, private/fork PR fetching, workflow/container lifecycle, model output compatibility/quality, valid real inline comments, redelivery behavior, incremental fixes and gateway usage accounting. Verify nested script isolation on the deployed container before enabling project validation; leave it disabled where the runtime does not support it.
