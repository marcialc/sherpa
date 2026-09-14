import { GitHubError, type CheckCompletion, type GitHubChecks } from "@sherpa/github";
import type { ReviewJob } from "@sherpa/schemas";
import { log } from "@sherpa/shared";
import type { Checkpoints, PipelineOutcome } from "@sherpa/workflow";

type Checks = Pick<GitHubChecks, "queue" | "find" | "start" | "complete">;

export function checkCompletion(result: PipelineOutcome): CheckCompletion {
  if (result.status === "skipped")
    return {
      conclusion: "skipped",
      title: "Review skipped",
      summary: "Repository policy, draft settings, or the changed files did not require a review.",
    };
  if (result.status === "stale")
    return {
      conclusion: "cancelled",
      title: "Review superseded",
      summary: "The pull request changed or closed during the review. Check the latest commit.",
    };
  if (result.status === "duplicate")
    return {
      conclusion: "failure",
      title: "Review result unavailable",
      summary:
        "A previous attempt handled this review, but its completion could not be confirmed. Check the Sherpa review and Cloudflare Workflow logs.",
    };
  if (result.status === "published") {
    if (result.outcome === "PASS")
      return {
        conclusion: "success",
        title: "✅ APPROVED",
        summary:
          "Review completed with no actionable findings. See the Sherpa review in the conversation.",
      };
    if (result.outcome === "PASS_WITH_FINDINGS")
      return {
        conclusion: "success",
        title: "🟡 APPROVED WITH COMMENTS",
        summary:
          "Review completed with non-blocking findings. See the Sherpa review in the conversation.",
      };
    if (result.outcome === "NEEDS_ATTENTION")
      return {
        conclusion: "failure",
        title: "❌ NOT APPROVED",
        summary:
          "The review found issues that need fixing. See the Sherpa review in the conversation.",
      };
  }
  return {
    conclusion: "failure",
    title: "Review could not complete",
    summary:
      "Sherpa could not complete a verified review. Check the review's coverage notes, if available, and the Cloudflare Workflow logs. This is not an approval.",
  };
}

/** Progress failures must not stop the review, and must never leak GitHub/provider errors. */
export async function withReviewCheck(
  job: ReviewJob,
  steps: Checkpoints,
  checks: () => Promise<Checks>,
  run: (onStarted: () => Promise<void>) => Promise<PipelineOutcome>,
  recoveryOnly = false,
): Promise<PipelineOutcome> {
  async function safely<T>(
    name: string,
    kind: "read" | "write" | "status",
    work: () => Promise<T>,
  ) {
    try {
      return await steps.run(name, kind, async () => {
        try {
          return await work();
        } catch (error) {
          const permission = error instanceof GitHubError && [403, 422].includes(error.status ?? 0);
          // Do not persist credential-bearing exceptions as Workflow step causes.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(
            permission ? "GITHUB_CHECK_PERMISSION_REQUIRED" : "GITHUB_CHECK_UPDATE_FAILED",
          );
        }
      });
    } catch (error) {
      log("review.check_failed", {
        reviewId: job.reviewId,
        stage: name,
        code:
          error instanceof Error && error.message === "GITHUB_CHECK_PERMISSION_REQUIRED"
            ? "GITHUB_CHECK_PERMISSION_REQUIRED"
            : "GITHUB_CHECK_UPDATE_FAILED",
      });
      return undefined;
    }
  }
  let id = await safely("queue-sherpa-check", recoveryOnly ? "read" : "write", async () => {
    const github = await checks();
    return recoveryOnly ? github.find(job) : github.queue(job);
  });
  const onStarted = async () => {
    if (id !== undefined)
      await safely("start-sherpa-check", "status", async () => (await checks()).start(job, id!));
  };
  const finish = async (result: PipelineOutcome) => {
    await safely("finish-sherpa-check", "status", async () => {
      const github = await checks();
      // Reconcile an uncertain create using GETs; do not create a second check.
      id ??= await github.find(job);
      if (id !== undefined) await github.complete(job, id, checkCompletion(result));
    });
  };
  try {
    const result = await run(onStarted);
    await finish(result);
    return result;
  } catch {
    await finish({ status: "failed", reviewId: job.reviewId });
    throw new Error("REVIEW_FAILED");
  }
}
