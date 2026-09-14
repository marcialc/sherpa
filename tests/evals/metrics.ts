import type { Finding, ReviewResult } from "@sherpa/schemas";
import { reviewableLines } from "@sherpa/agents";
import type { EvalFixture, KnownBug } from "./fixtures";

export type EvaluationRun = {
  fixture: EvalFixture;
  result: ReviewResult;
  latencyMs: number;
  judgedCandidates: number;
  judgeRejections: number;
};
export type QualityMetrics = {
  reviews: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  highSeverityMisses: number;
  highSeverityRecall: number | null;
  precision: number | null;
  duplicateFindings: number;
  invalidLineAnchors: number;
  averageFindingsPerPr: number;
  judgeRejectionRate: number | null;
  judgedCandidates: number;
  judgeRejections: number;
  costUsd: number;
  modelCalls: number;
  averageLatencyMs: number;
  incompleteReviews: number;
};

/** Fixture labels are manually curated. Matches include root-cause words, path and line. */
export function matchesBug(finding: Finding, bug: KnownBug): boolean {
  return (
    finding.path === bug.path &&
    finding.line !== undefined &&
    bug.lines.includes(finding.line) &&
    new RegExp(bug.titlePattern, "i").test(`${finding.title} ${finding.description}`)
  );
}

export function measure(runs: EvaluationRun[]): QualityMetrics {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let highSeverityMisses = 0;
  let highSeverityBugs = 0;
  let duplicateFindings = 0;
  let invalidLineAnchors = 0;
  let count = 0;
  for (const { fixture, result } of runs) {
    const matched = new Set<string>();
    count += result.findings.length;
    for (const finding of result.findings) {
      const file = fixture.files.find((item) => item.path === finding.path);
      if (
        !file ||
        !reviewableLines(file).some((line) => line.line === finding.line) ||
        (finding.startLine !== undefined &&
          (finding.startLine > finding.line! || finding.line! - finding.startLine > 10))
      )
        invalidLineAnchors++;
      const bug = fixture.expected.find((item) => matchesBug(finding, item));
      if (!bug) falsePositives++;
      else if (matched.has(bug.id)) {
        duplicateFindings++;
        falsePositives++;
      } else {
        matched.add(bug.id);
        truePositives++;
      }
    }
    for (const bug of fixture.expected) {
      const high = bug.severity === "high" || bug.severity === "critical";
      if (high) highSeverityBugs++;
      if (!matched.has(bug.id)) {
        falseNegatives++;
        if (high) highSeverityMisses++;
      }
    }
  }
  const judgedCandidates = runs.reduce((sum, run) => sum + run.judgedCandidates, 0);
  const judgeRejections = runs.reduce((sum, run) => sum + run.judgeRejections, 0);
  return {
    reviews: runs.length,
    truePositives,
    falsePositives,
    falseNegatives,
    highSeverityMisses,
    highSeverityRecall: highSeverityBugs
      ? (highSeverityBugs - highSeverityMisses) / highSeverityBugs
      : null,
    precision:
      truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : null,
    duplicateFindings,
    invalidLineAnchors,
    averageFindingsPerPr: runs.length ? count / runs.length : 0,
    judgedCandidates,
    judgeRejections,
    judgeRejectionRate: judgedCandidates ? judgeRejections / judgedCandidates : null,
    costUsd: runs.reduce((sum, run) => sum + run.result.cost.totalEstimatedUsd, 0),
    modelCalls: runs.reduce((sum, run) => sum + run.result.cost.calls.length, 0),
    averageLatencyMs: runs.length
      ? runs.reduce((sum, run) => sum + run.latencyMs, 0) / runs.length
      : 0,
    incompleteReviews: runs.filter((run) => !run.result.coverageComplete).length,
  };
}

/** Precision is first; retain high-impact recall and avoid winning by failing closed. */
export function compareQuality(baseline: QualityMetrics, current: QualityMetrics) {
  const regressions: string[] = [];
  if (current.reviews !== baseline.reviews || current.reviews === 0)
    regressions.push("unpaired or empty sample");
  if (current.incompleteReviews > baseline.incompleteReviews)
    regressions.push("more incomplete reviews");
  if (current.falsePositives > baseline.falsePositives) regressions.push("more false positives");
  if ((current.precision ?? 0) < (baseline.precision ?? 0)) regressions.push("lower precision");
  if (current.highSeverityMisses > baseline.highSeverityMisses)
    regressions.push("more high/critical misses");
  if (current.duplicateFindings > baseline.duplicateFindings)
    regressions.push("more duplicate findings");
  if (current.invalidLineAnchors > baseline.invalidLineAnchors)
    regressions.push("more invalid anchors");
  const improved =
    current.falsePositives < baseline.falsePositives ||
    current.highSeverityMisses < baseline.highSeverityMisses;
  return { betterOnThisSample: regressions.length === 0 && improved, regressions };
}
