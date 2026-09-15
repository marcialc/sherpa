# Architecture and engineering decisions

## Durable orchestration

The webhook Worker verifies HMAC over the exact bounded body, validates GitHub's event shape, and creates a deterministic Workflow ID from installation/repository/PR/base/head. Re-running the Sherpa check or its check suite from GitHub is a new job: that ID also includes the delivery so a completed commit can be reviewed again without colliding with the original Workflow. It never performs repository or model work in the request. A failed create is only treated as duplicate when an existing Workflow can be confirmed.

Workflows own long-running execution and checkpoint trusted configuration, analysis, and publication. Read stages use limited exponential retries. Analysis and publication have no automatic stage retries: replaying paid calls or non-idempotent writes can be costly or duplicate comments. A durable analysis reservation also prevents a crashed, uncheckpointed analysis from starting paid calls again; such a run fails closed. Checkpoint outputs contain bounded review data, never tokens or private keys, and are marked sensitive.

A SQLite Durable Object per installation/repository/PR serializes reviews with an expiring ownership token. Stale owners cannot publish. A completed review stores the incremental SHA, cost and bounded finding history. Coverage failures do not advance that SHA. The ledger uses synchronous transactional transitions and survives Worker eviction.

GitHub does not provide an idempotency key for review creation. Sherpa records a publication reservation, checks an own-App bot marker, and sends one POST pinned to the reviewed commit. Lost responses enter read-only reconciliation. A redelivery for an errored/terminated instance starts a separate recovery Workflow which can only reconcile existing reviews. It restores confirmed dedupe information without moving a newer incremental checkpoint backwards. Absence in a GET cannot prove that a timed-out POST will never arrive, so unresolved attempts do not get another automatic POST. A final head refresh minimizes the unavoidable race with a concurrent push.

## Repository isolation and tools

Each analysis gets a fresh Sandbox with an unpredictable attempt suffix. The trusted Sandbox Durable Object binds it to one validated repository/installation and a short preparation phase. The outbound handler only authorizes exact smart-Git endpoints for that repository, adds a scoped installation token outside the container, rejects redirects, and disables Git access after preparation. Ordinary review has closed network access.

Git uses HTTP only for the internal container-to-ContainerProxy hop. The handler rewrites authorized Git requests to HTTPS before adding authentication and forwarding to GitHub. This follows Cloudflare's internal HTTP proxy pattern and avoids the Git TLS interception handshake failure reproduced with Sandbox 0.12.9. Direct Internet access stays disabled; the container never receives the installation token. HTTP requests to package registries remain denied.

Git fetches the base repository's `refs/pull/N/head`, so fork PRs need no installation on the contributor fork. The fetched commit must match the webhook SHA. The repository's Git object database is separated from the working tree; tools read immutable Git objects instead of following filesystem symlinks. Hooks, external Git protocols/diff drivers, credential helpers, and redirects are disabled.

Models select validated tool objects, not command strings. The implementation builds argv vectors for reads, literal search, references, diff/show/log, and configured validation. A Python subprocess supervisor bounds bytes and time before returning results and kills runaway process groups. Paths, revisions, query sizes, output envelopes and validation scripts have separate limits.

Repository tests and configuration are executable untrusted code. They require a service flag plus trusted-base repository opt-in, execute inside a nested network/process sandbox, and cannot access the immutable Git data or Sandbox control API. Dependency installation has registry-only egress and disabled hooks/lifecycle scripts. Unsupported tooling or namespace support fails closed. No cache is shared across installations.

## Routing, specialists, and judge

The router starts with deterministic path and change-size risk. Low-risk changes use the cheap reviewer; relevant changes select correctness, security, performance, testing and types reviewers. Explicit base policy can add path-specific agents. Optional cheap classification only adds assignments, so prompt injection cannot downgrade security routing.

At most three specialists run concurrently. ANALYZE sees code before PR title/description and proposes at most three narrowly scoped hypotheses, with no severity, priority or finding output. Each hypothesis names a trigger, actual/expected behavior, impact, PR causality and a concrete counter-explanation. The executor reads surrounding immutable HEAD and incremental baseline code, then executes the proposed investigation. VERIFY must reject the hypothesis or support every claim with citations to those actual tool results. One adaptive retrieval round is available. Zero hypotheses or zero confirmed issues is a valid result.

Evidence IDs, hypothesis ownership, immutable revisions, file-absence attestations and tool status come from the executor. Exact quotes must occur in successful, complete results; a model cannot manufacture evidence by writing an ID or claiming that it ran a test. Added-line anchors require literal HEAD code. Deletion regressions can use unchanged RIGHT context in the same complete deletion hunk, with the removed code cited from baseline. A wholly removed file has no invented RIGHT anchor and is reported as incomplete coverage. Final deduplication combines path, category, evidence and semantics; reintroduced guard deletions are not suppressed merely because the unchanged operation existed at baseline.

Every candidate starts UNVERIFIED for the independent judge. It reads its own HEAD/baseline evidence, requests a disproof investigation for each candidate, and only then reaches DECIDE. It checks truth, realistic trigger, meaningful impact, causality, surrounding context, mitigations, duplication, anchor and engineer usefulness. Decisions are ACCEPT, REJECT, MERGE or NEEDS_MORE_CONTEXT (lowercase wire values). One final adaptive retrieval round is available; unresolved context cannot yield approval. Semantic failure in one candidate does not erase independent valid findings; incomplete coverage remains visible.

Only accepted issues receive technical severity and developer-facing priority. Must Fix and Should Fix require a verified safe concrete action. Every category requires a real, scoped problem: unsupported findings cannot be salvaged as warnings or nits, and missing coverage alone is not a testing finding. The configured confidence and non-blocking severity thresholds apply after judgment. No model-selected URLs, arbitrary shell, or external messaging tool is exposed.

The merge verdict is calculated deterministically from judge-accepted final priorities: any Must Fix means Not Approved; otherwise any Should Fix, Warning, or Nit means Approved With Comments; otherwise Approved. GitHub events are REQUEST_CHANGES, COMMENT, and APPROVE respectively. Existing internal outcomes (NEEDS_ATTENTION, PASS_WITH_FINDINGS, PASS) remain ledger values; they are never used as developer-facing labels. REVIEW_FAILED and incomplete coverage cannot issue approval. All accepted blockers survive presentation limits; non-blocking groups have configurable limits (5/3/3 by default). Counts include all accepted findings and disclose omissions. Inline comments and summary entries use the same priority labels. Operational diagnostics are shown separately from findings.

Repository/model/tool text remains untrusted data in model user messages. Only explicitly enrolled policy from the immutable BASE commit enters the separate trusted-instructions section; matching path/domain rules are selected for each call. HEAD changes cannot weaken their own review. Trusted prompts reject instructions embedded in code, comments, README, unenrolled AGENTS.md, docs, diffs, PR prose, commits, issues, branches, tests and scanner output. Runtime tool restrictions and budget checks enforce capabilities independently of prompt text. See [review policy](review-policy.md) and [evaluation design](evaluations.md).

## Budgets and observability

Each GitHub App installation supplies its own Cloudflare AI Gateway (account ID, gateway name, API token) through an OAuth setup page. Reviews fail closed with no model or Sandbox work when that installation has no Gateway. Operator Worker secrets are not used as a fallback. Tokens live only in the per-installation Durable Object and are loaded inside the analysis step; they are never checkpointed. Qualified catalog model IDs select the actual upstream model. Gateway content logging, caching and automatic retries are disabled on review calls. Provider adapters fix origins, validate JSON and token usage, bound streamed response sizes, and use abort deadlines. Prices are supplied by the operator as a service cap. The shared budget reserves an upper bound before every physical request, including retries, so concurrent specialists cannot spend the same balance. It preserves capacity for a final judge and prevents unknown-price calls. Failed requests are conservatively charged their reservation because remote work may have completed.

Review cost records provider, model, agent, input/output/cache tokens when available, estimated USD and duration. Accounting uncertainty stops additional paid calls without exposing a fabricated free total. Cloudflare infrastructure cost is separate from model estimates.

Structured logs contain a review ID and bounded operational metadata, not repository contents, model responses, tokens or raw exception messages. Review summaries disclose incomplete coverage without posting internal traces. Detailed results live in the private Workflow/ledger state, which must only be accessible to authorized service operators.

Each review invocation includes a JSON Schema generated from its local response validator in the trusted system prompt. It describes required fields, named object properties, tool variants and bounds; decision refinements, tool policy and evidence attestation remain separate local checks. This is prompt guidance, not provider-enforced structured output. The schema text is included in the existing input and cost reservations.

Invalid model JSON or schema output emits `review.model_invalid_output` with the agent, phase, model, invocation/attempt IDs, token/byte counts and up to six schema details: field paths, codes, expected/received types and size bounds. Arbitrary record keys, raw messages and all values are omitted. Model request lifecycle and tool completion events share review/run IDs; tools report policy failures, source/context truncation and executor-owned evidence IDs without paths, queries or output. Events use structured objects and warning/error levels for operational failures; diagnostic sink exceptions cannot change engine execution. One format correction is allowed per invocation, subject to the same cost, call, input-size, deadline and judge reserves. Corrections receive the same schema and bounded validation details, including expected types, rather than only error codes. The original response stays untrusted user data. Corrected output must pass the original strict schema and all subsequent evidence checks; repeated invalid output fails the review step.

## Operational boundaries

This implementation supports GitHub.com. Enterprise API origins, broad monorepo build orchestration, Stripe/usage invoices, and custom scanners are separate product work. The configured Sandbox performs supported root-project checks and static scans; it does not claim support for every language, package manager version or build environment.

Diff, file-count, history, command, context and comment limits are intentional resource boundaries. Exceeding them produces incomplete coverage rather than a false assertion of a clean repository. Live GitHub/Cloudflare integration and model quality require deployment and representative PR evaluation; mock tests establish deterministic behavior, not provider reasoning quality.

## API references

- [Cloudflare Workflows rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Sandbox outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)
- [Sandbox Git workflows](https://developers.cloudflare.com/sandbox/guides/git-workflows/)
- [Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [GitHub installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [GitHub pull request reviews](https://docs.github.com/en/rest/pulls/reviews)
- [OpenAI chat API](https://developers.openai.com/api/reference/resources/chat)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Moonshot/Kimi chat API](https://platform.kimi.ai/docs/api/chat)
