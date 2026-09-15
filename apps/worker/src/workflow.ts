import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import { GitHubApp, GitHubChecks, GitHubClient, findingFingerprint } from "@sherpa/github";
import { createProviderRegistry } from "@sherpa/models";
import { loadTrustedPolicy, routeReview, runReview } from "@sherpa/agents";
import { RepositorySession, repositoryFailureCode } from "@sherpa/sandbox";
import {
  calculateOutcome,
  effectiveConfig,
  parseRepoConfig,
  type RepositoryTools,
  type ReviewJob,
} from "@sherpa/schemas";
import {
  runPipeline,
  type Checkpoints,
  type PipelineOutcome,
  type PipelineServices,
} from "@sherpa/workflow";
import { log } from "@sherpa/shared";
import { unconfiguredBillingResult } from "./billing";
import { getSettings, type RuntimeEnv } from "./settings";
import { withReviewCheck } from "./progress";
import { reviewSandboxId } from "./sandbox-id";

export type WorkflowParams = ReviewJob & { recoveryOnly?: boolean };
export class ReviewWorkflow extends WorkflowEntrypoint<RuntimeEnv, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const job = event.payload;
    const maxDurationMs = Math.min(
      Math.max(Number(this.env.MAX_REVIEW_DURATION_MS) || 600000, 1000),
      1800000,
    );
    const checkpoints: Checkpoints = {
      async run<T>(
        name: string,
        kind: "read" | "analysis" | "write" | "status",
        work: () => Promise<T>,
      ): Promise<T> {
        const serialized = await step.do(
          name,
          {
            retries: {
              limit: kind === "read" || kind === "status" ? 2 : 0,
              delay: "2 seconds",
              backoff: "exponential",
            },
            timeout: kind === "analysis" ? maxDurationMs + 120000 : "3 minutes",
            sensitive: "output",
          },
          async () => JSON.stringify({ value: await work() }),
        );
        return (JSON.parse(serialized) as { value: T }).value;
      },
      sleep: (name, milliseconds) => step.sleep(name, milliseconds),
    };
    return withReviewCheck(
      job,
      checkpoints,
      async () => {
        const app = new GitHubApp({
          appId: this.env.GITHUB_APP_ID,
          privateKey: this.env.GITHUB_PRIVATE_KEY,
        });
        return new GitHubChecks(
          await app.installationToken(job, "checks"),
          await app.getIdentity(),
        );
      },
      (onStarted) => this.runReview(job, step, checkpoints, onStarted),
      job.recoveryOnly,
    );
  }

  private async runReview(
    job: WorkflowParams,
    step: WorkflowStep,
    checkpoints: Checkpoints,
    onStarted: () => Promise<void>,
  ): Promise<PipelineOutcome> {
    const ledger = this.env.REVIEW_LEDGER.getByName(
      `${job.installationId}:${job.repositoryId}:${job.number}`,
    );
    if (job.recoveryOnly) {
      const maxWaitMs =
        Math.min(Math.max(Number(this.env.MAX_REVIEW_DURATION_MS) || 600000, 1000), 1800000) +
        360000;
      for (let attempt = 0; attempt <= Math.ceil(maxWaitMs / 30000); attempt++) {
        const recovered = await step.do(
          `recover-publication-${attempt}`,
          {
            retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
            timeout: "2 minutes",
            sensitive: "output",
          },
          async () => {
            try {
              const value = await ledger.reconcilePublication(job);
              return {
                status: value.status,
                githubReviewId: value.githubReviewId,
                outcome: value.outcome,
              };
            } catch {
              throw new Error("REVIEW_RECOVERY_FAILED");
            }
          },
        );
        if (recovered.status === "recovered")
          return {
            status: "published",
            reviewId: job.reviewId,
            githubReviewId: recovered.githubReviewId,
            outcome: recovered.outcome,
          };
        if (recovered.status === "none") return { status: "failed", reviewId: job.reviewId };
        await step.sleep(`wait-for-recovery-${attempt}`, "30 seconds");
      }
      throw new Error("REVIEW_RECOVERY_UNRESOLVED");
    }
    const settings = getSettings(this.env);
    const installationSettings = this.env.INSTALLATION_SETTINGS;
    const setupOrigin = this.env.PUBLIC_BASE_URL;
    const app = new GitHubApp({
      appId: this.env.GITHUB_APP_ID,
      privateKey: this.env.GITHUB_PRIVATE_KEY,
    });
    const client = async (write = false) =>
      new GitHubClient(
        await app.installationToken(job, write ? "write" : "read"),
        undefined,
        await app.getIdentity(),
      );
    const services: PipelineServices = {
      ledger,
      onStarted,
      maxDurationMs: settings.limits.maxDurationMs,
      async load(job) {
        const github = await client();
        const context = await github.getPullRequest(job);
        if (
          context.baseSha !== job.baseSha ||
          context.headSha !== job.headSha ||
          context.state !== "open"
        )
          throw new Error("STALE_PULL_REQUEST");
        const config = effectiveConfig(
          await loadTrustedPolicy(
            parseRepoConfig(await github.getConfig(job, job.baseSha)),
            (path) => github.getTrustedFile(job, job.baseSha, path),
          ),
          settings.limits,
        );
        if (!(await github.isCurrent(job))) throw new Error("STALE_PULL_REQUEST");
        return { context, config };
      },
      analyze: async (context, config, baseline) => {
        const risk = routeReview(context.files, config);
        if (risk.skip && !context.filesTruncated)
          return {
            outcome: "PASS",
            findings: [],
            cost: { totalEstimatedUsd: 0, calls: [], unpricedCalls: 0 },
            risk,
            warnings: [],
            reviewedHeadSha: job.headSha,
            incrementalBaseSha: job.baseSha,
            coverageComplete: true,
          };
        const gateway = await installationSettings
          .getByName(String(job.installationId))
          .getGateway();
        if (!gateway) return unconfiguredBillingResult(job, risk);
        const startedAt = Date.now();
        // A fresh container per analysis attempt: no reused working tree or tenant state.
        const sandbox = getSandbox(this.env.REVIEW_SANDBOX, reviewSandboxId(job.reviewId));
        const session = new RepositorySession(sandbox, {
          validation: config.validation,
          allowValidation: settings.limits.allowValidation,
        });
        let files = context.files;
        let incrementalBaseSha = job.baseSha;
        let repositoryAvailable = false;
        const warnings: string[] = [];
        const unavailable: RepositoryTools = {
          execute: (request) =>
            Promise.resolve({
              tool: request.tool,
              status: "skipped",
              output: "Repository tools unavailable; reason only from supplied diff evidence.",
              durationMs: 0,
              truncated: false,
            }),
        };
        try {
          let repositoryStage = "sandbox_prepare";
          try {
            const prepared = await session.prepare(
              job,
              job.action === "synchronize" && baseline.baseSha === job.baseSha
                ? baseline.headSha
                : undefined,
            );
            incrementalBaseSha = prepared.incrementalBaseSha;
            warnings.push(...prepared.warnings);
            repositoryStage = "sandbox_diff";
            files = await session.getChangedFiles();
            repositoryAvailable = true;
          } catch (error) {
            warnings.push("SANDBOX_UNAVAILABLE_DIFF_ONLY_REVIEW");
            log("review.sandbox_unavailable", {
              reviewId: job.reviewId,
              stage: repositoryStage,
              code: repositoryFailureCode(error),
            });
          }
          const result = await runReview({
            onInvalidOutput: (agent, phase, diagnostic) =>
              log("review.model_invalid_output", {
                reviewId: job.reviewId,
                stage: `${agent}_${phase}`,
                code: `${diagnostic.code}:${diagnostic.issues.join("|")}`,
              }),
            context,
            files,
            tools: repositoryAvailable ? session : unavailable,
            config,
            models: settings.models,
            providers: createProviderRegistry({
              cloudflareGateway: gateway,
            }),
            pricing: settings.pricing,
            previousFindings: incrementalBaseSha === baseline.headSha ? baseline.findings : [],
            incrementalBaseSha,
            reviewStartedAt: startedAt,
          });
          const coverageComplete =
            result.coverageComplete && repositoryAvailable && !context.filesTruncated;
          return {
            ...result,
            ...(result.risk.skip && !coverageComplete
              ? { risk: { ...result.risk, skip: false }, outcome: "REVIEW_FAILED" as const }
              : {}),
            outcome: calculateOutcome(
              result.findings,
              coverageComplete && result.outcome !== "REVIEW_FAILED",
            ),
            warnings: [...warnings, ...result.warnings].slice(0, 30),
            coverageComplete,
          };
        } finally {
          await session.destroy().catch(() => {
            log("review.cleanup_failed", {
              reviewId: job.reviewId,
              stage: "sandbox",
              code: "SANDBOX_CLEANUP_FAILED",
            });
          });
        }
      },
      async isCurrent(job) {
        return (await client()).isCurrent(job);
      },
      async findPublished(job) {
        return (await client()).findReview(job);
      },
      async publish(job, result, config) {
        return (await client(true)).publishReview(job, result, {
          findingLimits: config.review.findingLimits,
          maxComments: config.review.maxComments,
          setupOrigin,
        });
      },
      async fingerprints(result) {
        return Promise.all(result.findings.map(findingFingerprint));
      },
    };
    return runPipeline(job, checkpoints, services);
  }
}
