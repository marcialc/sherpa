import type { Finding, FindingPriority, ReviewOutcome, ReviewResult, ReviewVerdict } from "./types";

export const priorityOrder: Record<FindingPriority, number> = {
  must_fix: 0,
  should_fix: 1,
  warning: 2,
  nit: 3,
};
export const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;

/** Final priority takes precedence over the specialist's estimate of technical severity. */
export function compareFindings(a: Finding, b: Finding): number {
  const productionImpact = (finding: Finding) =>
    finding.category === "security" || finding.category === "correctness" ? 0 : 1;
  return (
    priorityOrder[a.priority] - priorityOrder[b.priority] ||
    severityOrder[a.severity] - severityOrder[b.severity] ||
    productionImpact(a) - productionImpact(b) ||
    b.confidence - a.confidence
  );
}

/** Only call with findings accepted and classified by the final judge. */
export function calculateVerdict(findings: Finding[]): ReviewVerdict {
  if (findings.some((finding) => finding.priority === "must_fix")) return "NOT_APPROVED";
  return findings.length ? "APPROVED_WITH_COMMENTS" : "APPROVED";
}

/** Keep operational failure distinct from a completed review's merge decision. */
export function calculateOutcome(findings: Finding[], coverageComplete: boolean): ReviewOutcome {
  const verdict = calculateVerdict(findings);
  if (verdict === "NOT_APPROVED") return "NEEDS_ATTENTION";
  if (!coverageComplete) return "REVIEW_FAILED";
  return verdict === "APPROVED_WITH_COMMENTS" ? "PASS_WITH_FINDINGS" : "PASS";
}

export function completedVerdict(result: ReviewResult): ReviewVerdict | null {
  const verdict = calculateVerdict(result.findings);
  if (verdict === "NOT_APPROVED") return verdict;
  if (!result.coverageComplete || result.outcome === "REVIEW_FAILED") return null;
  return verdict;
}
