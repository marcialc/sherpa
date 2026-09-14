import { z } from "zod";
import {
  agentNameSchema,
  calculateOutcome,
  compareFindings,
  findingPrioritySchema,
  findingSchema,
  severitySchema,
  toolRequestSchema,
  type AgentName,
  type ChangedFile,
  type Finding,
  type ModelRef,
  type PullRequestContext,
  type RepoConfig,
  type RepositoryTools,
  type ReviewResult,
  type ToolRequest,
  type ToolResult,
} from "@sherpa/schemas";
import {
  BudgetError,
  ProviderError,
  ReviewBudget,
  type BudgetReserve,
  type PricingTable,
  type ProviderRegistry,
} from "@sherpa/models";
import { addedLines, filterFindings, sameFinding, severityOrder } from "./findings";
import { routeReview } from "./routing";
import { judgePrompt, routerPrompt, specialistPrompt } from "./prompts";

const strictToolRequest = z.discriminatedUnion("tool", [
  toolRequestSchema.options[0].strict(),
  toolRequestSchema.options[1].strict(),
  toolRequestSchema.options[2].strict(),
  toolRequestSchema.options[3].strict(),
  toolRequestSchema.options[4].strict(),
  toolRequestSchema.options[5].strict(),
]);
export const specialistResponseSchema = z.union([
  z.object({ findings: z.array(findingSchema.strict()).max(10) }).strict(),
  z.object({ requests: z.array(strictToolRequest).min(1).max(3) }).strict(),
]);
export const judgeResponseSchema = z
  .object({
    decisions: z
      .array(
        z
          .object({
            candidateId: z.string().min(1).max(100),
            verdict: z.enum(["accept", "reject", "merge", "needs-more-context"]),
            reason: z.string().min(1).max(1000),
            introducedByChange: z.boolean().optional(),
            actionable: z.boolean().optional(),
            confidence: z.number().min(0).max(1).optional(),
            finalSeverity: severitySchema.optional(),
            finalPriority: findingPrioritySchema.optional(),
            suggestedFix: z.string().trim().min(1).max(1000).optional(),
            suggestedFixSafe: z.boolean().optional(),
            mergedWith: z.array(z.string().max(100)).max(15).optional(),
            requests: z.array(strictToolRequest).max(2).optional(),
          })
          .strict()
          .superRefine((decision, context) => {
            if (
              (decision.verdict === "accept" || decision.verdict === "merge") &&
              (decision.introducedByChange !== true ||
                decision.actionable !== true ||
                decision.confidence === undefined ||
                decision.finalPriority === undefined)
            )
              context.addIssue({
                code: "custom",
                message:
                  "Accepted findings require introduction, actionability, confidence, and final priority",
              });
          }),
      )
      .max(16),
  })
  .strict();

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
};
const judgeInputLimit = 29000;
const judgeOutputTokens = 3000;
const maxCandidates = 12;
const encoder = new TextEncoder();
function bytes(text: string): number {
  return encoder.encode(text).byteLength;
}
function safeError(error: unknown): string {
  return error instanceof BudgetError || error instanceof ProviderError
    ? error.code
    : "REVIEW_COMPONENT_FAILED";
}

function boundedContext(
  context: PullRequestContext,
  files: ChangedFile[],
  incrementalBaseSha: string,
) {
  let remaining = 14000;
  const selected = files.slice(0, 60).map((file) => {
    const patch = (file.patch ?? "").slice(0, Math.min(remaining, 7000));
    remaining -= patch.length;
    return {
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch,
      truncated: patch.length < (file.patch?.length ?? 0),
    };
  });
  return {
    title: context.title.slice(0, 500),
    body: context.body.slice(0, 1000),
    baseline: incrementalBaseSha,
    head: context.headSha,
    files: selected,
    truncated:
      files.length > selected.length ||
      selected.some((file) => file.truncated) ||
      context.filesTruncated,
  };
}

async function executeBounded(
  tools: RepositoryTools,
  request: ToolRequest,
  budget: ReviewBudget,
  config: RepoConfig,
  timeoutMs = 30000,
): Promise<ToolResult> {
  budget.assertTime();
  if (timeoutMs <= 0) throw new BudgetError("TOOL_DEADLINE");
  const validationKey = {
    runTests: "tests",
    runTypecheck: "typecheck",
    runLint: "lint",
    runSecurityScan: "security",
  } as const;
  if (request.tool in validationKey) {
    const key = validationKey[request.tool as keyof typeof validationKey];
    if (!config.validation.enabled || !config.validation[key])
      return {
        tool: request.tool,
        status: "skipped",
        output: "VALIDATION_DISABLED",
        truncated: false,
        durationMs: 0,
      };
  }
  if (request.tool === "readFile") {
    const startLine = request.startLine ?? 1;
    request = {
      ...request,
      startLine,
      endLine: Math.min(request.endLine ?? startLine + 99, startLine + 99),
    };
    if (request.endLine! < startLine) throw new ProviderError("INVALID_TOOL_RANGE");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new BudgetError("TOOL_DEADLINE")),
        Math.min(budget.remainingMs(), timeoutMs),
      );
    });
    const result = await Promise.race([tools.execute(request), timeout]);
    const valid = z
      .object({
        tool: z.literal(request.tool),
        status: z.enum(["ok", "failed", "skipped"]),
        output: z.string(),
        truncated: z.boolean(),
        durationMs: z.number().nonnegative(),
      })
      .safeParse(result);
    if (!valid.success) throw new ProviderError("INVALID_TOOL_RESULT");
    return {
      ...valid.data,
      output: valid.data.output.slice(0, 4000),
      truncated: valid.data.truncated || valid.data.output.length > 4000,
    };
  } catch (error) {
    if (error instanceof BudgetError) throw error;
    return {
      tool: request.tool,
      status: "failed",
      output: "TOOL_FAILED",
      truncated: false,
      durationMs: 0,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function judgeRequestAllowed(request: ToolRequest, candidates: Finding[]): boolean {
  if (request.tool === "readFile")
    return (
      candidates.some((finding) => finding.path === request.path) &&
      request.startLine !== undefined &&
      request.endLine !== undefined &&
      request.endLine >= request.startLine &&
      request.endLine - request.startLine < 100
    );
  if (request.tool === "gitShow")
    return candidates.some((finding) => finding.path === request.path);
  if (request.tool === "findReferences")
    return (
      request.query.length <= 80 &&
      candidates.some((finding) => finding.relatedSymbols?.includes(request.query))
    );
  return false;
}

/** Runs deterministic routing, bounded specialists and an independently grounded judge. */
export async function runReview(options: RunReviewOptions): Promise<ReviewResult> {
  const { context, config, tools } = options;
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
  const result = (outcome: ReviewResult["outcome"]): ReviewResult => ({
    outcome,
    findings,
    cost: budget.cost(),
    risk,
    warnings: [...warnings],
    reviewedHeadSha: context.headSha,
    incrementalBaseSha: options.incrementalBaseSha,
    coverageComplete,
  });
  if (risk.skip) return result("PASS");
  if (!risk.agents.length) {
    warnings.add("NO_ENABLED_REVIEWERS");
    coverageComplete = false;
    return result("REVIEW_FAILED");
  }
  const data = boundedContext(context, files, options.incrementalBaseSha);
  if (data.truncated || files.some((file) => !file.patch && file.status !== "removed")) {
    coverageComplete = false;
    warnings.add("INCOMPLETE_DIFF_COVERAGE");
  }
  const models = {
    router: config.models.router ?? options.models.router,
    specialist: config.models.defaultSpecialist ?? options.models.specialist,
    judge: config.models.judge ?? options.models.judge,
  };
  const invoke = <T>(
    ref: ModelRef,
    agent: string,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    outputTokens: number,
    preserve?: BudgetReserve,
  ) => {
    const provider = options.providers[ref.provider];
    if (!provider) throw new ProviderError("PROVIDER_NOT_CONFIGURED");
    return budget.invoke({ provider, ref, agent, system, user, schema, outputTokens, preserve });
  };
  let reserve: BudgetReserve;
  try {
    reserve = {
      calls: 1,
      ms: Math.min(45000, Math.floor(config.budget.maxDurationMs / 5)),
      usd: budget.maximumCost(
        models.judge,
        judgeInputLimit + bytes(judgePrompt) + 1024,
        judgeOutputTokens,
      ),
    };
  } catch (error) {
    warnings.add(safeError(error));
    coverageComplete = false;
    return result("REVIEW_FAILED");
  }
  // Classification may only add specialists; untrusted content cannot de-escalate.
  if (risk.score >= 45 && config.models.router && config.budget.maxAgentCalls >= 5) {
    try {
      const routed = await invoke(
        models.router,
        "router",
        routerPrompt,
        JSON.stringify({
          files: data.files.map((file) => ({ path: file.path, patch: file.patch.slice(0, 500) })),
          deterministicAgents: risk.agents,
        }),
        z.object({ agents: z.array(agentNameSchema).max(3) }).strict(),
        300,
        { ...reserve, calls: reserve.calls + 1 },
      );
      risk.agents = [
        ...new Set([...risk.agents, ...routed.agents.filter((agent) => config.agents[agent])]),
      ];
    } catch (error) {
      warnings.add(`ROUTER_${safeError(error)}`);
    }
  }
  let successfulSpecialists = 0;
  const candidates: Finding[] = [];
  const queue = [...risk.agents];
  async function specialist(agent: AgentName): Promise<void> {
    const system = specialistPrompt(agent);
    const model = agent === "lightweight" ? models.router : models.specialist;
    const envelope = { untrustedPullRequest: data, validationPolicy: config.validation };
    let response = await invoke(
      model,
      agent,
      system,
      JSON.stringify(envelope),
      specialistResponseSchema,
      2500,
      reserve,
    );
    if ("requests" in response) {
      const retrieved = [];
      for (const request of response.requests) {
        const output = await executeBounded(
          tools,
          request,
          budget,
          config,
          Math.min(30000, budget.remainingMs() - (reserve.ms ?? 0)),
        );
        if (output.status !== "ok" || output.truncated) {
          coverageComplete = false;
          warnings.add("SPECIALIST_CONTEXT_INCOMPLETE");
        }
        retrieved.push({ request, untrustedResult: output });
      }
      response = await invoke(
        model,
        agent,
        system,
        JSON.stringify({
          ...envelope,
          untrustedToolResults: retrieved,
          retrievalRoundComplete: true,
        }),
        specialistResponseSchema,
        2500,
        reserve,
      );
      if ("requests" in response) throw new ProviderError("SPECIALIST_RETRIEVAL_LIMIT");
    }
    successfulSpecialists++;
    candidates.push(
      ...response.findings.map((finding, index) => ({
        ...finding,
        id: `${agent}-${index}`,
        originatingAgent: agent,
      })),
    );
  }
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const agent = queue.shift()!;
        try {
          await specialist(agent);
        } catch (error) {
          coverageComplete = false;
          warnings.add(`${agent.toUpperCase()}_${safeError(error)}`);
        }
      }
    }),
  );
  if (!successfulSpecialists) return result("REVIEW_FAILED");
  let filtered = filterFindings(candidates, files, config);
  // Historical identity is insufficient: a fixed defect can be reintroduced.
  // Suppress only when its literal source evidence still exists at this increment's
  // immutable baseline. Missing/truncated context conservatively keeps the finding.
  const previousByPath = new Map<string, ToolResult>();
  const repeated = new Set<string>();
  for (const candidate of filtered) {
    const prior = options.previousFindings?.filter((old) => sameFinding(old, candidate)) ?? [];
    if (!prior.length || budget.remainingMs() < (reserve.ms ?? 0) + 5000) continue;
    let previous = previousByPath.get(candidate.path);
    if (!previous) {
      if (previousByPath.size >= 6) continue;
      try {
        previous = await executeBounded(
          tools,
          { tool: "gitShow", path: candidate.path, revision: "previous" },
          budget,
          config,
          5000,
        );
      } catch {
        previous = {
          tool: "gitShow",
          status: "failed",
          output: "PREVIOUS_CONTEXT_UNAVAILABLE",
          truncated: false,
          durationMs: 0,
        };
      }
      previousByPath.set(candidate.path, previous);
    }
    if (previous.status !== "ok" || previous.truncated) continue;
    const source = previous.output.split("\n").map((line) => line.trim());
    const literalEvidence = addedLines(files.find((file) => file.path === candidate.path)!)
      .filter(
        (line) =>
          line.line >= (candidate.startLine ?? candidate.line!) &&
          line.line <= candidate.line! &&
          candidate.evidence.some((evidence) => evidence.includes(line.text.trim())),
      )
      .map((line) => line.text.trim());
    if (
      literalEvidence.some(
        (literal) =>
          source.includes(literal) &&
          prior.some((old) => old.evidence.some((evidence) => evidence.includes(literal))),
      )
    )
      repeated.add(candidate.id);
  }
  filtered = filtered.filter((candidate) => !repeated.has(candidate.id));
  if (!filtered.length) return result(coverageComplete ? "PASS" : "REVIEW_FAILED");
  let judged = filtered.slice(0, maxCandidates);
  if (filtered.length > judged.length) {
    coverageComplete = false;
    warnings.add("CANDIDATE_LIMIT");
  }
  // All decisions fit a hard input ceiling; never truncate a candidate mid-JSON.
  const judgeBase = {
    untrustedPullRequest: data,
    minimumConfidence: config.review.minimumConfidence,
  };
  while (
    judged.length &&
    bytes(JSON.stringify({ ...judgeBase, untrustedCandidates: judged })) > judgeInputLimit - 4500
  ) {
    judged = judged.slice(0, -1);
    coverageComplete = false;
    warnings.add("JUDGE_INPUT_LIMIT");
  }
  if (!judged.length) return result("REVIEW_FAILED");
  try {
    let response = await invoke(
      models.judge,
      "judge",
      judgePrompt,
      JSON.stringify({ ...judgeBase, untrustedCandidates: judged }),
      judgeResponseSchema,
      judgeOutputTokens,
    );
    const validateDecisions = (decisions: typeof response.decisions) => {
      if (
        decisions.length !== judged.length ||
        new Set(decisions.map((decision) => decision.candidateId)).size !== judged.length ||
        decisions.some((decision) => !judged.some((finding) => finding.id === decision.candidateId))
      )
        throw new ProviderError("JUDGE_INVALID_CANDIDATES");
      for (const decision of decisions) {
        const candidate = judged.find((finding) => finding.id === decision.candidateId)!;
        if (
          (decision.verdict === "accept" || decision.verdict === "merge") &&
          (decision.finalPriority === "must_fix" || decision.finalPriority === "should_fix") &&
          (decision.suggestedFixSafe !== true ||
            !(decision.suggestedFix ?? candidate.suggestedFix)?.trim())
        )
          throw new ProviderError("JUDGE_MISSING_ACTION");
        if (
          decision.verdict === "merge" &&
          (!decision.mergedWith?.length ||
            decision.mergedWith.some(
              (id) =>
                id === candidate.id ||
                !judged.some((other) => other.id === id) ||
                decisions.find((other) => other.candidateId === id)?.verdict !== "reject",
            ))
        )
          throw new ProviderError("JUDGE_INVALID_MERGE");
        if (decision.verdict !== "needs-more-context" && decision.requests?.length)
          throw new ProviderError("JUDGE_UNEXPECTED_TOOLS");
      }
    };
    validateDecisions(response.decisions);
    const requests = response.decisions
      .filter((decision) => decision.verdict === "needs-more-context")
      .flatMap((decision) => decision.requests ?? []);
    if (
      response.decisions.some(
        (decision) => decision.verdict === "needs-more-context" && !decision.requests?.length,
      )
    )
      throw new ProviderError("JUDGE_MISSING_CONTEXT_REQUEST");
    if (requests.length) {
      if (requests.length > 2 || requests.some((request) => !judgeRequestAllowed(request, judged)))
        throw new ProviderError("JUDGE_UNSAFE_CONTEXT_REQUEST");
      const retrieved = [];
      for (const request of requests) {
        const output = await executeBounded(tools, request, budget, config);
        const truncated = output.truncated || output.output.length > 1500;
        if (output.status !== "ok" || truncated) {
          coverageComplete = false;
          warnings.add("JUDGE_CONTEXT_INCOMPLETE");
        }
        retrieved.push({
          request,
          untrustedResult: { ...output, output: output.output.slice(0, 1500), truncated },
        });
      }
      const user = JSON.stringify({
        ...judgeBase,
        untrustedCandidates: judged,
        untrustedToolResults: retrieved,
        retrievalRoundComplete: true,
      });
      if (bytes(user) > judgeInputLimit) throw new ProviderError("JUDGE_INPUT_LIMIT");
      response = await invoke(
        models.judge,
        "judge",
        judgePrompt,
        user,
        judgeResponseSchema,
        judgeOutputTokens,
      );
      validateDecisions(response.decisions);
    }
    const merged = new Set(
      response.decisions
        .filter((decision) => decision.verdict === "merge")
        .flatMap((decision) => decision.mergedWith ?? []),
    );
    findings = judged
      .filter((finding) => {
        const decision = response.decisions.find((item) => item.candidateId === finding.id)!;
        return (
          !merged.has(finding.id) &&
          (decision.verdict === "accept" || decision.verdict === "merge") &&
          decision.introducedByChange === true &&
          decision.actionable === true &&
          (decision.confidence ?? 0) >= config.review.minimumConfidence
        );
      })
      .map((finding) => {
        const decision = response.decisions.find((item) => item.candidateId === finding.id)!;
        const { suggestedFix: proposedFix, ...rest } = finding;
        const suggestedFix = decision.suggestedFix ?? proposedFix;
        return {
          ...rest,
          severity: decision.finalSeverity ?? finding.severity,
          priority: decision.finalPriority!,
          confidence: decision.confidence!,
          ...(decision.suggestedFixSafe === true && suggestedFix ? { suggestedFix } : {}),
        };
      })
      .filter(
        (finding) =>
          finding.priority === "must_fix" ||
          severityOrder[finding.severity] <= severityOrder[config.review.minimumSeverity],
      )
      .sort(compareFindings);
    if (response.decisions.some((decision) => decision.verdict === "needs-more-context")) {
      coverageComplete = false;
      warnings.add("JUDGE_CONTEXT_UNRESOLVED");
    }
  } catch (error) {
    warnings.add(`JUDGE_${safeError(error)}`);
    coverageComplete = false;
    findings = [];
    return result("REVIEW_FAILED");
  }
  return result(calculateOutcome(findings, coverageComplete));
}
