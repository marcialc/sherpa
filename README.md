<p align="center">
  <img src="logo.png" alt="Sherpa, a mountain guide holding a code review checklist" width="180" />
</p>

<h1 align="center">Sherpa</h1>

<p align="center">
  <strong>A second set of eyes on your pull requests.</strong><br />
  Open-source AI code reviews, right in GitHub.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0ea5e9" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/status-early_release-f59e0b" alt="Early release" />
  <a href="docs/self-hosting.md"><img src="https://img.shields.io/badge/host_on-Cloudflare-f38020" alt="Host on Cloudflare" /></a>
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#understand-your-review">Review results</a> ·
  <a href="#customize-your-reviews">Configuration</a> ·
  <a href="docs/self-hosting.md">Self-hosting</a> ·
  <a href="#troubleshooting">Help</a>
</p>

---

Sherpa reads the changes in a pull request, investigates possible problems, and checks the evidence before posting a review. You get a clear verdict, comments on the relevant lines, and suggested fixes when changes are needed.

- **Feedback you can act on.** Findings explain what is wrong, when it happens, and why it matters.
- **A clear merge decision.** Only verified **Must Fix** findings request changes.
- **Reviews as you work.** Opening, reopening, or pushing commits to a pull request triggers a review. You can also re-run the Sherpa check from GitHub.
- **Your AI billing.** Connect your own Cloudflare AI Gateway, with review budgets you can lower per repository.

> [!NOTE]
> **Early release.** Automated tests cover the review workflow, but a live deployment and real GitHub PR review still need verification. See the [validation record](docs/validation.md) for what has—and has not—been tested.

## Get started

There are two ways to use Sherpa:

| Your goal                                               | Start here                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Use an existing Sherpa service** on your repositories | Get its GitHub App install link and setup URL from the person hosting it, then follow the steps below. |
| **Run your own Sherpa service** for yourself or a team  | Follow the [self-hosting guide](docs/self-hosting.md), then connect your repositories below.           |

The person hosting Sherpa runs the service on Cloudflare. People installing the GitHub App only need GitHub access and their own Cloudflare AI Gateway.

### 1. Install the GitHub App

Open your host's GitHub App install link. Choose your GitHub account or organization, then select the repositories you want Sherpa to review.

After installation, GitHub takes you to Sherpa's setup page. You can also open the setup URL your host provides, such as `https://YOUR-SHERPA-HOST/setup`.

### 2. Prepare your AI Gateway

In your [Cloudflare dashboard](https://dash.cloudflare.com/):

1. Open **AI Gateway** and create a gateway, for example `sherpa`.
2. Enable gateway authentication and fund **Unified Billing** with credits. See Cloudflare's [billing setup](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).
3. Create an API token with **Account → Workers AI → Read**, scoped to that Cloudflare account. This is the [inference permission](https://developers.cloudflare.com/ai-gateway/usage/rest-api/#authentication) Sherpa needs.

Keep these three values ready:

| Value                     | What to enter                                                        |
| ------------------------- | -------------------------------------------------------------------- |
| **Cloudflare account ID** | Your 32-character account ID, available in the Cloudflare dashboard. |
| **AI Gateway name**       | The name you chose, such as `sherpa`.                                |
| **API token**             | The token you just created.                                          |

Your host chooses the models. Ask them which models your gateway needs to support if you are unsure.

### 3. Connect Sherpa to your gateway

On Sherpa's setup page:

1. Sign in with GitHub.
2. Select the account or organization where you installed Sherpa.
3. Enter your account ID, gateway name, and API token.
4. Select **Save Gateway**.

One saved gateway covers **all repositories in that GitHub App installation**. You do not need to add API keys or a configuration file to each repository.

**You are connected when the page shows “Gateway saved.”** This confirms the settings were stored; your first review verifies that the token, billing, and models work together.

### 4. Open a pull request

Open a small pull request that changes code, with **Draft turned off**. Sherpa will post its review on the pull request.

Read the summary, check any inline comments, and push your fixes. Sherpa reviews the new changes using the last completed review as its starting point when possible. Re-running Sherpa on the same commit updates that summary in place. If a completed re-run changes the merge decision, Sherpa posts one replacement review and then dismisses the previous one. A failed or incomplete re-run does not clear a Request changes review.

**By default, draft PRs and ordinary documentation-only changes are skipped.** If you turn a draft into a ready PR, push a new commit or reopen it to trigger a review.

## Understand your review

Every completed review has one verdict:

| Verdict                       | Meaning                                                | GitHub action           |
| ----------------------------- | ------------------------------------------------------ | ----------------------- |
| ✅ **Approved**               | No blocking or meaningful issues found.                | Approves the PR         |
| 🟡 **Approved With Comments** | Safe to merge, with worthwhile non-blocking feedback.  | Leaves a review comment |
| ❌ **Not Approved**           | At least one verified issue needs fixing before merge. | Requests changes        |

Findings are grouped from most to least urgent:

| Priority          | What to do                                                                |
| ----------------- | ------------------------------------------------------------------------- |
| 🔴 **Must Fix**   | Resolve before merging.                                                   |
| 🟠 **Should Fix** | Address soon; this does not automatically block merging.                  |
| 🟡 **Warning**    | Check the stated assumption, compatibility issue, or operational concern. |
| 🔵 **Nit**        | Consider a small, optional improvement.                                   |

<details>
<summary><strong>See an example review</strong></summary>

> ## 🤖 AI Review
>
> ### ❌ Not Approved
>
> **🔴 1 Must Fix**
>
> Resolve the blocker before merging:
>
> - Session deletion is missing an ownership check
>
> ---
>
> ### 🔴 Must Fix
>
> 1. **Session deletion is missing an ownership check** · `src/auth/session.ts:87`
>
>    A signed-in user can delete another user's session by supplying its ID.
>
>    > **Fix:** Verify that the session belongs to the current user before deleting it.

</details>

An incomplete review is labeled **Review Incomplete** and never approves the PR. Failed reviewer steps are listed as notes; remaining confirmed findings are still published. If Sherpa already confirmed a blocker, it still requests changes and explains the coverage gap.

Sherpa helps with review; it does not replace your tests or your judgment. GitHub branch protection remains under your control.

## What does it cost?

| Cost                                  | Who pays                                                         |
| ------------------------------------- | ---------------------------------------------------------------- |
| **AI model usage**                    | The Cloudflare account connected to the GitHub App installation. |
| **Hosting and repository containers** | The person running the Sherpa service.                           |

If you host Sherpa for yourself, you pay both. The software is MIT-licensed; the services it uses can incur charges.

Reviews have no dollar cap by default. They allow at most **18 model requests** and **10 minutes of analysis**. Call and time limits prevent runaway runs; model usage is still billed by your configured provider.

## Customize your reviews

**No configuration file is required.** To change the defaults, add `.ai-reviewer.yml` at the root of the repository being reviewed:

```yaml
review:
  reviewDrafts: false
  maxComments: 5
  findingLimits:
    shouldFix: 5
    warnings: 3
    nits: 0

budget:
  # Omit maxUsdPerReview to keep the default unlimited spend.
  maxAgentCalls: 18
```

This keeps inline feedback to five comments and hides optional nits. Verified **Must Fix** findings remain visible in the summary even when inline comments are limited.

**Merge the file into your base branch first**, usually `main`. Sherpa uses the configuration from the branch the PR targets, so a PR cannot change its own review rules. Repository budgets can lower the host's limits.

For more options:

- [Full configuration example](.ai-reviewer.example.yml) — reviewer selection, routing, budgets, and optional validation.
- [Review policy guide](docs/review-policy.md) — path-specific instructions and explicitly enrolled `AGENTS.md` files.
- [Repository tools and validation](packages/sandbox/README.md) — running project checks and the isolation they require.

## Host your own Sherpa

You will need a GitHub account, a Cloudflare Workers Paid account with Containers available, and a computer with Node.js 22+, pnpm 9.12.1, Git, Python 3, and Docker.

The [self-hosting guide](docs/self-hosting.md) walks you through:

1. Downloading the project and checking your environment.
2. Creating your GitHub App.
3. Choosing models and setting review budgets.
4. Deploying Sherpa with the required secrets.
5. Connecting your repositories and confirming the first review.

**[Follow the self-hosting guide →](docs/self-hosting.md)**

Sherpa can persist versioned repository discovery metadata in D1 and update it incrementally on default-branch pushes. [Repository indexing](docs/repository-index.md) explains setup, limits and retrieval. Indexed context guides investigation; findings still require immutable source verification and executor-attested evidence.

## Develop locally

To explore the code and run the automated tests:

```sh
git clone https://github.com/marcialc/sherpa.git
cd sherpa
pnpm install --frozen-lockfile
pnpm test
```

The default test suite uses mocked external APIs and local tools. It does not make paid model calls or post GitHub reviews. Install Node.js, pnpm, Git, and Python first; see the [tooling checklist](docs/self-hosting.md#1-download-and-check-the-project).

| Command             | Purpose                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `pnpm test`         | Run the automated tests.                                                         |
| `pnpm eval`         | Run local reviewer protocol and evaluation tests.                                |
| `pnpm lint`         | Check code quality rules.                                                        |
| `pnpm typecheck`    | Check TypeScript types.                                                          |
| `pnpm format:check` | Check formatting.                                                                |
| `pnpm check`        | Run all checks and build the Worker/container. Requires Docker; does not deploy. |

To start the app locally, follow [local development setup](docs/self-hosting.md#local-development). Optional paid model comparisons are covered in the [evaluation guide](docs/evaluations.md).

## Troubleshooting

| What you see                                | What to try                                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **No review appears**                       | Confirm the App is installed on this repository, the PR changes code, and the PR is not a draft. Push a new commit to trigger a review.   |
| **Billing is not configured**               | Open `/setup` on your Sherpa host, select the installation, and save a gateway. Then push a new commit.                                   |
| **Gateway saved, but review is incomplete** | Check the token's Workers AI permission, gateway credits, and model availability. Ask your host to check model pricing and review limits. |
| **No installation appears during setup**    | Sign in with a GitHub account that can access the installed App. Check that it was installed on the intended account or organization.     |
| **Setup is unavailable**                    | Ask your host to check the GitHub Client ID, Client Secret, and setup session secret.                                                     |
| **Project tests were skipped**              | Repository script execution is off by default. It needs both host permission and repository opt-in.                                       |

Hosting the service? See [deployment troubleshooting](docs/self-hosting.md#troubleshooting) for webhook errors, logs, and container checks.

## Security and privacy

Sherpa processes repository code and sends relevant excerpts to the configured model providers. Use a host and provider setup you trust for your repositories.

GitHub credentials stay outside the repository container. Project scripts are disabled by default, and review rules come from the PR's base branch. Read the [security boundaries](docs/architecture.md) before enabling optional code execution.

## More about the project

| Guide                                   | What you will find                                                      |
| --------------------------------------- | ----------------------------------------------------------------------- |
| [Architecture](docs/architecture.md)    | How the GitHub App, review agents, and Cloudflare service fit together. |
| [Review policy](docs/review-policy.md)  | How to give Sherpa repository-specific guidance.                        |
| [Evaluations](docs/evaluations.md)      | How reviewer behavior is tested and compared.                           |
| [Validation record](docs/validation.md) | Completed checks and remaining live verification.                       |

## License

Sherpa is open source under the [MIT License](LICENSE).
