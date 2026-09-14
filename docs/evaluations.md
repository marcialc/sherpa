# Reviewer evaluation

Run `pnpm eval` for the local suite. It tests the hypothesis/verification protocol, policy trust boundaries, curated fixture ground truth, and metric calculation. `pnpm test` includes these checks plus the webhook/publication and Sandbox suites. Neither command makes paid model requests.

The frozen pre-rewrite reviewer lives in `tests/evals/baseline/`. Its original prompt and orchestration hashes are recorded there. The production Worker never imports that copy. Both versions use the same provider transport, prices, budgets and presentation schema during comparison.

## Fixtures and measurements

The fixture corpus includes arithmetic and authorization regressions (including deletion-only guard removal), a newly added nullable-profile crash, an incompatible type contract, caller validation, ORM parameterization, React escaping, existing error handling, request-size limits, unrelated old defects, style/test filler and prompt-injection attempts. Small base/head programs reproduce known failures and mitigations independently of model output. Ground-truth labels and explanations are never sent to the reviewer.

Each run measures true positives, false positives, missed high/critical bugs, duplicates, invalid line anchors, average findings per PR, judge rejection rate, model cost, latency and incomplete coverage. Duplicate findings count as false positives. Reporting nothing does not manufacture perfect precision: it yields undefined precision and counts every missed known serious bug. A comparison cannot pass by increasing incomplete reviews or sacrificing high-impact recall.

Precision is the first optimization target. High/critical recall is second. A change qualifies as better on the measured sample only if it reduces false positives or high-impact misses without worsening precision, serious misses, duplicates, anchors or coverage. Cost and latency remain visible tradeoffs. The small corpus is a regression suite, not a statistically representative estimate of production quality. Review root-cause matches manually: automatic matching uses curated path, line and diagnostic-word labels.

## Deferred live comparison

The live before/after model evaluation is deferred at the user's request. Local protocol tests demonstrate deterministic enforcement; they do not demonstrate how often a particular model discovers or misjudges real bugs.

The paired adversarial replay writes `artifacts/evals/protocol.json`. On its six scripted traces, the frozen reviewer publishes three unsupported claims and misses the deletion-only guard regression. The current reviewer retains all three supported bugs and blocks all three fabricated-evidence traces. Those invalid traces become incomplete reviews. The replay's token usage and cost are synthetic, and its precision numbers describe these hand-authored protocol traces only; they are not measured model quality.

When ready, configure `apps/worker/.dev.vars` with the existing Cloudflare gateway ID/account/token, `ROUTER_MODEL`, `SPECIALIST_MODEL`, `JUDGE_MODEL`, and current `MODEL_PRICING_JSON`. Add an explicit total comparison spend cap as `SHERPA_EVAL_MAX_USD`. Then run:

```sh
pnpm eval:live
```

The runner uses only Cloudflare inference credentials, runs paired baseline/current reviews, alternates order, and writes an incremental `artifacts/evals/live.json` report. The report includes model IDs, configured prices, per-case outcomes, costs, warnings, metrics and comparison status. Credentials are excluded; generated reports are ignored by Git.

`SHERPA_EVAL_REPETITIONS` accepts 1–5 repetitions. `SHERPA_EVAL_CASES` can select comma-separated fixture IDs for an initial smoke run. The total cap is divided across all planned reviews, with bounded calls, timeouts and conservative reservations. A small allocation may prevent a complete review; that remains visible as incomplete coverage rather than a successful zero-finding result.

Live fixture tools expose immutable in-memory base/head files and recorded scanner hypotheses. They do not execute model-generated code; real temporary reproduction execution is tested separately through the isolated Sandbox tool. No PRs are changed and no GitHub reviews are published by the evaluator.

Inspect false positives and serious misses in the report, trace them to their evidence, update the shared/domain prompts or evidence gates, and repeat the paired run with unchanged models, labels and limits. Preserve previous reports when comparing iterations. Do not tune expected labels to make a failing prompt pass.
