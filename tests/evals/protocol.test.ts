import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { runReview, type Hypothesis, type RunReviewOptions } from "@sherpa/agents";
import { repoConfigSchema, type Finding } from "@sherpa/schemas";
import type { ModelProvider } from "@sherpa/models";
import { runReview as runBaseline } from "./baseline/review";
import { evalFixtures, type EvalFixture } from "./fixtures";
import { fixtureContext, fixtureTools } from "./repository";
import { measure, type EvaluationRun } from "./metrics";
import { modelResponse, replayResponse } from "../fixtures/reviewer";

function proposal(fixture: EvalFixture): {
  hypothesis: Hypothesis;
  finding: Finding;
  relatedPath: string;
} {
  const file = fixture.files[0]!;
  const line = fixture.expected[0]?.lines.at(-1) ?? 2;
  const title =
    fixture.expected[0]?.description.slice(0, 150) ??
    "Input validation appears missing from the changed code";
  const description =
    fixture.expected[0]?.description ??
    "The diff alone appears to lack a guard for the alleged dangerous input.";
  const relatedPath = Object.keys(fixture.head).find((path) => path !== file.path)!;
  return {
    relatedPath,
    hypothesis: {
      id: "local-1",
      title,
      path: file.path,
      line,
      category: fixture.id.includes("authorization") ? "security" : "correctness",
      trigger:
        fixture.expected[0]?.description ??
        "A caller supplies the allegedly dangerous input to this function.",
      actualBehavior: description,
      expectedBehavior: "The caller's contract requires the previous correctly guarded behavior.",
      impact: "The claimed changed behavior would produce an incorrect caller-visible result.",
      causality:
        "The changed implementation allegedly removes required behavior present at baseline.",
      disproofQuestion:
        "Does the relevant caller, framework or configuration already prevent this failure?",
      verificationRequests: [{ tool: "readFile", path: relatedPath, startLine: 1, endLine: 60 }],
    },
    finding: {
      id: "candidate",
      title,
      description,
      path: file.path,
      line,
      severity: "high",
      priority: "must_fix",
      category: "correctness",
      confidence: 0.98,
      evidence: [fixture.head[file.path]!.split("\n")[line - 1]!],
      suggestedFix: "Restore the prior behavior while preserving the caller contract.",
      originatingAgent: "lightweight",
    },
  };
}

function options(fixture: EvalFixture, provider: ModelProvider): RunReviewOptions {
  return {
    context: fixtureContext(fixture),
    tools: fixtureTools(fixture),
    config: repoConfigSchema.parse({
      routing: { paths: { "**": ["lightweight"] } },
      agents: {
        lightweight: true,
        correctness: false,
        security: false,
        performance: false,
        testing: false,
        types: false,
      },
    }),
    models: {
      router: { provider: "openai", model: "replay" },
      specialist: { provider: "openai", model: "replay" },
      judge: { provider: "openai", model: "judge" },
    },
    providers: { openai: provider },
    pricing: {
      "openai/replay": { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 },
      "openai/judge": { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 },
    },
    incrementalBaseSha: fixtureContext(fixture).baseSha,
  };
}

describe("paired adversarial protocol replay", () => {
  it.each([false, true])(
    "repairs the production missing reason/array checks shape without bypassing evidence checks (forged=%s)",
    async (forgeDisproof) => {
      const fixture = evalFixtures.find((item) => item.id === "authorization-bypass")!;
      const trace = proposal(fixture);
      let corrections = 0;
      const provider: ModelProvider = {
        complete: async (request) => {
          const envelope = JSON.parse(request.user) as {
            originalTask?: string;
            untrustedHypotheses?: unknown[];
          };
          if (envelope.originalTask) {
            corrections++;
            expect(request.system).toContain('"required":["hypothesisId","decision","reason"]');
            expect(JSON.parse(request.user).validationDetails).toEqual([
              {
                path: "assessments.0.reason",
                code: "invalid_type",
                expected: "string",
                received: "undefined",
              },
              {
                path: "assessments.0.checks",
                code: "invalid_type",
                expected: "object",
                received: "array",
                actualLength: 6,
              },
            ]);
            return replayResponse(
              { ...request, user: envelope.originalTask },
              { ...trace, forgeDisproof },
            );
          }
          const result = replayResponse(request, { ...trace, forgeDisproof });
          if (envelope.untrustedHypotheses) {
            expect(request.system).toContain('"required":["hypothesisId","decision","reason"]');
            const invalid = JSON.parse(result.text) as {
              assessments: { reason?: string; checks: Record<string, unknown> | unknown[] }[];
            };
            for (const assessment of invalid.assessments) {
              delete assessment.reason;
              assessment.checks = Object.values(assessment.checks).slice(0, 6);
            }
            return modelResponse(invalid);
          }
          return result;
        },
      };
      const onInvalidOutput = vi.fn();
      const result = await runReview({ ...options(fixture, provider), onInvalidOutput });
      expect(corrections).toBe(1);
      expect(onInvalidOutput).toHaveBeenCalledWith("lightweight", "VERIFY", {
        code: "MODEL_INVALID_SCHEMA",
        issues: ["assessments.0.reason:invalid_type", "assessments.0.checks:invalid_type"],
        issueCount: 2,
        details: [
          {
            path: "assessments.0.reason",
            code: "invalid_type",
            expected: "string",
            received: "undefined",
          },
          {
            path: "assessments.0.checks",
            code: "invalid_type",
            expected: "object",
            received: "array",
            actualLength: 6,
          },
        ],
      });
      expect(result.coverageComplete).toBe(!forgeDisproof);
      expect(result.findings).toHaveLength(forgeDisproof ? 0 : 1);
      if (forgeDisproof) expect(result.warnings.join(",")).toContain("MODEL_INVALID_SCHEMA");
      else expect(result.findings[0]?.priority).toBe("must_fix");
    },
  );
  it("retains supported bug traces and blocks fabricated evidence accepted by the frozen protocol", async () => {
    const selected = evalFixtures.filter((fixture) =>
      [
        "deleted-authorization-guard",
        "arithmetic-regression",
        "authorization-bypass",
        "caller-validation",
        "orm-parameterization",
        "react-escaping",
      ].includes(fixture.id),
    );
    const runs: Record<"baseline" | "current", EvaluationRun[]> = { baseline: [], current: [] };
    for (const fixture of selected) {
      const trace = proposal(fixture);
      for (const version of ["baseline", "current"] as const) {
        let judgedCandidates = 0;
        let judgeRejections = 0;
        const provider: ModelProvider = {
          complete: async (request) => {
            if (version === "baseline") {
              if (request.model !== "judge") return modelResponse({ findings: [trace.finding] });
              judgedCandidates++;
              return modelResponse({
                decisions: [
                  {
                    candidateId: "lightweight-0",
                    verdict: "accept",
                    reason: "The proposed claim is actionable and appears on the changed line.",
                    introducedByChange: true,
                    actionable: true,
                    confidence: 0.98,
                    finalSeverity: "high",
                    finalPriority: "must_fix",
                    suggestedFixSafe: true,
                  },
                ],
              });
            }
            const response = replayResponse(request, {
              ...trace,
              forgeDisproof: !fixture.expected.length,
            });
            const parsed = JSON.parse(response.text) as { decisions?: { verdict: string }[] };
            for (const decision of parsed.decisions ?? []) {
              judgedCandidates++;
              if (decision.verdict === "reject") judgeRejections++;
            }
            return response;
          },
        };
        const started = performance.now();
        const result = await (version === "baseline" ? runBaseline : runReview)(
          options(fixture, provider),
        );
        runs[version].push({
          fixture,
          result,
          latencyMs: performance.now() - started,
          judgedCandidates,
          judgeRejections,
        });
        if (version === "current") {
          expect(result.findings.length, `${fixture.id}: ${result.warnings.join(",")}`).toBe(
            fixture.expected.length ? 1 : 0,
          );
          expect(result.coverageComplete).toBe(Boolean(fixture.expected.length));
          if (!fixture.expected.length)
            expect(result.warnings.join(",")).toContain("MODEL_INVALID_SCHEMA");
        }
      }
    }
    const baseline = measure(runs.baseline);
    const current = measure(runs.current);
    expect(baseline).toMatchObject({ truePositives: 2, falsePositives: 3, highSeverityMisses: 1 });
    expect(current).toMatchObject({
      truePositives: 3,
      falsePositives: 0,
      highSeverityMisses: 0,
      duplicateFindings: 0,
      invalidLineAnchors: 0,
      incompleteReviews: 3,
    });
    await mkdir("artifacts/evals", { recursive: true });
    await writeFile(
      "artifacts/evals/protocol.json",
      JSON.stringify(
        {
          mode: "scripted-adversarial-protocol-replay",
          baseline,
          current,
          modelQualityConclusion:
            "Not measured. False-positive traces deliberately forge evidence IDs. The new protocol refuses those invalid traces and marks their reviews incomplete; this is a safety regression test, not a measured improvement in model reasoning.",
          costs: "Synthetic token records at test prices; no paid calls.",
        },
        null,
        2,
      ) + "\n",
    );
  });
});
