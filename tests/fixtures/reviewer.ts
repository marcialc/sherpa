import type { AgentName } from "@sherpa/schemas";
import type { EvidenceChecks, EvidenceRecord, Hypothesis } from "@sherpa/agents";
import type { ModelRequest, ModelResponse } from "@sherpa/models";

export type ReplayEnvelope = {
  phase: "ANALYZE" | "VERIFY" | "DECIDE";
  untrustedHypotheses?: Hypothesis[];
  unverifiedCandidates?: {
    id: string;
    hypothesis: Pick<
      Hypothesis,
      "id" | "title" | "path" | "line" | "category" | "disproofQuestion" | "verificationRequests"
    >;
  }[];
  attestedEvidence?: EvidenceRecord[];
  contextDiscoveryRequired?: boolean;
};

/** Scripted protocol helper, not a simulated quality evaluation or a model judge. */
export function checksFor(
  hypothesis: Hypothesis,
  records: EvidenceRecord[],
  owner: AgentName | "judge",
): EvidenceChecks {
  const own = records.filter(
    (record) => record.owner === owner && record.hypothesisId === hypothesis.id,
  );
  const head = own.find((record) => record.purpose === "head");
  const baseline = own.find((record) => record.purpose === "baseline");
  const disproof = own.find((record) => record.purpose === "investigation");
  if (!head || !baseline || !disproof)
    throw new Error("Replay requires real executor records for all phases.");
  const quote = (record: EvidenceRecord, line?: number) => {
    const rows = record.result.output.split("\n").filter((value) => value.trim().length >= 4);
    const source =
      (line ? rows.find((value) => value.startsWith(`${line}: `)) : undefined) ?? rows[0];
    if (!source) throw new Error("Replay evidence has no usable literal quote.");
    return { evidenceId: record.id, quote: source.slice(0, 500) };
  };
  const h = quote(head, hypothesis.line);
  const b = quote(baseline, hypothesis.line);
  const d = quote(disproof);
  return {
    trigger: { statement: hypothesis.trigger, citations: [d] },
    actualBehavior: { statement: hypothesis.actualBehavior, citations: [h] },
    expectedBehavior: { statement: hypothesis.expectedBehavior, citations: [b, d] },
    impact: { statement: hypothesis.impact, citations: [h, d] },
    causality: { statement: hypothesis.causality, citations: [h, b] },
    disproof: {
      statement: "The inspected caller has no mitigation for the demonstrated changed behavior.",
      citations: [d],
    },
    anchor: {
      statement: "The cited source line is the changed behavior in this patch.",
      citations: [h],
    },
  };
}

export function modelResponse(value: unknown): ModelResponse {
  return {
    text: JSON.stringify(value),
    usage: { inputTokens: 100, outputTokens: 100 },
    durationMs: 1,
  };
}

export function replayResponse(
  request: ModelRequest,
  options: {
    hypothesis: Hypothesis;
    relatedPath: string;
    reject?: boolean;
    forgeDisproof?: boolean;
    finalPriority?: "must_fix" | "should_fix" | "warning" | "nit";
  },
): ModelResponse {
  const envelope = JSON.parse(request.user) as ReplayEnvelope;
  if (envelope.contextDiscoveryRequired)
    return modelResponse({
      phase: "ANALYZE",
      hypotheses: [],
      requests: [{ tool: "readFile", path: options.relatedPath, startLine: 1, endLine: 60 }],
    });
  if (envelope.phase === "ANALYZE")
    return modelResponse({ phase: "ANALYZE", hypotheses: [options.hypothesis] });
  const records = envelope.attestedEvidence ?? [];
  if (envelope.untrustedHypotheses) {
    return modelResponse({
      phase: "VERIFY",
      assessments: envelope.untrustedHypotheses.map((hypothesis) => {
        if (options.reject)
          return {
            hypothesisId: hypothesis.id,
            decision: "rejected",
            reason: "Repository inspection disproves the suspected regression.",
          };
        const owner = records.find((record) => record.hypothesisId === hypothesis.id)!.owner;
        const checks = checksFor(hypothesis, records, owner);
        if (options.forgeDisproof)
          checks.disproof.citations = [
            { evidenceId: "invented-evidence", quote: "There is no validation in any caller." },
          ];
        return {
          hypothesisId: hypothesis.id,
          decision: "confirmed",
          reason: "The baseline and inspected caller establish the concrete regression.",
          checks,
          suggestedFix:
            "Restore the previous guarded behavior while preserving the caller contract.",
        };
      }),
    });
  }
  if (envelope.phase === "VERIFY")
    return modelResponse({
      phase: "VERIFY",
      requests: (envelope.unverifiedCandidates ?? []).map((candidate) => ({
        candidateId: candidate.id,
        question: "Does the reachable caller already prevent this trigger or handle the failure?",
        request: { tool: "readFile", path: options.relatedPath, startLine: 1, endLine: 60 },
      })),
    });
  return modelResponse({
    phase: "DECIDE",
    decisions: Object.fromEntries(
      (envelope.unverifiedCandidates ?? []).map((candidate) => [
        candidate.id,
        {
          verdict: "accept",
          reason:
            "Independent repository reads establish the failure and rule out the proposed mitigation.",
          checks: checksFor({ ...options.hypothesis, ...candidate.hypothesis }, records, "judge"),
          usefulness:
            "An engineer should restore the broken contract before users encounter the demonstrated failure.",
          confidence: 0.98,
          finalSeverity: "high",
          finalPriority: options.finalPriority ?? "must_fix",
          suggestedFixSafe: true,
          suggestedFix:
            "Restore the previous guarded behavior while preserving the caller contract.",
        },
      ]),
    ),
  });
}
