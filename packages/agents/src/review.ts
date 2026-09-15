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
  type BudgetReserve,
  type PricingTable,
  type ProviderRegistry,
  type OutputDiagnostic,
} from "@sherpa/models";
import { reviewableLines, sameFinding, severityOrder } from "./findings";
import { routeReview } from "./routing";
import { trustedRulesFor } from "./policy";
import { judgePhasePrompt, routerPrompt, specialistPrompt } from "./prompts";
import { outputSchemaInstruction } from "./output-schema";
import { EvidenceStore } from "./evidence";
import { emitDiagnostic, type ReviewDiagnostic } from "./diagnostics";
import {
  analysisResponseSchema,
  verificationResponseSchema,
  judgeInvestigationSchema,
  judgeResponseSchema,
  attestChecks,
  validateIds,
  type EvidenceRecord,
  type VerifiedCandidate,
} from "./investigation";

export {
  analysisResponseSchema,
  verificationResponseSchema,
  judgeInvestigationSchema,
  judgeResponseSchema,
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
  if (code.truncated || files.some((file) => !file.patch && file.status !== "removed"))
    incomplete("INCOMPLETE_DIFF_COVERAGE");
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
      return await budget.invoke({
        provider,
        ref,
        agent,
        system: `${prompt}\n${outputSchemaInstruction(schema)}`,
        user,
        schema,
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
      const analysis = await invoke(
        model,
        agent,
        system(
          specialistPrompt(agent, "ANALYZE"),
          agent,
          files.map((file) => file.path),
        ),
        { phase: "ANALYZE", untrustedCode: code, validationPolicy: config.validation },
        analysisResponseSchema,
        2500,
        preserve(),
      );
      const hypotheses = analysis.hypotheses
        .map((hypothesis, index) => ({ ...hypothesis, id: `${agent}-${index}` }))
        .filter((hypothesis) => {
          const file = files.find(
            (item) => item.path === hypothesis.path && item.status !== "removed",
          );
          return file && reviewableLines(file).some((line) => line.line === hypothesis.line);
        });
      if (hypotheses.length !== analysis.hypotheses.length)
        incomplete("HYPOTHESIS_ANCHOR_UNRESOLVED");
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
      let verification = await invoke(
        model,
        agent,
        verificationPrompt,
        payload(false),
        verificationResponseSchema,
        verifyTokens,
        preserve(),
      );
      validateIds(
        hypotheses.map((hypothesis) => hypothesis.id),
        verification.assessments.map((assessment) => assessment.hypothesisId),
      );
      const more = verification.assessments.filter(
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
        verification = await invoke(
          model,
          agent,
          verificationPrompt,
          payload(true),
          verificationResponseSchema,
          verifyTokens,
          preserve(),
        );
        validateIds(
          hypotheses.map((hypothesis) => hypothesis.id),
          verification.assessments.map((assessment) => assessment.hypothesisId),
        );
      }
      const verified: VerifiedCandidate[] = [];
      for (const assessment of verification.assessments) {
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
  let judged = unique.slice(0, maxCandidates);
  if (judged.length < unique.length) incomplete("CANDIDATE_LIMIT");
  const compact = (candidate: VerifiedCandidate) => ({
    id: candidate.id,
    originatingAgent: candidate.originatingAgent,
    hypothesis: candidate.hypothesis,
    checks: candidate.checks,
    suggestedFix: candidate.suggestedFix,
  });
  // Drop complete candidates rather than truncating any attested evidence mid-record.
  while (
    judged.length &&
    bytes(
      JSON.stringify({
        untrustedCode: code,
        unverifiedCandidates: judged.map(compact),
        attestedEvidence: judged.flatMap((candidate) => candidate.evidence),
      }),
    ) > 24000
  ) {
    judged = judged.slice(0, -1);
    incomplete("JUDGE_INPUT_LIMIT");
  }
  if (!judged.length) return finish();
  const judgePaths = judged.map((candidate) => candidate.hypothesis.path);
  const judgeDomains = judged.map((candidate) => candidate.originatingAgent);
  const judgeRecords = judged.flatMap((candidate) => candidate.evidence);
  const judgeEnvelope = (phase: "VERIFY" | "DECIDE", followup = false) => ({
    phase,
    untrustedCode: code,
    unverifiedCandidates: judged.map(compact),
    attestedEvidence: judgeRecords,
    validationPolicy: config.validation,
    followup,
    ...(phase === "DECIDE" ? { untrustedPullRequestContext: prContext } : {}),
  });
  try {
    for (const candidate of judged)
      judgeRecords.push(
        ...(await evidence.surrounding(
          candidate.hypothesis,
          files.find((file) => file.path === candidate.hypothesis.path)!,
          "judge",
        )),
      );
    const planning = await invoke(
      models.judge,
      "judge",
      system(judgePhasePrompt("VERIFY"), "judge", judgePaths, judgeDomains),
      judgeEnvelope("VERIFY"),
      judgeInvestigationSchema,
      1500,
      {
        calls: 1,
        usd: budget.maximumCost(models.judge, 65000, judgeTokens),
        ms: Math.min(30000, Math.floor(budget.remainingMs() / 3)),
      },
    );
    validateIds(
      judged.map((candidate) => candidate.id),
      planning.requests.map((item) => item.candidateId),
    );
    for (const item of planning.requests)
      judgeRecords.push(
        await evidence.capture(item.request, "judge", "investigation", item.candidateId),
      );
    const decisionPrompt = system(judgePhasePrompt("DECIDE"), "judge", judgePaths, judgeDomains);
    let decision = await invoke(
      models.judge,
      "judge",
      decisionPrompt,
      judgeEnvelope("DECIDE"),
      judgeResponseSchema,
      judgeTokens,
    );
    validateIds(
      judged.map((candidate) => candidate.id),
      decision.decisions.map((item) => item.candidateId),
    );
    const more = decision.decisions.filter((item) => item.verdict === "needs-more-context");
    if (more.length) {
      if (more.flatMap((item) => item.requests!).length > 4)
        throw new ProviderError("JUDGE_RETRIEVAL_LIMIT");
      for (const item of more)
        for (const request of item.requests!)
          judgeRecords.push(
            await evidence.capture(request, "judge", "investigation", item.candidateId),
          );
      decision = await invoke(
        models.judge,
        "judge",
        decisionPrompt,
        judgeEnvelope("DECIDE", true),
        judgeResponseSchema,
        judgeTokens,
      );
      validateIds(
        judged.map((candidate) => candidate.id),
        decision.decisions.map((item) => item.candidateId),
      );
    }
    const suppressed = new Set<string>();
    for (const item of decision.decisions) {
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
                  Math.abs(other.hypothesis.line - candidate.hypothesis.line) <= 10,
              ) ||
              decision.decisions.find((other) => other.candidateId === id)?.verdict !== "reject",
          )
        )
          throw new ProviderError("JUDGE_INVALID_MERGE");
        item.mergedWith.forEach((id) => suppressed.add(id));
      } else if (item.mergedWith?.length) throw new ProviderError("JUDGE_INVALID_MERGE");
    }
    const accepted: Finding[] = [];
    for (const item of decision.decisions) {
      if (item.verdict === "needs-more-context") {
        incomplete("JUDGE_CONTEXT_UNRESOLVED");
        continue;
      }
      if (item.verdict === "reject" || suppressed.has(item.candidateId)) continue;
      const candidate = judged.find((candidate) => candidate.id === item.candidateId)!;
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
        if (!accepted.some((previous) => sameFinding(previous, finding))) accepted.push(finding);
      } catch (error) {
        const code = safeError(error);
        incomplete(code.startsWith("JUDGE_") ? code : `JUDGE_${code}`);
      }
    }
    findings = accepted.sort(compareFindings);
  } catch (error) {
    findings = [];
    const code = safeError(error);
    incomplete(code.startsWith("JUDGE_") ? code : `JUDGE_${code}`);
  }
  return finish();
}
