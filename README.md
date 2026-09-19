<p align="center">
  <img src="logo.png" alt="Sherpa, a mountain guide holding a code review checklist" width="180" />
</p>

<h1 align="center">Sherpa</h1>

<p align="center">
  <strong>AI code review with evidence, not AI opinions.</strong><br />
  Open-source GitHub PR reviewer that investigates potential issues before commenting<br />
  and only lets verified <code>Must Fix</code> findings block approval.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0ea5e9" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/status-early_release-f59e0b" alt="Early release" />
  <a href="docs/self-hosting.md"><img src="https://img.shields.io/badge/host_on-Cloudflare-f38020" alt="Host on Cloudflare" /></a>
</p>

<p align="center">
  <a href="#quick-start"><strong>Get started</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/self-hosting.md"><strong>Self-host</strong></a>
  &nbsp;·&nbsp;
  <a href="#documentation"><strong>Documentation</strong></a>
</p>

<!-- TODO visual: 30–45s silent GIF of opening a PR, the Sherpa check running, then the posted GitHub review. -->
<!-- TODO visual: screenshot of a real GitHub review summary with verdict, Must Fix grouping, and an inline comment. -->

## Example review

This is the summary Sherpa posts on the pull request. Inline comments on changed lines use the same priority labels.

```markdown
## 🤖 AI Review

### ❌ Not Approved

**🔴 1 Must Fix**

Resolve the blocker before merging:

- Session deletion lacks ownership check

---

### 🔴 Must Fix

1. **Session deletion lacks ownership check** · `src/auth.ts:2`

   Another user's session can be deleted with its ID.

   > **Fix:** Compare the session owner to the authenticated user before deleting.
```

A completed review always has one of three verdicts: **Approved**, **Approved With Comments**, or **Not Approved**. Incomplete coverage is labeled **Review Incomplete** and never approves the PR.

## Why Sherpa

- **Investigation before comments.** A suspicious diff is a hypothesis, not a finding. Findings need executor-attested source reads and an independent judge.
- **Only `Must Fix` requests changes.** `Should Fix`, `Warning`, and `Nit` stay non-blocking.
- **GitHub-native output.** One review grouped by priority, plus a **Sherpa** check on the commit. Re-run that check to review the same commit again.
- **Repository context is a hint, not proof.** An optional JS/TS index can suggest where to look. It cannot justify a finding or a verdict.
- **Your AI bill.** Each GitHub App installation connects its own [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/). The host does not inject a fallback inference key.
- **Self-hostable.** MIT-licensed. Runs on Cloudflare Workers, Workflows, Durable Objects, Containers, and D1.

Sherpa helps with review. It does not replace tests, branch protection, or human judgment.

## How it works

1. GitHub sends a signed webhook for `opened`, `reopened`, `synchronize`, or a **Sherpa** check re-run.
2. A Cloudflare Workflow fetches the PR head in an isolated sandbox and reads immutable Git objects.
3. Path-based routing selects reviewers (correctness, security, performance, testing, types, or a lightweight pass). Documentation-only changes are skipped by default.
4. Optional indexed metadata may suggest related files. Those hints are untrusted discovery data.
5. Each specialist proposes at most three narrow hypotheses with no severity or priority.
6. The executor reads HEAD and baseline source, runs the requested investigation, and attests evidence IDs and quotes.
7. An independent judge reads its own evidence, attempts disproof, then accepts or rejects each candidate.
8. Accepted findings get a priority. The verdict is calculated locally: any `Must Fix` → Not Approved; other findings → Approved With Comments; none → Approved.

Draft PRs are skipped unless `.ai-reviewer.yml` sets `review.reviewDrafts: true`. Policy is loaded from the PR's **base** commit, so a PR cannot weaken its own review rules.

## Review severity

| Priority          | Meaning                                                | Blocks merge? |
| ----------------- | ------------------------------------------------------ | ------------- |
| 🔴 **Must Fix**   | Verified issue that should be resolved before merge.   | Yes           |
| 🟠 **Should Fix** | Worthwhile and concrete; safe to merge.                | No            |
| 🟡 **Warning**    | Stated assumption, compatibility, or operational risk. | No            |
| 🔵 **Nit**        | Optional, narrow improvement.                          | No            |

Must Fix and Should Fix require a verified, concrete action. Unsupported allegations are not published as warnings or nits. Missing test coverage alone is not a finding.

## Review outcomes

| Verdict                       | When                                       | GitHub event    | Sherpa check |
| ----------------------------- | ------------------------------------------ | --------------- | ------------ |
| ✅ **Approved**               | No accepted findings.                      | Approves the PR | Pass         |
| 🟡 **Approved With Comments** | Only non-blocking findings.                | Comment         | Pass         |
| ❌ **Not Approved**           | At least one verified Must Fix.            | Request changes | Fail         |
| ⚠️ **Review Incomplete**      | Coverage failed, and there is no Must Fix. | Comment         | Fail         |

If coverage is incomplete **and** a Must Fix was already confirmed, Sherpa still requests changes and says so. A failed or incomplete re-run does not dismiss an existing Request changes review.

Default display limits hide extra non-blocking items (`Should Fix` 5, `Warning` 3, `Nit` 3). Accepted Must Fix findings are never dropped from the summary.

## Architecture

```mermaid
flowchart TD
  PR[GitHub PR webhook] --> Worker[Cloudflare Worker]
  Push[Default-branch push] --> IndexWF[RepositoryIndexWorkflow]
  Worker --> ReviewWF[ReviewWorkflow]
  Worker -.->|bootstrap if needed| IndexWF
  ReviewWF --> Ledger[Review ledger DO]
  ReviewWF --> Settings[Installation settings DO]
  Settings --> Gateway[Installation AI Gateway]
  ReviewWF --> Sandbox[Repository sandbox]
  IndexWF --> D1[(D1 metadata index)]
  D1 -.->|discovery hints only| ReviewWF
  Sandbox --> Evidence[Executor-attested evidence]
  Gateway --> Specialists[Specialist reviewers]
  Specialists --> Judge[Independent judge]
  Evidence --> Judge
  Judge --> GitHub[GitHub review and Sherpa check]
```

<!-- TODO visual: replace the Mermaid diagram with a designed architecture image if GitHub rendering is not enough. -->

| Piece                       | Role                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| `apps/worker`               | Webhook, `/setup`, Workflows, Durable Objects, D1, sandbox container |
| `packages/agents`           | Routing, specialist investigation, judge, policy                     |
| `packages/github`           | App auth, PR fetch, review publication, checks                       |
| `packages/models`           | Cloudflare AI Gateway client, budgets, structured output             |
| `packages/sandbox`          | Isolated Git fetch and repository tools                              |
| `packages/repository-index` | JS/TS metadata index and retrieval                                   |
| `packages/workflow`         | Durable review pipeline and PR ledger                                |

The Worker never does model or repository work in the webhook request. Details: [architecture](docs/architecture.md).

## Quick start

Install a GitHub App on a host that already runs Sherpa, or deploy the Worker yourself.

| Goal                            | Start here                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Use an existing Sherpa host** | Get that host's GitHub App install link and setup URL, then follow **Install on a host** below.               |
| **Run your own Sherpa**         | Follow the [self-hosting guide](docs/self-hosting.md), then connect repositories with the same install steps. |
| **Explore the code**            | Clone the repo and run `pnpm test`. See [Development](#development).                                          |

People installing the App need GitHub access and their own Cloudflare AI Gateway. The host pays for Cloudflare compute and containers.

### Install on a host

#### 1. Install the GitHub App

Open the host's GitHub App install link. Choose the account or organization, then the repositories Sherpa should review.

GitHub then sends you to the host's setup page (`https://YOUR-SHERPA-HOST/setup`).

#### 2. Connect Cloudflare AI Gateway

In the [Cloudflare dashboard](https://dash.cloudflare.com/):

1. Create an [AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway), for example `sherpa`.
2. Enable gateway authentication and fund [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).
3. Create an API token with **Account → Workers AI → Read**, scoped to that account. This is the [inference permission](https://developers.cloudflare.com/ai-gateway/usage/rest-api/#authentication) Sherpa needs. AI Gateway management permission is not enough.

Keep these values:

| Field                 | Value                                      |
| --------------------- | ------------------------------------------ |
| Cloudflare account ID | 32-character account ID from the dashboard |
| AI Gateway name       | Exact gateway name, such as `sherpa`       |
| API token             | The Workers AI Read token                  |

The host chooses the models. Your gateway must support those catalog IDs.

On the setup page: sign in with GitHub, select the installation, enter the three values, and save. One gateway covers **every repository in that installation**.

**Connected** means the page shows “Gateway saved.” The first review is what actually checks the token, billing, and models.

#### 3. Open a pull request

Open a small **non-draft** pull request that changes code. Sherpa posts a check named **Sherpa** and then a review on that commit.

Pushing new commits reviews the new head, using the last completed review as an incremental baseline when that commit is an ancestor. Re-running the Sherpa check on the same commit updates the existing summary in place. If a completed re-run changes the merge decision, Sherpa posts one replacement review and then dismisses the previous one.

Draft PRs and ordinary documentation-only changes are skipped. Converting a draft to ready does not itself trigger a review; push a commit or reopen the PR.

### Cost

| Cost                               | Who pays                                                      |
| ---------------------------------- | ------------------------------------------------------------- |
| Model usage                        | The Cloudflare account saved for that GitHub App installation |
| Hosting, Workflows, containers, D1 | The person running the Sherpa service                         |

The software is MIT-licensed. Cloudflare and model providers can still bill.

By default there is **no dollar cap** and **no model-call cap**. Analysis has a **10-minute** deadline (`MAX_REVIEW_DURATION_MS=600000`). A repository's `.ai-reviewer.yml` can only lower the host's limits. Local development examples use tighter caps (`$1` / `18` calls in `apps/worker/.dev.vars.example`).

## GitHub App setup

This is for the person **creating** the App. Full walkthrough: [self-hosting guide](docs/self-hosting.md#2-create-your-github-app).

Public origin, with the default Worker name:

```text
https://sherpa.YOUR-CLOUDFLARE-SUBDOMAIN.workers.dev
```

Replace `YOUR-SHERPA-HOST` with that origin (no path).

| GitHub setting                                         | Value                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| Homepage URL                                           | Your project URL, such as `https://github.com/marcialc/sherpa` |
| Callback URL                                           | `https://YOUR-SHERPA-HOST/setup/callback`                      |
| Setup URL                                              | `https://YOUR-SHERPA-HOST/setup`                               |
| Redirect on update                                     | On                                                             |
| Request user authorization (OAuth) during installation | Off — Sherpa starts sign-in from `/setup`                      |
| Webhook URL                                            | `https://YOUR-SHERPA-HOST/github/webhook`                      |
| Webhook secret                                         | A new random secret; the Worker uses the same value            |

Repository permissions:

| Permission    | Access         |
| ------------- | -------------- |
| Metadata      | Read-only      |
| Contents      | Read-only      |
| Pull requests | Read and write |
| Checks        | Read and write |

Subscribe to **Pull request** events. GitHub also delivers **Check run** / **Check suite** `rerequested` when the App has Checks write access; Sherpa uses those to re-review a commit. Subscribe to **Push** if you want repository indexing.

After creating the App, copy the **App ID**, **Client ID**, a **Client Secret**, and a downloaded **private key**. Install the App on repositories only after the Worker is deployed.

Sherpa supports **GitHub.com**. Enterprise API origins are not implemented.

## Self-hosting

You need:

- Node.js 22+ and pnpm 9.12.1
- Git, Python 3, and Docker (running)
- A Cloudflare **Workers Paid** account with Containers available
- Permission to create a GitHub App

```sh
git clone https://github.com/marcialc/sherpa.git
cd sherpa
pnpm install --frozen-lockfile
pnpm exec wrangler login
```

1. Create the GitHub App using the table above.
2. Edit `apps/worker/wrangler.jsonc`: set `GITHUB_CLIENT_ID`, `PUBLIC_BASE_URL`, model IDs, and `MODEL_PRICING_JSON`. Replace the checked-in host URL and client ID with yours. Keep `ROUTER_PROVIDER`, `SPECIALIST_PROVIDER`, and `JUDGE_PROVIDER` set to `cloudflare`.
3. Put secrets in `.env.sherpa` at the repo root (gitignored):

```dotenv
GITHUB_APP_ID=YOUR_NUMERIC_APP_ID
GITHUB_CLIENT_SECRET=YOUR_GITHUB_CLIENT_SECRET
GITHUB_WEBHOOK_SECRET=THE_SAME_WEBHOOK_SECRET_FROM_THE_APP
SETUP_SESSION_SECRET=A_NEW_RANDOM_SECRET_AT_LEAST_32_CHARACTERS_LONG
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
PASTE_THE_KEY_BODY_FROM_YOUR_DOWNLOADED_PEM_FILE
-----END RSA PRIVATE KEY-----"
```

4. Check and deploy:

```sh
pnpm check
pnpm run deploy --secrets-file .env.sherpa
```

`pnpm check` runs format, lint, types, tests, and a Worker/container build. It needs Docker. It does not deploy.

5. Confirm the Worker:

```sh
curl https://YOUR-SHERPA-HOST/health
```

Expected:

```json
{ "service": "sherpa", "status": "ok" }
```

`/setup` should redirect to GitHub sign-in. Then install the App, save a gateway, and open a non-draft code PR.

For indexing, apply the D1 migration and enable the **Push** subscription; see [Repository indexing](#repository-indexing). Leave `ALLOW_REPOSITORY_VALIDATION` off until nested isolation is verified on your deployment.

**[Full self-hosting guide →](docs/self-hosting.md)**

## Configuration

**No repository config file is required.** To change defaults, add `.ai-reviewer.yml` at the repository root and **merge it into the base branch** first. Sherpa reads that file from the PR's base commit.

```yaml
review:
  reviewDrafts: false
  maxComments: 5
  findingLimits:
    shouldFix: 5
    warnings: 3
    nits: 0

budget:
  # Omit maxUsdPerReview to keep the host's dollar cap (unlimited unless the host set one).
  maxAgentCalls: 18
```

This example caps inline comments at five and hides nits. Verified Must Fix findings still appear in the summary.

Checked-in defaults (when the file is omitted):

| Setting                    | Default                         |
| -------------------------- | ------------------------------- |
| `review.reviewDrafts`      | `false`                         |
| `review.maxComments`       | `10`                            |
| `review.findingLimits`     | shouldFix 5, warnings 3, nits 3 |
| `review.minimumConfidence` | `0.8`                           |
| `routing.docsOnly`         | `skip`                          |
| `budget.maxUsdPerReview`   | unlimited                       |
| `budget.maxAgentCalls`     | unlimited                       |
| `budget.maxDurationMs`     | `600000` (10 minutes)           |
| `validation.enabled`       | `false`                         |

Agents enabled by default: `correctness`, `security`, `performance`, `testing`, `types`, `lightweight`.

More options:

- [Full configuration example](.ai-reviewer.example.yml) — reviewers, path routing, budgets, optional validation
- [Review policy](docs/review-policy.md) — path-specific instructions and enrolled `AGENTS.md` files
- [Repository tools](packages/sandbox/README.md) — optional project checks and isolation

### Environment variables

Required Worker **secrets** (first deploy via `.env.sherpa`):

| Secret                  | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `GITHUB_APP_ID`         | Numeric GitHub App ID                                                  |
| `GITHUB_PRIVATE_KEY`    | App PEM private key                                                    |
| `GITHUB_WEBHOOK_SECRET` | Same secret as the GitHub App webhook                                  |
| `GITHUB_CLIENT_SECRET`  | OAuth client secret for `/setup`                                       |
| `SETUP_SESSION_SECRET`  | HMAC secret for `/setup` sessions; 16–256 characters (32+ recommended) |

Required `vars` in `apps/worker/wrangler.jsonc`:

| Variable                                   | Purpose                                                           |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`                         | GitHub App client ID (not the App ID)                             |
| `PUBLIC_BASE_URL`                          | Public HTTPS origin, no path                                      |
| `ROUTER_PROVIDER` / `ROUTER_MODEL`         | Routing / lightweight model (`cloudflare` + catalog ID)           |
| `SPECIALIST_PROVIDER` / `SPECIALIST_MODEL` | Investigation model                                               |
| `JUDGE_PROVIDER` / `JUDGE_MODEL`           | Independent judge model                                           |
| `MODEL_PRICING_JSON`                       | Token prices for every selected model; missing prices block calls |

Checked-in service limits:

| Variable                      | Default               | Purpose                                                                     |
| ----------------------------- | --------------------- | --------------------------------------------------------------------------- |
| `MAX_REVIEW_COST_USD`         | `unlimited`           | Estimated model-spend ceiling per review                                    |
| `MAX_AGENT_CALLS`             | `unlimited`           | Model-request ceiling                                                       |
| `MAX_REVIEW_DURATION_MS`      | `600000`              | Analysis deadline                                                           |
| `ALLOWED_MODELS_JSON`         | `[]`                  | Models a repository may select as overrides                                 |
| `ALLOW_REPOSITORY_VALIDATION` | `false`               | Allow repositories to opt in to executing project checks                    |
| `INDEX_ENABLED`               | `true`                | Run the repository-index Workflow                                           |
| `INDEX_MODEL`                 | `openai/gpt-4.1-mini` | Gateway model for optional index summaries                                  |
| `INDEX_CONFIG_JSON`           | `{}`                  | Bounded index settings; see [repository indexing](docs/repository-index.md) |

Price keys are `cloudflare/` plus the catalog model ID, for example `cloudflare/openai/gpt-4.1`. Numbers in docs are format examples, not quotes. Include an entry for every distinct model, including `INDEX_MODEL`.

`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, and `CLOUDFLARE_AI_GATEWAY_TOKEN` in `.dev.vars` are for optional local [evaluations](docs/evaluations.md). They do **not** bill GitHub-triggered reviews. Those reviews use the gateway saved at `/setup`.

## Repository indexing

Sherpa can keep versioned JS/TS metadata in D1. Default-branch pushes keep the index current. A PR event bootstraps the base SHA if no usable index exists. Retrieval suggests paths and symbols for routing and specialist analysis.

The index is **not evidence**. It cannot establish a Must Fix, Should Fix, Warning, Nit, or verdict. Every accepted finding still needs immutable source reads, executor-owned evidence, and independent judgment. If the index is missing, stale, or disabled, ordinary review continues.

V1 is JS/TS metadata and lexical retrieval. Embeddings, cross-repository search, and additional languages are not implemented. `semanticEmbeddings: true` is rejected.

To use indexing on a deployment:

1. Apply `apps/worker/migrations/0001_repository_index.sql` to the `sherpa-repository-index` D1 database (`--remote` for production).
2. Enable the GitHub App **Push** webhook subscription. Contents read access is already required.
3. Keep `INDEX_ENABLED=true` (the checked-in default). Set `INDEX_ENABLED=false` to disable indexing without changing review behavior.

Local check:

```sh
pnpm exec wrangler d1 migrations apply sherpa-repository-index --local --config apps/worker/wrangler.jsonc
pnpm test:index-runtime
```

Details, ranking, privacy, and limits: [repository indexing](docs/repository-index.md).

## Security and privacy

Sherpa processes repository source and sends relevant excerpts to the models behind the installation's Cloudflare AI Gateway. Use a host and providers you trust.

- GitHub installation tokens stay in the Worker. The sandbox container never receives them. Git access is scoped to one repository, HTTPS-only, and closed after clone.
- Gateway request/response payload logging, caching, and provider retries are disabled on review calls.
- Review logs keep operational metadata (review ID, stages, bounded schema errors). They omit source, prompts, model transcripts, and secrets.
- D1 index tables store metadata and search postings, not raw source, credentials, or transcripts. There is no public index query endpoint.
- `.ai-reviewer.yml` and enrolled `AGENTS.md` files are loaded from the immutable **base** commit. PR text, comments, docs, and unenrolled instruction files are untrusted data.
- Optional project scripts and scanners are off by default. They need both `ALLOW_REPOSITORY_VALIDATION=true` and `validation.enabled` in the trusted base config. Nested isolation has not been verified on a live Cloudflare container; leave this off until you have verified it.

Read [architecture](docs/architecture.md) before enabling validation.

## Development

```sh
git clone https://github.com/marcialc/sherpa.git
cd sherpa
pnpm install --frozen-lockfile
pnpm test
```

The default suite uses mocked providers and local Git/Python tools. It does not make paid model calls or post GitHub reviews.

| Command                   | Purpose                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm test`               | Automated tests                                                                        |
| `pnpm eval`               | Local reviewer protocol and evaluation tests                                           |
| `pnpm lint`               | Lint                                                                                   |
| `pnpm typecheck`          | Typecheck                                                                              |
| `pnpm format:check`       | Format check                                                                           |
| `pnpm check`              | Format, lint, types, tests, and Worker/container build (needs Docker; does not deploy) |
| `pnpm test:index-runtime` | Local workerd index parse/publish/retrieve smoke test                                  |

To run the Worker locally:

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

Fill in GitHub credentials, `SETUP_SESSION_SECRET`, `PUBLIC_BASE_URL`, model IDs, and prices. Then:

```sh
pnpm typegen
pnpm dev
```

Open `/health` on the printed address. Browser setup and real webhooks need an **HTTPS tunnel**; point `PUBLIC_BASE_URL` and the GitHub App URLs at that origin. GitHub-triggered local reviews still need a gateway saved through `/setup`. Use a separate development GitHub App.

Paid model comparisons: [evaluations](docs/evaluations.md) (`pnpm eval:live`).

## Troubleshooting

| What you see                      | What to try                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| No review appears                 | App installed on this repo, PR changes code, PR is not a draft. Push a commit or re-run the Sherpa check.                         |
| Billing is not configured         | Open `/setup`, select the installation, save a gateway, then push a new commit. Saving a gateway does not rerun an old review.    |
| Gateway saved, review incomplete  | Token has Workers AI **Read**, gateway has Unified Billing credits, host models exist in the catalog and in `MODEL_PRICING_JSON`. |
| No installation on the setup page | Sign in as a user who can see the installed App. Organizations may need owner approval.                                           |
| Setup is unavailable              | Host must set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `SETUP_SESSION_SECRET`.                                             |
| Project tests were skipped        | Validation is off by default. It needs the host flag and base-branch opt-in.                                                      |
| Review discarded as stale         | The PR moved while the review ran. Look at the newer commit's Workflow.                                                           |

Hosts: [deployment troubleshooting](docs/self-hosting.md#troubleshooting) covers webhook status codes, Workflow logs, and container/Git failures.

## Project status

Sherpa is an **early public release** (`0.1.0`). The review protocol, GitHub publication path, sandbox tools, and index are implemented and covered by automated tests. It is not a measured production accuracy claim, and it is not a hosted SaaS with a public App listing.

Verified in-repo:

- Webhook → hypothesis analysis → repository verification → independent judge → GitHub publication, with mocked providers
- GitHub signature checks, review idempotency, verdict calculation, and comment formatting
- Sandbox Git isolation and tool bounds; optional Docker image tests when explicitly enabled
- Index staging, publication, retrieval, and “index is not evidence” regressions

Still being proven on real deployments (see [validation record](docs/validation.md)):

- Complete live reviews after the latest runtime fixes, including private/fork PRs and inline-comment quality
- Production D1 indexing on private repositories
- Nested project-script isolation on Cloudflare Containers
- Model quality on a representative PR corpus — protocol tests are not an accuracy benchmark

Known product limits: GitHub.com only; JS/TS indexing in v1; no embeddings; no host-wide OpenAI/Anthropic keys for GitHub reviews; root `/` is not a product homepage (`/setup` and `/health` are the HTTP surfaces).

## Contributing

There is no separate contributing guide yet.

1. Open an issue or PR against [`marcialc/sherpa`](https://github.com/marcialc/sherpa).
2. Keep changes scoped. Match existing validation, bounds, and fail-closed behavior.
3. Run `pnpm test` (and `pnpm check` when you touch the Worker or container).
4. Do not commit `.dev.vars`, `.env.sherpa`, PEM keys, or gateway tokens.

Design context: [architecture](docs/architecture.md), [review policy](docs/review-policy.md), [evaluations](docs/evaluations.md).

## Documentation

| Guide                                           | Contents                                                       |
| ----------------------------------------------- | -------------------------------------------------------------- |
| [Self-hosting](docs/self-hosting.md)            | GitHub App, models, deploy, local Worker, host troubleshooting |
| [Architecture](docs/architecture.md)            | Workflows, sandbox, routing, judge, budgets                    |
| [Review policy](docs/review-policy.md)          | Base-commit rules and enrolled `AGENTS.md`                     |
| [Repository indexing](docs/repository-index.md) | D1 index lifecycle, retrieval, privacy                         |
| [Evaluations](docs/evaluations.md)              | Protocol tests and optional live model comparison              |
| [Validation record](docs/validation.md)         | What has been tested, including remaining live checks          |
| [Repository tools](packages/sandbox/README.md)  | Git tools, scanners, optional validation                       |

## License

Sherpa is open source under the [MIT License](LICENSE).
