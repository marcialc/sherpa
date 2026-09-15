# Host your own Sherpa

[← Back to the README](../README.md)

This guide is for the person **running the Sherpa service**. You will deploy it to your Cloudflare account and create a GitHub App that people can install on their repositories.

The host pays for Cloudflare compute and containers. Each GitHub App installation connects its own AI Gateway to pay for model usage. If you are the only user, you fill both roles.

**Setup path:** download → GitHub App → models → deployment → first review.

## 1. Download and check the project

Have these ready:

| Requirement                                         | Why you need it                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Node.js 22+** and **pnpm 9.12.1**                 | Install dependencies and run the service tooling.                                                              |
| **Git** and **Python 3**                            | Download the project and run the local repository-tool tests.                                                  |
| **Docker Desktop**, running, or a compatible engine | Build and run Sherpa's repository container.                                                                   |
| **Cloudflare Workers Paid account**                 | Host the Worker, Workflows, Durable Objects, and Containers. Confirm Containers are available on your account. |
| **GitHub account with permission to create an App** | Connect Sherpa to your repositories.                                                                           |

Download the code and log in to Cloudflare:

```sh
git clone https://github.com/marcialc/sherpa.git
cd sherpa
pnpm install --frozen-lockfile
pnpm exec wrangler login
```

Run all commands in this guide from the `sherpa` directory. Keep Docker running during builds.

**Checkpoint:** dependencies install successfully and Wrangler opens a browser to authorize your Cloudflare account.

## 2. Create your GitHub App

First, choose the public address you will use. With the default Worker name, it will look like:

```text
https://sherpa.YOUR-CLOUDFLARE-SUBDOMAIN.workers.dev
```

Find your account's `workers.dev` subdomain in Cloudflare's Workers & Pages settings. If you change `name` in [`apps/worker/wrangler.jsonc`](../apps/worker/wrangler.jsonc), the Worker part of the address changes too. A custom HTTPS domain also works if you configure it separately.

In [GitHub App settings](https://github.com/settings/apps), select **New GitHub App**. Use a unique app name and fill in these settings, replacing `YOUR-SHERPA-HOST` with your actual hostname:

| GitHub setting                                             | Value                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| **Homepage URL**                                           | Your project URL, such as `https://github.com/marcialc/sherpa`.     |
| **Callback URL**                                           | `https://YOUR-SHERPA-HOST/setup/callback`                           |
| **Setup URL**                                              | `https://YOUR-SHERPA-HOST/setup`                                    |
| **Redirect on update**                                     | On                                                                  |
| **Request user authorization (OAuth) during installation** | Off — Sherpa starts sign-in from the setup page.                    |
| **Webhook URL**                                            | `https://YOUR-SHERPA-HOST/github/webhook`                           |
| **Webhook secret**                                         | A new random secret from your password manager. Save it for step 4. |

Under **Repository permissions**, set:

| Permission    | Access         |
| ------------- | -------------- |
| Metadata      | Read-only      |
| Contents      | Read-only      |
| Pull requests | Read and write |
| Checks        | Read and write |

Subscribe to **Pull request** events. GitHub also sends **Check run** and **Check suite** events to Apps with Checks write access; Sherpa uses the `rerequested` actions when someone re-runs the Sherpa check in GitHub. Choose **Any account** if other people should be able to install your App; otherwise restrict it to your own account. GitHub's [App registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) explains these settings.

For an existing App, save the permission changes, then approve the updated permissions under **Settings → Applications → Installed GitHub Apps → Sherpa → Configure**. Updating the App registration alone does not grant the new permissions to existing installations.

Sherpa creates a **Sherpa** check on the reviewed commit when its Workflow starts. It moves from queued to in progress after acquiring the PR's review lock, then shows the review result. Must-fix findings and incomplete reviews fail the check; approved reviews with non-blocking comments pass. Skipped and superseded reviews are marked accordingly. Re-running that check, or its check suite, from the pull request Checks tab starts a new review of the same commit. The check is separate from GitHub Actions CI and Cloudflare Workers Builds.

After creating the App:

1. Copy the **App ID** and **Client ID**. These are different values.
2. Generate a **Client Secret** and save it securely.
3. Generate a **private key** and keep the downloaded PEM file outside the repository.

**Checkpoint:** you have the App ID, Client ID, Client Secret, private key, and webhook secret. Wait until step 5 to install the App on repositories.

## 3. Configure the service and models

Open [`apps/worker/wrangler.jsonc`](../apps/worker/wrangler.jsonc). Edit the existing `vars` object; keep the Workflow, container, Durable Object, and migration configuration in place.

Set these values:

| Variable             | What to enter                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`   | The GitHub App's **Client ID** from step 2.                                                    |
| `PUBLIC_BASE_URL`    | Your public HTTPS origin, such as `https://sherpa.your-subdomain.workers.dev`, without a path. |
| `ROUTER_MODEL`       | A chat model for initial analysis and small reviews.                                           |
| `SPECIALIST_MODEL`   | A chat model for code investigation.                                                           |
| `JUDGE_MODEL`        | A chat model for independently checking findings.                                              |
| `MODEL_PRICING_JSON` | Input and output token prices for every selected model, as described below.                    |

Keep `ROUTER_PROVIDER`, `SPECIALIST_PROVIDER`, and `JUDGE_PROVIDER` set to **`cloudflare`**. GitHub-triggered reviews use the gateway saved for that installation, rather than a host-wide inference key.

Choose supported chat models from Cloudflare's [model catalog](https://developers.cloudflare.com/ai-gateway/models/). Model IDs include their provider, such as `openai/your-model-id` or `anthropic/your-model-id`. Your users' gateways must support your choices. You can use the same compatible model for all three roles to start, then choose separate models later.

### Add model prices

Sherpa requires prices so it can enforce an estimated review budget. Missing prices stop model calls.

The price key is **`cloudflare/` followed by the model ID**. For example, the model `openai/your-model-id` uses this price entry:

```json
{
  "cloudflare/openai/your-model-id": {
    "inputUsdPerMillion": 1,
    "outputUsdPerMillion": 5
  }
}
```

**Those numbers illustrate the format; they are not a price quote.** Replace the model ID and rates with current values for the models you choose. Include an entry for every distinct model used by the service.

`MODEL_PRICING_JSON` is stored as a string in Wrangler's `vars`. Here is an example for one model shared across all three roles. Merge these values into the existing `vars` object; keep the rest of the configuration:

```jsonc
{
  "vars": {
    "GITHUB_CLIENT_ID": "YOUR_GITHUB_CLIENT_ID",
    "PUBLIC_BASE_URL": "https://sherpa.YOUR-SUBDOMAIN.workers.dev",
    "ROUTER_PROVIDER": "cloudflare",
    "ROUTER_MODEL": "openai/your-model-id",
    "SPECIALIST_PROVIDER": "cloudflare",
    "SPECIALIST_MODEL": "openai/your-model-id",
    "JUDGE_PROVIDER": "cloudflare",
    "JUDGE_MODEL": "openai/your-model-id",
    "MODEL_PRICING_JSON": "{\"cloudflare/openai/your-model-id\":{\"inputUsdPerMillion\":1,\"outputUsdPerMillion\":5}}",
  },
}
```

<details>
<summary><strong>Optional model and budget settings</strong></summary>

| Variable                      | Default  | Purpose                                                      |
| ----------------------------- | -------- | ------------------------------------------------------------ |
| `MAX_REVIEW_COST_USD`         | `1.00`   | Maximum estimated model usage per review.                    |
| `MAX_AGENT_CALLS`             | `18`     | Maximum model requests, including retries.                   |
| `MAX_REVIEW_DURATION_MS`      | `600000` | Analysis deadline: 10 minutes.                               |
| `ALLOWED_MODELS_JSON`         | `[]`     | Models repositories may choose as overrides.                 |
| `ALLOW_REPOSITORY_VALIDATION` | `false`  | Whether repositories may opt in to executing project checks. |

An allowed-model list looks like `[{"provider":"cloudflare","model":"openai/your-model-id"}]`. Add prices for allowed overrides too. Repository choices outside this list are ignored.

Price entries may also include `cachedInputUsdPerMillion` and `cacheWriteInputUsdPerMillion` when applicable. Estimates cover model tokens, not hosting or provider billing adjustments. For Workers AI models (`@cf/...`), check Cloudflare's [billing settings](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) and verify actual usage with your chosen model and endpoint.

Leave project validation off until you have verified the required isolation in your deployment. It also requires opt-in from the repository's trusted base configuration. See [repository validation](../packages/sandbox/README.md).

</details>

**Checkpoint:** all three model fields contain real IDs, and every model has a matching price entry. There are no placeholder values in the settings you edited.

## 4. Deploy with your secrets

The first deployment needs the GitHub credentials and a setup session secret. Create a file named **`.env.sherpa`** at the repository root with these values:

```dotenv
GITHUB_APP_ID=YOUR_NUMERIC_APP_ID
GITHUB_CLIENT_SECRET=YOUR_GITHUB_CLIENT_SECRET
GITHUB_WEBHOOK_SECRET=THE_SAME_WEBHOOK_SECRET_FROM_STEP_2
SETUP_SESSION_SECRET=A_NEW_RANDOM_SECRET_AT_LEAST_32_CHARACTERS_LONG
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
PASTE_THE_KEY_BODY_FROM_YOUR_DOWNLOADED_PEM_FILE
-----END RSA PRIVATE KEY-----"
```

Preserve the private key's exact header, body, footer, and line breaks from the downloaded PEM file, inside the quotes. Use a separate random value for `SETUP_SESSION_SECRET`, generated by your password manager.

`.env.sherpa` is ignored by Git. Keep it private and never paste its contents into an issue or pull request. The installation's AI Gateway token is entered later through `/setup`, not in this file.

Check the project, then deploy:

```sh
pnpm check
pnpm run deploy --secrets-file .env.sherpa
```

`pnpm check` runs formatting, lint, types, tests, and a Worker/container build without deploying. The second command publishes the service and supplies the required secrets together. Current Wrangler requires this approach for a [first deployment with required secrets](https://developers.cloudflare.com/workers/configuration/secrets/#secrets-on-deployed-workers).

For Cloudflare Workers Builds, set the root directory to `/`, the build command to `pnpm run build`, and the deploy command to `pnpm run deploy`. If deployment reports missing secrets, add all five required Worker secrets before retrying.

When deployment finishes, Wrangler prints your Worker URL. If it differs from the address you chose, update `PUBLIC_BASE_URL` and all three GitHub App URLs, then run `pnpm run deploy` again. Allow time for the repository container to become available.

Check the health endpoint, replacing the hostname:

```sh
curl https://YOUR-SHERPA-HOST/health
```

Expected response:

```json
{ "service": "sherpa", "status": "ok" }
```

**Checkpoint:** `/health` returns `200`, and `/setup` redirects you to GitHub sign-in. The health endpoint confirms the service is running; the first PR review checks the full integration.

<details>
<summary><strong>Updating the service or rotating a secret later</strong></summary>

After making changes, run `pnpm check` and deploy again:

```sh
pnpm run deploy
```

To update one secret on the existing Worker, use an interactive prompt:

```sh
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --config apps/worker/wrangler.jsonc
```

For a replacement private key, read the PEM file directly:

```sh
pnpm exec wrangler secret put GITHUB_PRIVATE_KEY --config apps/worker/wrangler.jsonc < /path/to/app-private-key.pem
```

Update your secure copy of the secrets too before using it for another deployment. If you rotate `GITHUB_WEBHOOK_SECRET`, also update it in the GitHub App settings.

Keep the Sandbox SDK and Docker image versions aligned. Separate staging and production deployments need their own Worker/Workflow names, storage, secrets, and GitHub Apps; consult the [architecture guide](architecture.md) before sharing infrastructure.

</details>

## 5. Connect a repository and verify a review

1. In your GitHub App settings, open **Install App** and select a test repository.
2. Follow the setup redirect. Create and connect an AI Gateway using the [README's gateway steps](../README.md#2-prepare-your-ai-gateway).
3. Open a small, nondraft code PR. Include a simple, intentional defect in the test branch so you can check whether the review finds it.
4. In the GitHub App's **Recent deliveries**, confirm that the pull request event received `202`.
5. Confirm that a Sherpa review appears on the expected commit, with comments attached to the relevant changed lines.
6. Fix the defect and push. Check the follow-up review.

To inspect activity while testing:

```sh
pnpm exec wrangler tail --config apps/worker/wrangler.jsonc
```

The webhook response and logs include a `reviewId`. Use it to follow the review in logs and in the `sherpa-review` Workflow in Cloudflare's dashboard.

Before offering the service to others, also verify a private/fork PR and redeliver an already handled webhook to check that it does not post a duplicate review. See the [live acceptance checklist](validation.md#live-acceptance-still-required).

**Checkpoint:** a real review arrives, a new commit triggers a follow-up, and model usage appears on the connected Cloudflare account. You can now share your GitHub App install link and public `/setup` URL.

## Local development

To run the service on your computer after installing dependencies:

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

Fill in the GitHub credentials, setup session secret, public URL, model IDs, and pricing in `.dev.vars`. It is ignored by Git. Local `.dev.vars` values are not automatically deployed; production settings live in Wrangler's `vars` and deployed secrets.

```sh
pnpm typegen
pnpm dev
```

Wrangler prints the local address. Open `/health` on that address to check that the service is running.

For browser sign-in and real webhooks, expose the local server through an **HTTPS tunnel**. Point `PUBLIC_BASE_URL` and the GitHub App's webhook, callback, and setup URLs at that same public tunnel origin. Setup uses secure cookies, so use the HTTPS address for the complete browser flow. A separate development GitHub App avoids disrupting a deployed installation.

GitHub-triggered reviews still need a gateway saved through the local `/setup` page. The optional `CLOUDFLARE_*` credentials in `.dev.vars.example` are for standalone live evaluations; they do not configure billing for a GitHub installation. See [evaluations](evaluations.md) before running paid model comparisons.

## Troubleshooting

| Symptom                                      | What to check                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First deployment reports missing secrets** | Supply all five required values in `.env.sherpa` and use `pnpm run deploy --secrets-file .env.sherpa`.                                                                                                                                                           |
| **Container build fails**                    | Start Docker and confirm it is available to your terminal. Keep SDK and image versions aligned.                                                                                                                                                                  |
| **Webhook returns `401`**                    | GitHub and the Worker must use the same webhook secret.                                                                                                                                                                                                          |
| **Webhook returns `400`**                    | Check the event type, payload, installation/repository IDs, and delivery headers.                                                                                                                                                                                |
| **Webhook returns `503`**                    | Check the deployed webhook secret and whether Cloudflare can start the review Workflow. Retry the delivery after fixing the problem.                                                                                                                             |
| **No Sherpa check appears**                  | Check the App's **Advanced → Recent deliveries** for a `pull_request` event and its response. A `202` means the Workflow was accepted. Confirm **Checks: Read and write** is approved for the installation, and inspect Workflow logs for `review.check_failed`. |
| **Setup returns `503`**                      | Check `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `SETUP_SESSION_SECRET`.                                                                                                                                                                                    |
| **GitHub sign-in fails**                     | The App's callback URL must match the public origin plus `/setup/callback`. Check the Client Secret and HTTPS cookies.                                                                                                                                           |
| **Review is incomplete after gateway setup** | Check model IDs/prices, token permissions, gateway funding, and the review's coverage notes. A saved gateway has not yet been tested against the provider.                                                                                                       |
| **Private repository cannot be fetched**     | Check App installation access, Contents permission, container provisioning, and outbound Git authentication.                                                                                                                                                     |
| **Project validation is unavailable**        | Check the lockfile, scripts, opt-in settings, and nested isolation support. Keep validation disabled where isolation is unavailable.                                                                                                                             |
| **Review was discarded as stale**            | The PR changed while the review ran. Check the newer commit's Workflow.                                                                                                                                                                                          |
| **Publication is uncertain**                 | Check whether the review already exists. Recovery checks GitHub without blindly repeating the review POST.                                                                                                                                                       |

For incomplete reviews, open **Workers & Pages → sherpa → Observability**, select the time of the new review, and search for `review.model_invalid_output` or `review.tool_completed`. These are structured object logs, following [Cloudflare's indexing guidance](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#logging-structured-json-objects). Open an event and use its `reviewId` to find the related events. `diagnosticsVersion: 2` confirms the new instrumentation is deployed. `runId` and `sequence` group and order events from one analysis execution; `pr`, `baseSha`, and `headSha` identify the exact revision.

- `review.model_invalid_output`: `agent`, `phase`, `provider`, `model`, `callId`, `attempt`, and `correction` identify the failed request. `validation.details` gives bounded field paths, received types, expected types, string/array lengths and limits, recognized extra field names, and known custom constraint codes. `validation.issueCount` is the full count; details show at most six errors. For example, `path: assessments.0.reason`, `received: null`, `expected: string` means the reason was null. `maximum: 500`, `actualLength: 612` means that field exceeded the schema limit. No values, arbitrary keys, or raw validation messages are logged.
- `review.model_started` / `review.model_completed`: follow the same `callId`. An invalid first attempt followed by a completed `correction: true` attempt recovered. Two invalid attempts or `review.model_invocation_failed` did not recover. Input/output byte and token counts, output-token limits and remaining review time help distinguish format failures from budget pressure.
- `review.tool_completed`: `agent`, `hypothesisId`, `evidenceId`, `purpose`, `tool`, line range, and revision identify the evidence operation. `code: VALIDATION_DISABLED` means a requested test/scan was blocked by policy; `NOT_A_REGULAR_REPOSITORY_FILE` means the requested Git path was absent or not a regular file. `sourceTruncated` means the executor returned incomplete output; `contextTruncated` means the result exceeded the 6,000-byte context cap. `outputBytes` and `retainedBytes` show the size difference. Unknown execution errors remain `TOOL_FAILED`; paths, search text, commands and output are excluded.
- `review.coverage_incomplete` records each distinct coverage failure. `review.analysis_completed` summarizes coverage, findings, model/tool counts, time and estimated model cost. `review.repository_ready` reports whether repository preparation succeeded or the review used the diff fallback.

When reporting a failure, copy the matching invalid-output/tool events and final analysis summary. Sherpa disables AI Gateway request/response payload logging, so “Not available” there is expected. Existing historical response payloads cannot be recovered by deploying these diagnostics.

For repository fallback, find `review.sandbox_unavailable` and inspect its `stage` and `code`. A successful container build alone does not verify runtime Git access.

For deeper details, see [architecture](architecture.md), [repository tools](../packages/sandbox/README.md), and the [validation record](validation.md).
