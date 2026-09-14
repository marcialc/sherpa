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

/** Validate every current tool variant without silently dropping unexpected keys. */
export const strictToolRequestSchema = z
  .custom<ToolRequest>(
    (value) => toolRequestSchema.options.some((option) => option.strict().safeParse(value).success),
    { message: "Invalid scoped tool request" },
  )
  .transform((value) => toolRequestSchema.parse(value));
const statement = z.string().trim().min(8).max(500);
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
export const analysisResponseSchema = z
  .object({ phase: z.literal("ANALYZE"), hypotheses: z.array(hypothesisSchema).max(3) })
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
    reason: statement,
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
export const judgeResponseSchema = z
  .object({
    phase: z.literal("DECIDE"),
    decisions: z
      .array(
        z
          .object({
            candidateId: id,
            verdict: z.enum(["accept", "reject", "merge", "needs-more-context"]),
            reason: statement,
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
          }),
      )
      .max(6),
  })
  .strict();

export type EvidenceRecord = {
  id: string;
  hypothesisId: string;
  owner: AgentName | "judge";
  purpose: "head" | "baseline" | "investigation";
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

export function validateIds(expected: string[], received: string[]): void {
  if (
    expected.length !== received.length ||
    new Set(received).size !== received.length ||
    received.some((value) => !expected.includes(value))
  )
    throw new ProviderError("INVALID_INVESTIGATION_IDS");
}

function requestPath(record: EvidenceRecord): string | undefined {
  return "path" in record.request ? record.request.path : undefined;
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
    claim.citations.map((citation) => {
      const record = records.find((item) => item.id === citation.evidenceId);
      if (
        !record ||
        record.hypothesisId !== hypothesis.id ||
        record.result.status !== "ok" ||
        record.result.truncated ||
        !record.result.output.includes(citation.quote) ||
        (citation.quote.includes("FILE_ABSENT_AT_REVISION") && record.result.fileExists !== false)
      )
        throw new ProviderError("UNATTESTED_EVIDENCE");
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
