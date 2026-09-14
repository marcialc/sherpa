import { describe, expect, it } from "vitest";
import { type Finding, type ReviewResult } from "@sherpa/schemas";
import { compareQuality, measure, type EvaluationRun } from "./metrics";
import { evalFixtures } from "./fixtures";

const bug = evalFixtures.find((fixture) => fixture.id === "arithmetic-regression")!;
const clean = evalFixtures.find((item) => item.id === "caller-validation")!;
const finding: Finding = {
  id: "math",
  path: "src/math.js",
  line: 2,
  title: "Addition subtracts",
  description: "add(5, 2) returns 3.",
  severity: "high",
  priority: "must_fix",
  category: "correctness",
  confidence: 0.99,
  evidence: ["return left - right;"],
  originatingAgent: "correctness",
};
function run(fixture = bug, findings = [finding], complete = true): EvaluationRun {
  const result: ReviewResult = {
    findings,
    coverageComplete: complete,
    outcome: "PASS",
    cost: { totalEstimatedUsd: 0.01, unpricedCalls: 0, calls: [] },
    risk: { score: 1, reasons: [], agents: [], skip: false },
    warnings: [],
    reviewedHeadSha: "b".repeat(40),
    incrementalBaseSha: "a".repeat(40),
  };
  return { fixture, result, latencyMs: 10, judgedCandidates: 2, judgeRejections: 1 };
}
describe("precision-first evaluation metrics", () => {
  it("counts duplicates as noise and detects wrong anchors independently", () => {
    const metrics = measure([
      run(bug, [
        finding,
        { ...finding, id: "duplicate" },
        { ...finding, id: "bad-line", line: 99 },
      ]),
      run(clean, []),
    ]);
    expect(metrics).toMatchObject({
      truePositives: 1,
      falsePositives: 2,
      duplicateFindings: 1,
      invalidLineAnchors: 1,
      precision: 1 / 3,
      highSeverityMisses: 0,
      highSeverityRecall: 1,
      averageFindingsPerPr: 1.5,
      judgeRejectionRate: 0.5,
      costUsd: 0.02,
      averageLatencyMs: 10,
    });
  });
  it("counts abstentions and incomplete reviews as high-impact misses", () => {
    expect(measure([run(bug, [], false)])).toMatchObject({
      truePositives: 0,
      falseNegatives: 1,
      highSeverityMisses: 1,
      highSeverityRecall: 0,
      precision: null,
      incompleteReviews: 1,
    });
  });
  it("cannot declare improvement by refusing all candidates", () => {
    const baseline = measure([run(bug), run(clean, [{ ...finding, path: clean.files[0]!.path }])]);
    const current = measure([run(bug, [], false), run(clean, [], false)]);
    expect(compareQuality(baseline, current)).toMatchObject({ betterOnThisSample: false });
    expect(compareQuality(baseline, current).regressions).toContain("more high/critical misses");
  });
  it("recognizes fewer false positives while retaining known serious bugs", () => {
    const baseline = measure([run(bug), run(clean, [{ ...finding, path: clean.files[0]!.path }])]);
    const current = measure([run(bug), run(clean, [])]);
    expect(compareQuality(baseline, current)).toEqual({
      betterOnThisSample: true,
      regressions: [],
    });
  });
  it("rejects empty or unpaired before/after comparisons", () => {
    expect(compareQuality(measure([]), measure([])).betterOnThisSample).toBe(false);
    expect(compareQuality(measure([run(bug)]), measure([])).regressions).toContain(
      "unpaired or empty sample",
    );
  });
});
