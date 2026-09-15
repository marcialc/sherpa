import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { runReview } from "@sherpa/agents";
import {
  createProviderRegistry,
  pricingTableSchema,
  type ModelProvider,
  type ProviderRegistry,
} from "@sherpa/models";
import { repoConfigSchema, type ModelRef } from "@sherpa/schemas";
import { runReview as runBaseline } from "./baseline/review";
import { evalFixtures } from "./fixtures";
import { compareQuality, measure, type EvaluationRun } from "./metrics";
import { fixtureContext, fixtureTools } from "./repository";

const live = process.env.SHERPA_LIVE_EVAL === "1";
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Configure ${name} before running live evaluations.`);
  return value;
}

/** Count final judge decisions once even when a context retry revisits a candidate. */
function observe(registry: ProviderRegistry) {
  const decisions = new Map<string, string>();
  // Only enabled for the fixed, checked-in evaluation fixtures; never production PRs.
  const trace: unknown[] = [];
  const providers: ProviderRegistry = {};
  for (const [provider, client] of Object.entries(registry)) {
    if (!client) continue;
    const wrapped: ModelProvider = {
      maxRetries: client.maxRetries,
      complete: async (request) => {
        const response = await client.complete(request);
        try {
          const body = JSON.parse(response.text) as {
            decisions?: { candidateId: string; verdict: string }[];
          };
          if (process.env.SHERPA_EVAL_TRACE === "1") {
            const input = JSON.parse(request.user) as { phase?: string; originalTask?: string };
            trace.push({
              agent:
                /Domain: ([a-z]+)\./.exec(request.system)?.[1] ??
                (request.system.includes("final judge") ? "judge" : "router"),
              phase: input.phase,
              correction: Boolean(input.originalTask),
              output: body,
            });
          }
          for (const decision of body.decisions ?? []) {
            if (typeof decision.candidateId === "string" && typeof decision.verdict === "string")
              decisions.set(decision.candidateId, decision.verdict);
          }
        } catch {
          /* The production schema reports malformed responses. */
        }
        return response;
      },
    };
    providers[provider as ModelRef["provider"]] = wrapped;
  }
  return {
    providers,
    trace,
    counts: () => ({
      judgedCandidates: decisions.size,
      judgeRejections: [...decisions.values()].filter((decision) => decision === "reject").length,
    }),
  };
}

describe.skipIf(!live)("paired live model evaluation (explicit opt-in)", () => {
  it("records precision, high-impact recall, cost and latency for frozen and current reviewers", async () => {
    if (existsSync("apps/worker/.dev.vars")) process.loadEnvFile("apps/worker/.dev.vars");
    const maxUsd = Number(required("SHERPA_EVAL_MAX_USD"));
    const repetitions = Number(process.env.SHERPA_EVAL_REPETITIONS ?? 1);
    if (
      !(maxUsd > 0 && maxUsd <= 100) ||
      !Number.isInteger(repetitions) ||
      repetitions < 1 ||
      repetitions > 5
    )
      throw new Error("Set a positive spend cap <=100 USD and 1-5 repetitions.");
    const pricing = pricingTableSchema.parse(JSON.parse(required("MODEL_PRICING_JSON")));
    const models = Object.fromEntries(
      [
        ["router", "ROUTER_MODEL"],
        ["specialist", "SPECIALIST_MODEL"],
        ["judge", "JUDGE_MODEL"],
      ].map(([role, variable]) => [role, { provider: "cloudflare", model: required(variable!) }]),
    ) as Record<"router" | "specialist" | "judge", ModelRef>;
    for (const ref of Object.values(models))
      if (!pricing[`${ref.provider}/${ref.model}`])
        throw new Error(`Missing configured price for ${ref.provider}/${ref.model}.`);
    const providers = createProviderRegistry({
      cloudflareGateway: {
        accountId: required("CLOUDFLARE_ACCOUNT_ID"),
        gatewayId: required("CLOUDFLARE_AI_GATEWAY_ID"),
        apiToken: required("CLOUDFLARE_AI_GATEWAY_TOKEN"),
      },
      maxRetries: 0,
    });
    const selected = process.env.SHERPA_EVAL_CASES?.split(",");
    const fixtures = selected
      ? evalFixtures.filter((fixture) => selected.includes(fixture.id))
      : evalFixtures;
    if (!fixtures.length || selected?.some((id) => !fixtures.some((fixture) => fixture.id === id)))
      throw new Error("Unknown or empty SHERPA_EVAL_CASES.");
    const config = repoConfigSchema.parse({
      models: { router: models.router },
      budget: {
        maxUsdPerReview: maxUsd / (fixtures.length * repetitions * 2),
        maxAgentCalls: 24,
        maxDurationMs: 600000,
      },
      // Fixtures expose recorded scanner results, never execute model-generated commands.
      validation: { enabled: true, security: true, tests: false, typecheck: false, lint: false },
    });
    const runs: Record<"baseline" | "current", EvaluationRun[]> = { baseline: [], current: [] };
    const traces: unknown[] = [];
    for (let repetition = 0; repetition < repetitions; repetition++) {
      for (let index = 0; index < fixtures.length; index++) {
        const fixture = fixtures[index]!;
        // Alternate order to reduce systematic warm-cache/time-of-day effects.
        const order =
          (index + repetition) % 2
            ? (["current", "baseline"] as const)
            : (["baseline", "current"] as const);
        for (const version of order) {
          const observer = observe(providers);
          const tools = fixtureTools(fixture);
          const started = performance.now();
          const result = await (version === "baseline" ? runBaseline : runReview)({
            context: fixtureContext(fixture),
            tools,
            config,
            models,
            providers: observer.providers,
            pricing,
            incrementalBaseSha: fixtureContext(fixture).baseSha,
          });
          runs[version].push({
            fixture,
            result,
            latencyMs: performance.now() - started,
            ...observer.counts(),
          });
          if (process.env.SHERPA_EVAL_TRACE === "1")
            traces.push({
              version,
              fixtureId: fixture.id,
              responses: observer.trace,
              tools: tools.calls,
            });
          // Incremental report survives an interrupted comparison without exposing credentials/prompts.
          await mkdir("artifacts/evals", { recursive: true });
          const metrics = { baseline: measure(runs.baseline), current: measure(runs.current) };
          await writeFile(
            "artifacts/evals/live.json",
            JSON.stringify(
              {
                mode: "live-model",
                timestamp: new Date().toISOString(),
                models,
                pricing,
                maxUsd,
                repetitions,
                ...(traces.length ? { traces } : {}),
                ...metrics,
                comparison: compareQuality(metrics.baseline, metrics.current),
                runs: Object.fromEntries(
                  Object.entries(runs).map(([label, entries]) => [
                    label,
                    entries.map((run) => ({
                      fixtureId: run.fixture.id,
                      result: run.result,
                      latencyMs: run.latencyMs,
                      judgedCandidates: run.judgedCandidates,
                      judgeRejections: run.judgeRejections,
                    })),
                  ]),
                ),
                limitations:
                  "Small curated suite; heuristic root-cause matching requires manual review. Findings and low-volume statistical differences are not population-level quality estimates.",
              },
              null,
              2,
            ) + "\n",
          );
        }
      }
    }
  }, 43_200_000);
});
