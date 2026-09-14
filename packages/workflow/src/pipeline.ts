import type { PullRequestContext, RepoConfig, ReviewJob, ReviewResult } from "@sherpa/schemas";
import { log } from "@sherpa/shared";
import type { Baseline, Claim, Ledger } from "./ledger";

export interface Checkpoints {
  run<T>(
    name: string,
    kind: "read" | "analysis" | "write" | "status",
    work: () => Promise<T>,
  ): Promise<T>;
  sleep(name: string, milliseconds: number): Promise<void>;
}
export interface PipelineLedger {
  claim(job: ReviewJob, leaseMs: number, acquisitionToken: string): Promise<Claim>;
  renew(reviewId: string, token: string, leaseMs: number): Promise<void>;
  reserveAnalysis(reviewId: string, token: string): Promise<boolean>;
  reservePublication(
    reviewId: string,
    token: string,
    data?: {
      findings: ReviewResult["findings"];
      fingerprints: string[];
      outcome: ReviewResult["outcome"];
      cost: ReviewResult["cost"];
    },
  ): Promise<"send" | "reconcile">;
  complete(job: ReviewJob, token: string, data: Parameters<Ledger["complete"]>[3]): Promise<void>;
  finish(
    reviewId: string,
    token: string,
    status: "failed" | "skipped" | "uncertain",
  ): Promise<void>;
}
export interface PipelineServices {
  ledger: PipelineLedger;
  maxDurationMs: number;
  onStarted?(): Promise<void>;
  load(job: ReviewJob): Promise<{ context: PullRequestContext; config: RepoConfig }>;
  analyze(
    context: PullRequestContext,
    config: RepoConfig,
    baseline: Baseline,
  ): Promise<ReviewResult>;
  isCurrent(job: ReviewJob): Promise<boolean>;
  findPublished(job: ReviewJob): Promise<{ id: number; postedFingerprints?: string[] } | null>;
  publish(
    job: ReviewJob,
    result: ReviewResult,
    config: RepoConfig,
  ): Promise<{ id: number; postedFingerprints: string[] }>;
  fingerprints(result: ReviewResult): Promise<string[]>;
}
export type PipelineOutcome = {
  status: "published" | "duplicate" | "skipped" | "stale" | "failed";
  reviewId: string;
  githubReviewId?: number;
  outcome?: string;
};

export async function runPipeline(
  job: ReviewJob,
  steps: Checkpoints,
  services: PipelineServices,
): Promise<PipelineOutcome> {
  const leaseMs = services.maxDurationMs + 300000;
  const acquisitionToken = await steps.run("acquisition-token", "read", () =>
    Promise.resolve(crypto.randomUUID()),
  );
  let claim: Claim = { status: "busy" };
  // Serializes reviews of a PR without holding a request or DO event open.
  for (let attempt = 0; attempt < Math.ceil(leaseMs / 10000) + 12; attempt++) {
    claim = await steps.run(`claim-${attempt}`, "read", () =>
      services.ledger.claim(job, leaseMs, acquisitionToken),
    );
    if (claim.status !== "busy") break;
    await steps.sleep(`wait-for-pr-${attempt}`, 10000);
  }
  if (claim.status !== "acquired") {
    if (claim.status === "done") return { status: "duplicate", reviewId: job.reviewId };
    throw new Error("PR_REVIEW_BUSY");
  }
  const { token, baseline } = claim;
  try {
    await services.onStarted?.();
    const { context, config } = await steps.run("load-pull-request-and-policy", "read", () =>
      services.load(job),
    );
    if (
      context.headSha !== job.headSha ||
      context.baseSha !== job.baseSha ||
      context.state !== "open"
    ) {
      await steps.run("discard-stale-review", "write", () =>
        services.ledger.finish(job.reviewId, token, "skipped"),
      );
      return { status: "stale", reviewId: job.reviewId };
    }
    if (!config.enabled || (context.draft && !config.review.reviewDrafts)) {
      await steps.run("skip-disabled-review", "write", () =>
        services.ledger.finish(job.reviewId, token, "skipped"),
      );
      return { status: "skipped", reviewId: job.reviewId };
    }
    const result = await steps.run("analyze-repository", "analysis", async () => {
      await services.ledger.renew(job.reviewId, token, leaseMs);
      if (!(await services.ledger.reserveAnalysis(job.reviewId, token)))
        throw new Error("ANALYSIS_ALREADY_STARTED");
      const started = Date.now();
      log("review.analysis_started", { reviewId: job.reviewId, stage: "analysis" });
      const result = await services.analyze(context, config, baseline);
      log("review.analysis_finished", {
        reviewId: job.reviewId,
        stage: "analysis",
        durationMs: Date.now() - started,
        count: result.findings.length,
        outcome: result.outcome,
        totalEstimatedUsd: result.cost.totalEstimatedUsd,
      });
      return result;
    });
    if (result.risk.skip && result.coverageComplete) {
      await steps.run("skip-routed-review", "write", () =>
        services.ledger.finish(job.reviewId, token, "skipped"),
      );
      return { status: "skipped", reviewId: job.reviewId };
    }
    let publication = await steps.run("publish-github-review", "write", async () => {
      await services.ledger.renew(job.reviewId, token, leaseMs);
      if (!(await services.isCurrent(job))) return { status: "stale" as const };
      const existing = await services.findPublished(job);
      if (existing)
        return {
          status: "published" as const,
          id: existing.id,
          postedFingerprints: existing.postedFingerprints ?? (await services.fingerprints(result)),
        };
      const reservation = await services.ledger.reservePublication(job.reviewId, token, {
        findings: result.findings,
        fingerprints: await services.fingerprints(result),
        outcome: result.outcome,
        cost: result.cost,
      });
      // A persisted reservation means a previous attempt may have sent the POST.
      // Absence in a later GET cannot prove a timed-out POST will never complete.
      if (reservation !== "send") return { status: "uncertain" as const };
      try {
        return { status: "published" as const, ...(await services.publish(job, result, config)) };
      } catch {
        return { status: "uncertain" as const };
      }
    });
    // Only GETs run after uncertainty. Persisting this state also prevents a
    // Workflow replay from resending the non-idempotent review POST.
    for (let attempt = 0; publication.status === "uncertain" && attempt < 3; attempt++) {
      await steps.sleep(`wait-publication-${attempt}`, 5000 * (attempt + 1));
      publication = await steps.run(`reconcile-publication-${attempt}`, "read", async () => {
        const existing = await services.findPublished(job);
        return existing
          ? {
              status: "published" as const,
              id: existing.id,
              postedFingerprints:
                existing.postedFingerprints ?? (await services.fingerprints(result)),
            }
          : { status: "uncertain" as const };
      });
    }
    if (publication.status === "uncertain") throw new Error("PUBLICATION_UNCERTAIN");
    if (publication.status === "stale") {
      await steps.run("discard-before-publication", "write", () =>
        services.ledger.finish(job.reviewId, token, "skipped"),
      );
      return { status: "stale", reviewId: job.reviewId };
    }
    const published = publication;
    await steps.run("commit-reviewed-head", "write", async () => {
      await services.ledger.complete(job, token, {
        githubReviewId: published.id,
        findings: result.findings,
        fingerprints: published.postedFingerprints,
        outcome: result.outcome,
        cost: result.cost,
        coverageComplete: result.coverageComplete && result.outcome !== "REVIEW_FAILED",
      });
      log("review.published", {
        reviewId: job.reviewId,
        stage: "publish",
        outcome: result.outcome,
        count: result.findings.length,
      });
    });
    return {
      status: "published",
      reviewId: job.reviewId,
      githubReviewId: published.id,
      outcome: result.outcome,
    };
  } catch {
    await steps.run("record-failure", "write", async () => {
      await services.ledger.finish(job.reviewId, token, "failed");
      log("review.failed", { reviewId: job.reviewId, code: "REVIEW_FAILED" });
    });
    // A safe fixed error lets Workflows display a failed run without leaking repository data.
    throw new Error("REVIEW_FAILED");
  }
}
