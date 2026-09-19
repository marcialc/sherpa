import { z } from "zod";
import {
  categorySchema,
  findingPrioritySchema,
  repositoryPathSchema,
  severitySchema,
  toolRequestSchema,
  type AgentName,
  type ChangedFile,
  type ToolRequest,
  type ToolResult,
} from "@sherpa/schemas";
import { ProviderError } from "@sherpa/models";
import { reviewableLines } from "./findings";

/**
 * Widest line range a readFile or gitShow request may ask for. The executor refuses a
 * wider one outright, which ends that reviewer, so the prompt has to quote this same
 * number -- a model cannot respect a limit it is never told. One constant so the rule
 * and its description cannot drift apart.
 */
export const maxToolLineSpan = 99;

/** Validate every current tool variant without silently dropping unexpected keys. */
export const strictToolRequestSchema = z
  .custom<ToolRequest>(
    (value) => toolRequestSchema.options.some((option) => option.strict().safeParse(value).success),
    { message: "Invalid scoped tool request" },
  )
  .transform((value) => toolRequestSchema.parse(value));
const statement = z.string().trim().min(8).max(500);
// Internal decision explanations are not published findings. Give them bounded
// headroom so a useful explanation slightly over 500 characters cannot abort a review.
const decisionReason = z.string().trim().min(8).max(1500);
const id = z.string().min(1).max(100);
export const hypothesisSchema = z
  .object({
    id,
    title: z.string().trim().min(8).max(160),
    path: repositoryPathSchema,
    line: z.number().int().positive(),
    startLine: z.number().int().positive().optional(),
    category: categorySchema,
    trigger: statement,
    actualBehavior: statement,
    expectedBehavior: statement,
    impact: statement,
    causality: statement,
    disproofQuestion: statement,
    verificationRequests: z.array(strictToolRequestSchema).min(1).max(3),
    relatedSymbols: z.array(z.string().min(1).max(100)).max(8).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.startLine === undefined ||
      (value.startLine <= value.line && value.line - value.startLine <= 10),
    "Invalid hypothesis range",
  );
export type Hypothesis = z.infer<typeof hypothesisSchema>;
/** Testing must retrieve repository context before making its first assessment. */
export const analysisContextSchema = z
  .object({
    phase: z.literal("ANALYZE"),
    hypotheses: z.array(hypothesisSchema).max(0),
    requests: z.array(strictToolRequestSchema).min(1).max(2),
  })
  .strict();
export const analysisResponseSchema = z
  .object({
    phase: z.literal("ANALYZE"),
    hypotheses: z.array(hypothesisSchema).max(3),
    requests: z.array(strictToolRequestSchema).max(2).optional(),
  })
  .strict();
export const citationSchema = z
  .object({ evidenceId: id, quote: z.string().trim().min(4).max(500) })
  .strict();
export const evidenceClaimSchema = z
  .object({ statement, citations: z.array(citationSchema).min(1).max(3) })
  .strict();
export const evidenceChecksSchema = z
  .object({
    trigger: evidenceClaimSchema,
    actualBehavior: evidenceClaimSchema,
    expectedBehavior: evidenceClaimSchema,
    impact: evidenceClaimSchema,
    causality: evidenceClaimSchema,
    disproof: evidenceClaimSchema,
    anchor: evidenceClaimSchema,
  })
  .strict();
export type EvidenceChecks = z.infer<typeof evidenceChecksSchema>;
const assessmentSchema = z
  .object({
    hypothesisId: id,
    decision: z.enum(["confirmed", "rejected", "needs-more-context"]),
    reason: decisionReason,
    checks: evidenceChecksSchema.optional(),
    suggestedFix: z.string().trim().min(8).max(1000).optional(),
    requests: z.array(strictToolRequestSchema).min(1).max(2).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === "confirmed" && !value.checks)
      context.addIssue({ code: "custom", message: "Confirmation requires attested checks" });
    if (value.decision === "needs-more-context" && !value.requests?.length)
      context.addIssue({ code: "custom", message: "Context requests are required" });
    if (value.decision !== "needs-more-context" && value.requests)
      context.addIssue({ code: "custom", message: "Unexpected context requests" });
  });
export const verificationResponseSchema = z
  .object({ phase: z.literal("VERIFY"), assessments: z.array(assessmentSchema).max(3) })
  .strict();
export const judgeInvestigationSchema = z
  .object({
    phase: z.literal("VERIFY"),
    requests: z
      .array(
        z
          .object({ candidateId: id, question: statement, request: strictToolRequestSchema })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
const judgeDecisionSchema = z
  .object({
    verdict: z.enum(["accept", "reject", "merge", "needs-more-context"]),
    reason: decisionReason,
    checks: evidenceChecksSchema.optional(),
    usefulness: statement.optional(),
    confidence: z.number().min(0).max(1).optional(),
    finalSeverity: severitySchema.optional(),
    finalPriority: findingPrioritySchema.optional(),
    suggestedFix: z.string().trim().min(8).max(1000).optional(),
    suggestedFixSafe: z.boolean().optional(),
    mergedWith: z.array(id).max(5).optional(),
    requests: z.array(strictToolRequestSchema).min(1).max(2).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.verdict === "accept" || value.verdict === "merge") &&
      (!value.checks ||
        !value.usefulness ||
        value.confidence === undefined ||
        !value.finalSeverity ||
        !value.finalPriority)
    )
      context.addIssue({
        code: "custom",
        message:
          "Acceptance requires independent attested checks, usefulness and final classification",
      });
    if (value.verdict === "needs-more-context" && !value.requests?.length)
      context.addIssue({ code: "custom", message: "Context requests are required" });
    if (value.verdict !== "needs-more-context" && value.requests)
      context.addIssue({ code: "custom", message: "Unexpected context requests" });
  });
export type JudgeDecision = z.infer<typeof judgeDecisionSchema> & { candidateId: string };
/**
 * The wire shape keys decisions by candidate id, so a strict JSON schema makes "exactly one
 * verdict per candidate" structural: every id is required and no other key is accepted. The
 * decoded value keeps the flat `decisions` array the pipeline consumes, with the key restored
 * as `candidateId`.
 */
export function judgeResponseSchemaFor(
  candidateIds: string[],
): z.ZodType<{ phase: "DECIDE"; decisions: JudgeDecision[] }> {
  return z
    .object({
      phase: z.literal("DECIDE"),
      decisions: z
        .object(
          Object.fromEntries(candidateIds.map((candidateId) => [candidateId, judgeDecisionSchema])),
        )
        .strict(),
    })
    .strict()
    .transform(({ phase, decisions }) => ({
      phase,
      decisions: Object.entries(decisions).map(([candidateId, decision]) => ({
        candidateId,
        ...decision,
      })),
    }));
}

export type EvidenceRecord = {
  id: string;
  hypothesisId: string;
  owner: AgentName | "judge";
  purpose: "head" | "baseline" | "investigation" | "discovery";
  request: ToolRequest;
  result: ToolResult;
};
export type VerifiedCandidate = {
  id: string;
  originatingAgent: AgentName;
  hypothesis: Hypothesis;
  checks: EvidenceChecks;
  suggestedFix?: string;
  evidence: EvidenceRecord[];
};

/**
 * Model id sets are reconciled, never trusted. A duplicate or unknown id is dropped and the
 * unanswered ids are reported, so one malformed response narrows a batch instead of discarding it.
 * Callers must treat `missing` as a coverage gap wherever the dropped entry carried a decision.
 */
export function reconcileIds<T>(
  expected: string[],
  received: T[],
  idOf: (item: T) => string,
): { answered: T[]; missing: string[] } {
  const seen = new Set<string>();
  const answered = received.filter((item) => {
    const id = idOf(item);
    if (seen.has(id) || !expected.includes(id)) return false;
    seen.add(id);
    return true;
  });
  return { answered, missing: expected.filter((id) => !seen.has(id)) };
}

function requestPath(record: EvidenceRecord): string | undefined {
  return "path" in record.request ? record.request.path : undefined;
}
/** Only protocol paths and fixed reason codes may leave the validator. */
export class EvidenceAttestationError extends ProviderError {
  constructor(
    readonly issuePath: (string | number)[],
    readonly rule: string,
  ) {
    super("UNATTESTED_EVIDENCE");
  }
}

/** References are looked up in executor-owned records, never accepted from model JSON. */
export function attestChecks(
  checks: EvidenceChecks,
  hypothesis: Hypothesis,
  records: EvidenceRecord[],
  owner: AgentName | "judge",
  files: ChangedFile[],
): void {
  const file = files.find((item) => item.path === hypothesis.path);
  if (!file) throw new ProviderError("INVALID_CHANGED_ANCHOR");
  const referenced = (claim: z.infer<typeof evidenceClaimSchema>) =>
    claim.citations.map((citation, index) => {
      const record = records.find((item) => item.id === citation.evidenceId);
      const claimName = Object.entries(checks).find(([, value]) => value === claim)![0];
      const fail = (field: string, rule: string): never => {
        throw new EvidenceAttestationError([claimName, "citations", index, field], rule);
      };
      if (!record) return fail("evidenceId", "EVIDENCE_ID_NOT_FOUND");
      if (record.hypothesisId !== hypothesis.id)
        return fail("evidenceId", "EVIDENCE_WRONG_HYPOTHESIS");
      if (record.result.status !== "ok" || record.result.truncated)
        return fail("evidenceId", "EVIDENCE_NOT_COMPLETE");
      if (!record.result.output.includes(citation.quote))
        return fail("quote", "EVIDENCE_QUOTE_NOT_EXACT");
      if (citation.quote.includes("FILE_ABSENT_AT_REVISION") && record.result.fileExists !== false)
        return fail("quote", "EVIDENCE_ABSENCE_NOT_ATTESTED");
      return record;
    });
  for (const claim of Object.values(checks)) referenced(claim);
  const own = (record: EvidenceRecord, purpose: EvidenceRecord["purpose"]) => {
    if (record.owner !== owner) return false;
    if (purpose === "investigation") return record.purpose === "investigation";
    // Adaptive reads retain executor-owned investigation provenance while their
    // immutable request semantics also establish source revision eligibility.
    if (purpose === "head")
      return (
        record.request.tool === "readFile" ||
        (record.request.tool === "gitShow" && record.request.revision === "head")
      );
    return record.request.tool === "gitShow" && record.request.revision === "previous";
  };
  if (
    !referenced(checks.actualBehavior).some(
      (record) => own(record, "head") && requestPath(record) === hypothesis.path,
    )
  )
    throw new ProviderError("MISSING_FACTUAL_CONTEXT");
  const causality = referenced(checks.causality);
  if (
    !causality.some((record) => own(record, "head") && requestPath(record) === hypothesis.path) ||
    !causality.some(
      (record) =>
        own(record, "baseline") &&
        requestPath(record) === (file.previousPath ?? hypothesis.path) &&
        (record.result.fileExists !== false || file.status === "added"),
    )
  )
    throw new ProviderError("MISSING_CAUSAL_CONTEXT");
  if (!referenced(checks.disproof).some((record) => own(record, "investigation")))
    throw new ProviderError("MISSING_DISPROOF_ATTEMPT");
  const anchors = reviewableLines(file).filter(
    (line) =>
      line.line >= (hypothesis.startLine ?? hypothesis.line) &&
      line.line <= hypothesis.line &&
      line.text.trim().length >= 4,
  );
  if (
    !anchors.some((line) => line.line === hypothesis.line) ||
    !checks.anchor.citations.some((citation) => {
      const record = records.find((item) => item.id === citation.evidenceId)!;
      return (
        own(record, "head") &&
        requestPath(record) === hypothesis.path &&
        anchors.some((line) => citation.quote.includes(line.text.trim()))
      );
    })
  )
    throw new ProviderError("INVALID_CHANGED_ANCHOR");
  const primary = anchors.find((line) => line.line === hypothesis.line)!;
  if (
    !checks.actualBehavior.citations.some((citation) => {
      const record = records.find((item) => item.id === citation.evidenceId)!;
      return (
        own(record, "head") &&
        requestPath(record) === hypothesis.path &&
        citation.quote.includes(primary.text.trim())
      );
    })
  )
    throw new ProviderError("MISSING_ACTUAL_BEHAVIOR_ANCHOR");
  if (
    primary.kind === "deletion-context" &&
    !checks.causality.citations.some((citation) => {
      const record = records.find((item) => item.id === citation.evidenceId)!;
      return (
        own(record, "baseline") &&
        primary.removedLines.some(
          (line) => line.text.trim().length >= 4 && citation.quote.includes(line.text.trim()),
        )
      );
    })
  )
    throw new ProviderError("MISSING_DELETION_EVIDENCE");
}
