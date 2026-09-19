import { z } from "zod";
import {
  agentNameSchema,
  calculateOutcome,
  compareFindings,
  findingSchema,
  type AgentName,
  type ChangedFile,
  type Finding,
  type ModelRef,
  type PullRequestContext,
  type RepoConfig,
  type RepositoryTools,
  type ReviewResult,
} from "@sherpa/schemas";
import {
  BudgetError,
  ProviderError,
  ReviewBudget,
  structuredOutput,
  supportsStructuredOutput,
  type BudgetReserve,
  type PricingTable,
  type ProviderRegistry,
  type OutputDiagnostic,
} from "@sherpa/models";
import { reviewableLines, sameFinding, severityOrder } from "./findings";
import { routeReview } from "./routing";
import { trustedRulesFor } from "./policy";
import { judgePhasePrompt, routerPrompt, specialistPrompt, testingContextPrompt } from "./prompts";
import {
  constrainEvidenceIds,
  constrainNativeEvidence,
  disabledValidationTools,
  outputSchemaInstruction,
} from "./output-schema";
import { EvidenceStore } from "./evidence";
import { emitDiagnostic, type ReviewDiagnostic } from "./diagnostics";
import { retrieveDiscoveryContext, type RetrieveRepositoryContext } from "./repository-context";
import {
  analysisResponseSchema,
  analysisContextSchema,
  hypothesisSchema,
  strictToolRequestSchema,
  verificationResponseSchema,
  judgeInvestigationSchema,
  judgeResponseSchemaFor,
  attestChecks,
  EvidenceAttestationError,
  reconcileIds,
  type EvidenceChecks,
  type Hypothesis,
  type EvidenceRecord,
  type VerifiedCandidate,
} from "./investigation";

export {
  analysisResponseSchema,
  verificationResponseSchema,
  judgeInvestigationSchema,
  judgeResponseSchemaFor,
} from "./investigation";
export type {
  Hypothesis,
  EvidenceChecks,
  EvidenceRecord,
  VerifiedCandidate,
} from "./investigation";
export const specialistResponseSchema = analysisResponseSchema;
export type RunReviewOptions = {
  context: PullRequestContext;
  files?: ChangedFile[];
  tools: RepositoryTools;
  config: RepoConfig;
  models: { router: ModelRef; specialist: ModelRef; judge: ModelRef };
  providers: ProviderRegistry;
  pricing: PricingTable;
  previousFindings?: Finding[];
  incrementalBaseSha: string;
  reviewStartedAt?: number;
  retrieveRepositoryContext?: RetrieveRepositoryContext;
  onInvalidOutput?: (agent: string, phase: string, diagnostic: OutputDiagnostic) => void;
  onDiagnostic?: (event: ReviewDiagnostic) => void;
};

const inputLimit = 48000;
const verifyTokens = 4500;
const judgeTokens = 6500;
const maxCandidates = 6;
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;
const safeError = (error: unknown) =>
  error instanceof BudgetError || error instanceof ProviderError
    ? error.code
    : "REVIEW_COMPONENT_FAILED";

function codeContext(options: RunReviewOptions, files: ChangedFile[]) {
  let remaining = 12000;
  const selected = files.slice(0, 60).map((file) => {
    const raw = encoder.encode(file.patch ?? "");
    const used = Math.min(raw.byteLength, remaining, 6000);
    const patch = new TextDecoder().decode(raw.slice(0, used));
    remaining -= used;
    return {
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch,
      reviewableLines: reviewableLines({ ...file, patch }).map((line) => line.line),
      addedLines: reviewableLines({ ...file, patch })
        .filter((line) => line.kind === "added")
        .map(({ line, text }) => ({ line, text })),
      truncated: used < raw.byteLength,
    };
  });
  // PR prose is intentionally absent from the initial code analysis envelope.
  return {
    baseline: options.incrementalBaseSha,
    head: options.context.headSha,
    files: selected,
    truncated:
      options.context.filesTruncated ||
      selected.length < files.length ||
      selected.some((file) => file.truncated),
  };
}

/**
 * A patch we never received hides changed lines from the review. GitHub also omits the
 * patch when there are no lines to show — binary blobs, pure renames, unchanged entries —
 * and those report no additions or deletions, so they leave nothing uncovered. A diff
 * dropped for size still carries its counts, and so still reads as a gap here.
 */
function missingPatch(file: ChangedFile): boolean {
  if (file.patch || file.status === "removed") return false;
  return file.additions > 0 || file.deletions > 0;
}

function sameHypothesis(a: VerifiedCandidate, b: VerifiedCandidate): boolean {
  return (
    a.hypothesis.path === b.hypothesis.path &&
    a.hypothesis.line === b.hypothesis.line &&
    a.hypothesis.actualBehavior === b.hypothesis.actualBehavior &&
    a.hypothesis.trigger === b.hypothesis.trigger
  );
}

/** Code analysis, attempted disproof, independent investigation, then final classification. */
export async function runReview(options: RunReviewOptions): Promise<ReviewResult> {
  const started = Date.now();
  const emit = (event: ReviewDiagnostic) => emitDiagnostic(options.onDiagnostic, event);
  let invocationCount = 0;
  const { config, context, tools } = options;
  const files = options.files ?? context.files;
  const risk = routeReview(files, config);
  const warnings = new Set<string>();
  const budget = new ReviewBudget(
    {
      maxUsd: config.budget.maxUsdPerReview,
      maxCalls: config.budget.maxAgentCalls,
      deadline: (options.reviewStartedAt ?? Date.now()) + config.budget.maxDurationMs,
    },
    options.pricing,
  );
  let coverageComplete = !context.filesTruncated;
  let findings: Finding[] = [];
  const incomplete = (code: string) => {
    coverageComplete = false;
    if (!warnings.has(code)) emit({ event: "review.coverage_incomplete", code });
    warnings.add(code);
  };
  const result = (outcome = calculateOutcome(findings, coverageComplete)): ReviewResult => ({
    outcome,
    findings,
    cost: budget.cost(),
    risk,
    warnings: [...warnings],
    reviewedHeadSha: context.headSha,
    incrementalBaseSha: options.incrementalBaseSha,
    coverageComplete,
  });
  const finish = () => {
    const completed = result(calculateOutcome(findings, coverageComplete));
    emit({
      event: "review.analysis_completed",
      coverageComplete,
      findingCount: findings.length,
      modelCalls: completed.cost.calls.length,
      toolCalls: evidence.records.length,
      totalEstimatedUsd: completed.cost.totalEstimatedUsd,
      durationMs: Date.now() - started,
    });
    return completed;
  };
  const evidence = new EvidenceStore(tools, budget, config, incomplete, emit);
  if (risk.skip) return finish();
  if (!risk.agents.length) {
    incomplete("NO_ENABLED_REVIEWERS");
    return finish();
  }
  const code = codeContext(options, files);
  // A truncated PR file list cannot safely exclude every changed path from lagging hints.
  const repositoryContext =
    options.retrieveRepositoryContext && !context.filesTruncated
      ? await retrieveDiscoveryContext(
          options.retrieveRepositoryContext,
          {
            installationId: context.job.installationId,
            repositoryId: context.job.repositoryId,
            headSha: context.headSha,
            baseSha: context.baseSha,
            query: files
              .slice(0, 20)
              .map((file) => file.path)
              .join(" ")
              .slice(0, 500),
            // Include all PR changes, even when this review investigates only an increment.
            changedPaths: [
              ...new Set(
                context.files.flatMap((file) => [
                  file.path,
                  ...(file.previousPath ? [file.previousPath] : []),
                ]),
              ),
            ],
            limit: 6,
          },
          options.onDiagnostic,
          Math.min(1500, Math.max(1, budget.remainingMs() / 20)),
        )
      : undefined;
  if (code.truncated || files.some(missingPatch)) incomplete("INCOMPLETE_DIFF_COVERAGE");
  if (files.some((file) => file.deletions > 0 && !reviewableLines(file).length))
    incomplete("INCOMPLETE_DELETION_COVERAGE");
  const prContext = { title: context.title.slice(0, 500), body: context.body.slice(0, 1000) };
  const models = {
    router: config.models.router ?? options.models.router,
    specialist: config.models.defaultSpecialist ?? options.models.specialist,
    judge: config.models.judge ?? options.models.judge,
  };
  const system = (
    prompt: string,
    agent: AgentName | "judge",
    paths: string[],
    domains?: AgentName[],
  ) => {
    let selected: unknown[];
    if (agent === "judge" && domains) {
      const groups: Array<{
        candidatePath: string;
        domain: AgentName;
        rules: ReturnType<typeof trustedRulesFor>["rules"];
      }> = [];
      let count = 0;
      const seen = new Set<string>();
      for (const [index, path] of paths.entries()) {
        const domain = domains[index]!;
        const key = JSON.stringify([path, domain]);
        if (seen.has(key)) continue;
        seen.add(key);
        const policy = trustedRulesFor(config, "judge", [path], [domain]);
        if (policy.truncated) incomplete("TRUSTED_RULES_TRUNCATED");
        if (!policy.rules.length) continue;
        const group = { candidatePath: path, domain, rules: policy.rules };
        if (count + policy.rules.length > 4 || bytes(JSON.stringify([...groups, group])) > 6144) {
          incomplete("TRUSTED_RULES_TRUNCATED");
          continue;
        }
        groups.push(group);
        count += policy.rules.length;
      }
      selected = groups;
    } else {
      const policy = trustedRulesFor(config, agent, paths);
      if (policy.truncated) incomplete("TRUSTED_RULES_TRUNCATED");
      selected = policy.rules;
    }
    return `${prompt}\nTRUSTED INSTRUCTIONS\nRelevant BASE policy, subordinate to the verification protocol. Apply each rule only to its stated paths and, when supplied, its exact candidatePath/domain pair:\n${JSON.stringify(selected)}`;
  };
  const invoke = async <T>(
    ref: ModelRef,
    agent: string,
    prompt: string,
    payload: unknown,
    schema: z.ZodType<T>,
    outputTokens: number,
    preserve?: BudgetReserve,
  ): Promise<T> => {
    const callId = ++invocationCount;
    const phaseResult = z
      .object({ phase: z.enum(["ANALYZE", "VERIFY", "DECIDE"]) })
      .safeParse(payload);
    const phase =
      agent === "router" ? "ROUTE" : phaseResult.success ? phaseResult.data.phase : "UNKNOWN";
    try {
      const provider = options.providers[ref.provider];
      if (!provider) throw new ProviderError("PROVIDER_NOT_CONFIGURED");
      const user = JSON.stringify(payload);
      if (bytes(user) > inputLimit) throw new BudgetError("INVESTIGATION_INPUT_LIMIT");
      const disabled = disabledValidationTools(config.validation);
      const configuredSchema = schema.superRefine((value, ctx) => {
        const visit = (node: unknown, path: (string | number)[]) => {
          if (!node || typeof node !== "object") return;
          if ("tool" in node && typeof node.tool === "string" && disabled.has(node.tool))
            ctx.addIssue({
              code: "custom",
              path: [...path, "tool"],
              message: "Requested validation tool is disabled by policy",
            });
          for (const [key, child] of Object.entries(node))
            visit(child, [...path, Array.isArray(node) ? Number(key) : key]);
        };
        visit(value, []);
      });
      let instruction = outputSchemaInstruction(schema, config.validation);
      if (
        phase !== "ANALYZE" &&
        payload &&
        typeof payload === "object" &&
        "attestedEvidence" in payload &&
        Array.isArray(payload.attestedEvidence)
      ) {
        const records = payload.attestedEvidence as EvidenceRecord[];
        const ids = records
          .filter(
            (record) =>
              record.owner === agent && record.result.status === "ok" && !record.result.truncated,
          )
          .map((record) => record.id);
        if (ids.length) {
          const lines = instruction.split("\n");
          lines[lines.length - 1] = JSON.stringify(
            constrainEvidenceIds(JSON.parse(lines.at(-1)!), ids),
          );
          instruction = lines.join("\n");
        }
      }
      const nativeRecords =
        payload &&
        typeof payload === "object" &&
        "attestedEvidence" in payload &&
        Array.isArray(payload.attestedEvidence)
          ? (payload.attestedEvidence as EvidenceRecord[])
              .filter(
                (record) =>
                  record.owner === agent &&
                  record.result.status === "ok" &&
                  !record.result.truncated,
              )
              .map((record) => ({
                id: record.id,
                output: record.result.output,
                hypothesisId: record.hypothesisId,
              }))
          : [];
      const nativeAnchors: { evidenceId: string; line: number }[] = [];
      if (
        payload &&
        typeof payload === "object" &&
        "attestedEvidence" in payload &&
        Array.isArray(payload.attestedEvidence)
      ) {
        const hypotheses =
          "untrustedHypotheses" in payload && Array.isArray(payload.untrustedHypotheses)
            ? (payload.untrustedHypotheses as Hypothesis[])
            : "unverifiedCandidates" in payload && Array.isArray(payload.unverifiedCandidates)
              ? (payload.unverifiedCandidates as { hypothesis: Hypothesis }[]).map(
                  (candidate) => candidate.hypothesis,
                )
              : [];
        for (const hypothesis of hypotheses)
          for (const record of payload.attestedEvidence as EvidenceRecord[]) {
            if (
              record.owner === agent &&
              record.hypothesisId === hypothesis.id &&
              record.result.status === "ok" &&
              !record.result.truncated &&
              (record.request.tool === "readFile" ||
                (record.request.tool === "gitShow" && record.request.revision === "head")) &&
              record.request.path === hypothesis.path
            )
              nativeAnchors.push({ evidenceId: record.id, line: hypothesis.line });
          }
      }
      const nativeEvidence = supportsStructuredOutput(ref)
        ? constrainNativeEvidence(
            JSON.parse(instruction.split("\n").at(-1)!),
            nativeRecords,
            nativeAnchors,
            payload &&
              typeof payload === "object" &&
              "attestedEvidence" in payload &&
              Array.isArray(payload.attestedEvidence)
              ? (payload.attestedEvidence as EvidenceRecord[])
                  .filter(
                    (record) =>
                      record.owner === agent &&
                      record.purpose === "investigation" &&
                      record.result.status === "ok" &&
                      !record.result.truncated,
                  )
                  .map((record) => record.id)
              : [],
          )
        : undefined;
      const structured = nativeEvidence ? structuredOutput(nativeEvidence.schema) : undefined;
      return await budget.invoke({
        provider,
        ref,
        agent,
        system: `${prompt}\n${structured ? "OUTPUT JSON SCHEMA: Return an instance of the native response_format schema. Local decision, tool-policy and evidence validation still applies." : instruction}${structured ? "\nNATIVE STRUCTURED OUTPUT: The response_format schema is enforced. For its nullable optional fields, return null when unused, overriding the omit/null instructions above. These nulls are converted to omitted optional fields before local validation. Use null for the optional hypothesis startLine and anchor to the primary line. When quote is an enum of line references in response_format, select source_line_N for the source line prefixed N: in that evidence record, or output_row_N for its Nth output row. The executor resolves this reference to the exact quote before validation. Do not return raw source text when references are enumerated. All evidence and decision requirements still apply." : ""}`,
        user,
        schema: structured
          ? z.preprocess(
              (value) => nativeEvidence!.normalize(structured.normalize(value)),
              configuredSchema,
            )
          : configuredSchema,
        ...(structured ? { outputSchema: structured.schema } : {}),
        // Only final classification earns reasoning tokens; every other role would spend
        // them out of the same capped completion budget for no measured gain. This reaches
        // Chat Completions models only: gpt-5 is served by the Responses API, which takes
        // effort inside a reasoning object rather than as a flat field.
        reasoningEffort: agent === "judge" ? "low" : "none",
        outputTokens,
        preserve,
        repairInvalidOutput: true,
        onAttempt: (diagnostic) =>
          emit({ ...diagnostic, callId, agent, phase, provider: ref.provider, model: ref.model }),
        onInvalidOutput: (diagnostic) => {
          const phase = z
            .object({ phase: z.enum(["ANALYZE", "VERIFY", "DECIDE"]) })
            .safeParse(payload);
          options.onInvalidOutput?.(agent, phase.success ? phase.data.phase : "ROUTE", diagnostic);
        },
      });
    } catch (error) {
      emit({
        event: "review.model_invocation_failed",
        callId,
        agent,
        phase,
        code: safeError(error),
      });
      throw error;
    }
  };
  // Run semantic evidence validation inside the same bounded correction loop as
  // structural validation; retain the final attestation before publication too.
  const checkAttestation = (
    ctx: z.RefinementCtx,
    path: (string | number)[],
    checks: EvidenceChecks,
    hypothesis: Hypothesis,
    records: EvidenceRecord[],
    owner: AgentName | "judge",
  ) => {
    try {
      attestChecks(checks, hypothesis, records, owner, files);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      ctx.addIssue({
        code: "custom",
        path: [...path, ...(error instanceof EvidenceAttestationError ? error.issuePath : [])],
        message: error instanceof EvidenceAttestationError ? error.rule : error.code,
      });
    }
  };
  let judgeReserve: BudgetReserve;
  try {
    judgeReserve = {
      calls: 2,
      ms: Math.min(60000, Math.floor(config.budget.maxDurationMs / 4)),
      usd:
        budget.maximumCost(models.judge, 65000, 1500) +
        budget.maximumCost(models.judge, 65000, judgeTokens),
    };
  } catch (error) {
    incomplete(safeError(error));
    return finish();
  }
  // Every active analysis reserves its mandatory verification before other work spends.
  const plannedVerification = new Map<AgentName, number>();
  const preserve = (): BudgetReserve => ({
    ...judgeReserve,
    calls: judgeReserve.calls + plannedVerification.size,
    usd: judgeReserve.usd + [...plannedVerification.values()].reduce((sum, usd) => sum + usd, 0),
  });
  if (risk.score >= 45 && config.models.router && config.budget.maxAgentCalls >= 6) {
    try {
      const routed = await invoke(
        models.router,
        "router",
        routerPrompt,
        {
          phase: "ANALYZE",
          untrustedCode: {
            files: code.files.map((file) => ({ path: file.path, patch: file.patch.slice(0, 300) })),
          },
          deterministicAgents: risk.agents,
          ...(repositoryContext ? { untrustedRepositoryContext: repositoryContext } : {}),
        },
        z.object({ agents: z.array(agentNameSchema).max(3) }).strict(),
        300,
        { ...judgeReserve, calls: judgeReserve.calls + 2 },
      );
      risk.agents = [
        ...new Set([...risk.agents, ...routed.agents.filter((agent) => config.agents[agent])]),
      ];
    } catch (error) {
      warnings.add(`ROUTER_${safeError(error)}`);
    }
  }

  let successfulSpecialists = 0;
  const candidates: VerifiedCandidate[] = [];
  const queue = [...risk.agents];
  async function specialist(agent: AgentName): Promise<void> {
    const model = agent === "lightweight" ? models.router : models.specialist;
    plannedVerification.set(agent, budget.maximumCost(model, 65000, verifyTokens));
    try {
      const analysisPrompt = system(
        specialistPrompt(agent, "ANALYZE"),
        agent,
        files.map((file) => file.path),
      );
      const analysisPayload = {
        phase: "ANALYZE",
        untrustedCode: code,
        validationPolicy: config.validation,
        discoveryRoundsRemaining: 2,
        ...(repositoryContext ? { untrustedRepositoryContext: repositoryContext } : {}),
        ...(agent === "testing"
          ? {
              // These are naming-convention hints, never evidence that a file exists.
              testPathHints: files.slice(0, 4).flatMap((file) => {
                const match = /^(.*)\.(tsx?|jsx?|[cm][jt]s)$/.exec(file.path);
                return match && !/\.(test|spec)$/.test(match[1]!)
                  ? [`${match[1]}.test.${match[2]}`, `${match[1]}.spec.${match[2]}`]
                  : [];
              }),
            }
          : {}),
      };
      // Invalid model anchors are correctable output errors, not evidence to silently drop.
      const anchoredAnalysisSchema = analysisResponseSchema
        .safeExtend({
          hypotheses: z
            .array(
              hypothesisSchema.safeExtend({
                path: z.enum(
                  code.files.filter((file) => file.status !== "removed").map((file) => file.path),
                ),
              }),
            )
            .max(3),
        })
        .superRefine((value, ctx) => {
          value.hypotheses.forEach((hypothesis, index) => {
            const file = files.find(
              (file) => file.path === hypothesis.path && file.status !== "removed",
            );
            if (!file || !reviewableLines(file).some((line) => line.line === hypothesis.line))
              ctx.addIssue({
                code: "custom",
                path: ["hypotheses", index, "line"],
                message: "Hypothesis must use a supplied changed path and reviewable HEAD line",
              });
          });
        });
      let analysis = await invoke(
        model,
        agent,
        agent === "testing"
          ? system(
              testingContextPrompt,
              agent,
              files.map((file) => file.path),
            )
          : analysisPrompt,
        { ...analysisPayload, contextDiscoveryRequired: agent === "testing" },
        agent === "testing" ? analysisContextSchema : anchoredAnalysisSchema,
        2500,
        preserve(),
      );
      const discoveryRecords: EvidenceRecord[] = [];
      for (let round = 0; analysis.requests?.length && round < 2; round++) {
        for (const request of analysis.requests)
          discoveryRecords.push(
            await evidence.capture(
              request,
              agent,
              "discovery",
              `${agent}-discovery`,
              judgeReserve.ms,
            ),
          );
        const needsSourceRead =
          agent === "testing" &&
          round === 0 &&
          !discoveryRecords.some(
            (record) => record.request.tool === "readFile" || record.request.tool === "gitShow",
          );
        analysis = await invoke(
          model,
          agent,
          needsSourceRead
            ? system(
                testingContextPrompt,
                agent,
                files.map((file) => file.path),
              )
            : analysisPrompt,
          {
            ...analysisPayload,
            attestedEvidence: discoveryRecords,
            discoveryRoundsRemaining: 1 - round,
            contextDiscoveryRequired: needsSourceRead,
            followup: true,
          },
          needsSourceRead
            ? analysisContextSchema
            : round === 1
              ? anchoredAnalysisSchema.safeExtend({
                  requests: z.array(strictToolRequestSchema).max(0).optional(),
                })
              : anchoredAnalysisSchema,
          2500,
          preserve(),
        );
      }
      if (analysis.requests?.length) throw new ProviderError("ANALYSIS_CONTEXT_UNRESOLVED");
      const hypotheses = analysis.hypotheses.map((hypothesis, index) => ({
        ...hypothesis,
        id: `${agent}-${index}`,
      }));
      if (!hypotheses.length) {
        successfulSpecialists++;
        return;
      }
      const records: EvidenceRecord[] = [];
      for (const hypothesis of hypotheses) {
        records.push(
          ...(await evidence.surrounding(
            hypothesis,
            files.find((file) => file.path === hypothesis.path)!,
            agent,
            judgeReserve.ms,
          )),
        );
        for (const request of hypothesis.verificationRequests)
          records.push(
            await evidence.capture(request, agent, "investigation", hypothesis.id, judgeReserve.ms),
          );
      }
      plannedVerification.delete(agent);
      const verificationPrompt = system(
        specialistPrompt(agent, "VERIFY"),
        agent,
        hypotheses.map((hypothesis) => hypothesis.path),
      );
      const payload = (followup: boolean) => ({
        phase: "VERIFY",
        untrustedCode: code,
        untrustedHypotheses: hypotheses,
        attestedEvidence: records,
        untrustedPullRequestContext: prContext,
        validationPolicy: config.validation,
        followup,
      });
      const attestedVerificationSchema = verificationResponseSchema.superRefine((value, ctx) => {
        value.assessments.forEach((assessment, index) => {
          const hypothesis = hypotheses.find((item) => item.id === assessment.hypothesisId);
          if (assessment.decision === "confirmed" && assessment.checks && hypothesis)
            checkAttestation(
              ctx,
              ["assessments", index, "checks"],
              assessment.checks,
              hypothesis,
              records,
              agent,
            );
        });
      });
      const hypothesisIds = hypotheses.map((hypothesis) => hypothesis.id);
      const verification = await invoke(
        model,
        agent,
        verificationPrompt,
        payload(false),
        attestedVerificationSchema,
        verifyTokens,
        preserve(),
      );
      let assessed = reconcileIds(
        hypothesisIds,
        verification.assessments,
        (assessment) => assessment.hypothesisId,
      );
      const more = assessed.answered.filter(
        (assessment) => assessment.decision === "needs-more-context",
      );
      if (more.length) {
        for (const assessment of more)
          for (const request of assessment.requests!)
            records.push(
              await evidence.capture(
                request,
                agent,
                "investigation",
                assessment.hypothesisId,
                judgeReserve.ms,
              ),
            );
        const followup = await invoke(
          model,
          agent,
          verificationPrompt,
          payload(true),
          attestedVerificationSchema,
          verifyTokens,
          preserve(),
        );
        // A follow-up answers the re-examined hypotheses; earlier decisions stand for the rest.
        assessed = reconcileIds(
          hypothesisIds,
          [...followup.assessments, ...assessed.answered],
          (assessment) => assessment.hypothesisId,
        );
      }
      if (assessed.missing.length) incomplete(`${agent.toUpperCase()}_UNASSESSED_HYPOTHESES`);
      const verified: VerifiedCandidate[] = [];
      for (const assessment of assessed.answered) {
        if (assessment.decision === "rejected") continue;
        if (assessment.decision === "needs-more-context") {
          incomplete("SPECIALIST_CONTEXT_UNRESOLVED");
          continue;
        }
        const hypothesis = hypotheses.find((item) => item.id === assessment.hypothesisId)!;
        try {
          attestChecks(assessment.checks!, hypothesis, records, agent, files);
          verified.push({
            id: hypothesis.id,
            originatingAgent: agent,
            hypothesis,
            checks: assessment.checks!,
            suggestedFix: assessment.suggestedFix,
            evidence: records.filter((record) => record.hypothesisId === hypothesis.id),
          });
        } catch (error) {
          incomplete(`${agent.toUpperCase()}_${safeError(error)}`);
        }
      }
      candidates.push(...verified);
      successfulSpecialists++;
    } finally {
      if (evidence.hasUnresolvedDiscovery(agent)) incomplete("INVESTIGATION_CONTEXT_INCOMPLETE");
      plannedVerification.delete(agent);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const agent = queue.shift()!;
        try {
          await specialist(agent);
        } catch (error) {
          incomplete(`${agent.toUpperCase()}_${safeError(error)}`);
        }
      }
    }),
  );
  if (!successfulSpecialists) {
    incomplete("NO_SUCCESSFUL_REVIEWERS");
    return finish();
  }
  if (!candidates.length) return finish();
  const unique = candidates.filter(
    (candidate, index) =>
      !candidates.slice(0, index).some((previous) => sameHypothesis(previous, candidate)),
  );
  const compact = (candidate: VerifiedCandidate) => ({
    id: candidate.id,
    originatingAgent: candidate.originatingAgent,
    hypothesis: {
      id: candidate.hypothesis.id,
      title: candidate.hypothesis.title,
      path: candidate.hypothesis.path,
      line: candidate.hypothesis.line,
      category: candidate.hypothesis.category,
      disproofQuestion: candidate.hypothesis.disproofQuestion,
      verificationRequests: candidate.hypothesis.verificationRequests,
    },
  });
  const inputLimitWarning = (error: unknown) => {
    const code = safeError(error);
    if (code === "MODEL_INPUT_LIMIT") return "JUDGE_MODEL_INPUT_LIMIT";
    if (code === "INVESTIGATION_INPUT_LIMIT") return "JUDGE_INPUT_LIMIT";
    return undefined;
  };
  const judgeBatches: VerifiedCandidate[][] = [];
  for (let index = 0; index < unique.length; index += maxCandidates)
    judgeBatches.push(unique.slice(index, index + maxCandidates));
  const accepted: Finding[] = [];
  let judgeRetrievalRemaining = 4;
  const decideCost = budget.maximumCost(models.judge, 65000, judgeTokens);
  const queuedReserve = (currentDecision: boolean): BudgetReserve => ({
    calls: judgeBatches.length * 2 + (currentDecision ? 1 : 0),
    usd: judgeBatches.length * judgeReserve.usd + (currentDecision ? decideCost : 0),
  });
  const splitForRetry = (batch: VerifiedCandidate[]) => {
    const middle = Math.ceil(batch.length / 2);
    judgeBatches.unshift(batch.slice(middle));
    judgeBatches.unshift(batch.slice(0, middle));
  };
  try {
    while (judgeBatches.length) {
      const judged = judgeBatches.shift()!;
      if (
        bytes(
          JSON.stringify({
            untrustedCode: code,
            unverifiedCandidates: judged.map(compact),
          }),
        ) > 24000
      ) {
        if (judged.length > 1) {
          splitForRetry(judged);
          continue;
        }
        incomplete("JUDGE_INPUT_LIMIT");
        continue;
      }
      const candidateIds = judged.map((candidate) => candidate.id);
      const judgeRecords: EvidenceRecord[] = [];
      const judgeEnvelope = (phase: "VERIFY" | "DECIDE", followup = false) => ({
        phase,
        untrustedCode: code,
        unverifiedCandidates: judged.map(compact),
        attestedEvidence: judgeRecords,
        validationPolicy: config.validation,
        followup,
        ...(phase === "DECIDE" ? { untrustedPullRequestContext: prContext } : {}),
      });
      const invokeJudge = <T>(
        phase: "VERIFY" | "DECIDE",
        schema: z.ZodType<T>,
        outputTokens: number,
        preserve: BudgetReserve,
        followup = false,
      ) => {
        const paths = judged.map((candidate) => candidate.hypothesis.path);
        const domains = judged.map((candidate) => candidate.originatingAgent);
        return invoke(
          models.judge,
          "judge",
          system(judgePhasePrompt(phase), "judge", paths, domains),
          judgeEnvelope(phase, followup),
          schema,
          outputTokens,
          preserve,
        );
      };
      try {
        for (const candidate of judged)
          judgeRecords.push(
            ...(await evidence.surrounding(
              candidate.hypothesis,
              files.find((file) => file.path === candidate.hypothesis.path)!,
              "judge",
            )),
          );
        const planning = await invokeJudge("VERIFY", judgeInvestigationSchema, 1500, {
          ...queuedReserve(true),
          ms: Math.min(30000, Math.floor(budget.remainingMs() / 3)),
        });
        // A skipped disproof request is not a coverage gap: DECIDE still has to attest the
        // candidate against judge-owned records before it can be accepted.
        const planned = reconcileIds(candidateIds, planning.requests, (item) => item.candidateId);
        for (const item of planned.answered)
          judgeRecords.push(
            await evidence.capture(item.request, "judge", "investigation", item.candidateId),
          );
        const attestedJudgeSchema = judgeResponseSchemaFor(candidateIds).superRefine(
          (value, ctx) => {
            value.decisions.forEach((item) => {
              const candidate = judged.find((candidate) => candidate.id === item.candidateId);
              if (
                (item.verdict === "accept" || item.verdict === "merge") &&
                item.checks &&
                candidate
              )
                checkAttestation(
                  ctx,
                  // The wire key is the candidate id, so corrections name the candidate.
                  ["decisions", item.candidateId, "checks"],
                  item.checks,
                  candidate.hypothesis,
                  judgeRecords,
                  "judge",
                );
            });
          },
        );
        const decision = await invokeJudge(
          "DECIDE",
          attestedJudgeSchema,
          judgeTokens,
          queuedReserve(false),
        );
        let decided = reconcileIds(candidateIds, decision.decisions, (item) => item.candidateId);
        const more = decided.answered.filter((item) => item.verdict === "needs-more-context");
        if (more.length) {
          const requests = more.flatMap((item) =>
            item.requests!.map((request) => ({ candidateId: item.candidateId, request })),
          );
          if (requests.length > judgeRetrievalRemaining) incomplete("JUDGE_RETRIEVAL_LIMIT");
          else {
            judgeRetrievalRemaining -= requests.length;
            for (const item of requests)
              judgeRecords.push(
                await evidence.capture(item.request, "judge", "investigation", item.candidateId),
              );
            const followup = await invokeJudge(
              "DECIDE",
              attestedJudgeSchema,
              judgeTokens,
              queuedReserve(false),
              true,
            );
            // A follow-up answers the re-examined candidates; earlier verdicts stand for the rest.
            decided = reconcileIds(
              candidateIds,
              [...followup.decisions, ...decided.answered],
              (item) => item.candidateId,
            );
          }
        }
        // An unanswered candidate is neither accepted nor rejected, so coverage is incomplete.
        if (decided.missing.length) incomplete("JUDGE_UNDECIDED_CANDIDATES");
        const suppressed = new Set<string>();
        for (const item of decided.answered) {
          if (!judged.some((candidate) => candidate.id === item.candidateId)) continue;
          if (item.verdict === "merge") {
            const candidate = judged.find((candidate) => candidate.id === item.candidateId)!;
            if (
              !item.mergedWith?.length ||
              item.mergedWith.some(
                (id) =>
                  id === item.candidateId ||
                  !judged.some(
                    (other) =>
                      other.id === id &&
                      other.hypothesis.path === candidate.hypothesis.path &&
                      other.hypothesis.line === candidate.hypothesis.line,
                  ) ||
                  decided.answered.find((other) => other.candidateId === id)?.verdict !== "reject",
              )
            )
              throw new ProviderError("JUDGE_INVALID_MERGE");
            item.mergedWith.forEach((id) => suppressed.add(id));
          } else if (item.mergedWith?.length) throw new ProviderError("JUDGE_INVALID_MERGE");
        }
        for (const item of decided.answered) {
          if (item.verdict === "needs-more-context") {
            incomplete("JUDGE_CONTEXT_UNRESOLVED");
            continue;
          }
          if (item.verdict === "reject" || suppressed.has(item.candidateId)) continue;
          const candidate = judged.find((candidate) => candidate.id === item.candidateId);
          if (!candidate) continue;
          try {
            attestChecks(item.checks!, candidate.hypothesis, judgeRecords, "judge", files);
            if (item.confidence! < config.review.minimumConfidence) continue;
            const fix = item.suggestedFix ?? candidate.suggestedFix;
            if (
              (item.finalPriority === "must_fix" || item.finalPriority === "should_fix") &&
              (!fix || item.suggestedFixSafe !== true)
            )
              throw new ProviderError("JUDGE_UNVERIFIED_FIX");
            const description = `${item.checks!.actualBehavior.statement}\nTrigger: ${item.checks!.trigger.statement}\nWhy this is wrong: ${item.checks!.expectedBehavior.statement}\nImpact: ${item.checks!.impact.statement}\nPR causality: ${item.checks!.causality.statement}`;
            const quotes = [
              ...new Set(
                Object.values(item.checks!).flatMap((claim) =>
                  claim.citations.map((citation) => citation.quote),
                ),
              ),
            ];
            const finding = findingSchema.parse({
              id: candidate.id,
              title: candidate.hypothesis.title,
              description,
              path: candidate.hypothesis.path,
              line: candidate.hypothesis.line,
              startLine: candidate.hypothesis.startLine,
              severity: item.finalSeverity,
              priority: item.finalPriority,
              category: candidate.hypothesis.category,
              confidence: item.confidence,
              evidence: quotes.slice(0, 8),
              originatingAgent: candidate.originatingAgent,
              relatedSymbols: candidate.hypothesis.relatedSymbols,
              ...(item.suggestedFixSafe === true && fix ? { suggestedFix: fix } : {}),
            });
            if (
              finding.priority !== "must_fix" &&
              severityOrder[finding.severity] > severityOrder[config.review.minimumSeverity]
            )
              continue;
            const old =
              options.previousFindings?.filter((previous) => sameFinding(previous, finding)) ?? [];
            const baseline = judgeRecords.filter(
              (record) =>
                record.owner === "judge" &&
                record.hypothesisId === candidate.id &&
                record.purpose === "baseline" &&
                record.result.status === "ok" &&
                !record.result.truncated &&
                record.result.fileExists !== false,
            );
            const anchors = item.checks!.anchor.citations.map((citation) => citation.quote);
            const deletionAnchor =
              reviewableLines(files.find((file) => file.path === finding.path)!).find(
                (line) => line.line === finding.line,
              )?.kind === "deletion-context";
            if (
              !deletionAnchor &&
              old.some((previous) =>
                anchors.some(
                  (quote) =>
                    previous.evidence.includes(quote) &&
                    baseline.some((record) => record.result.output.includes(quote)),
                ),
              )
            )
              continue;
            // Candidates were already deduplicated by exact behavior and anchor, and the
            // judge explicitly merges exact duplicates. A fuzzy finding comparison here
            // would collapse nearby but independently actionable regressions.
            accepted.push(finding);
          } catch (error) {
            const code = safeError(error);
            incomplete(code.startsWith("JUDGE_") ? code : `JUDGE_${code}`);
          }
        }
      } catch (error) {
        const warning = inputLimitWarning(error);
        if (warning && judged.length > 1) {
          splitForRetry(judged);
          continue;
        }
        const code = warning ?? safeError(error);
        incomplete(code.startsWith("JUDGE_") ? code : `JUDGE_${code}`);
      }
    }
  } finally {
    if (evidence.hasUnresolvedDiscovery("judge")) incomplete("INVESTIGATION_CONTEXT_INCOMPLETE");
  }
  findings = accepted.sort(compareFindings);
  return finish();
}
