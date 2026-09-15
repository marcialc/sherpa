import type { ReviewDiagnostic } from "@sherpa/agents";
import type { ReviewJob } from "@sherpa/schemas";

type RepositoryDiagnostic = {
  event: "review.repository_ready";
  fileCount: number;
  repositoryAvailable: boolean;
  incrementalBaseSha: string;
  durationMs: number;
};

/** Only sanitized metadata assembled by the review engine enters this sink. */
export function createReviewLogger(job: ReviewJob) {
  const runId = crypto.randomUUID();
  let sequence = 0;
  return (diagnostic: ReviewDiagnostic | RepositoryDiagnostic): void => {
    const entry = {
      message: diagnostic.event,
      ...diagnostic,
      diagnosticsVersion: 2,
      sequence: ++sequence,
      runId,
      reviewId: job.reviewId,
      installationId: job.installationId,
      repositoryId: job.repositoryId,
      pr: job.number,
      baseSha: job.baseSha,
      headSha: job.headSha,
    };
    if (diagnostic.event.endsWith("_failed")) console.error(entry);
    else if (
      diagnostic.event === "review.model_invalid_output" ||
      diagnostic.event === "review.coverage_incomplete" ||
      (diagnostic.event === "review.tool_completed" &&
        (diagnostic.status !== "ok" || diagnostic.truncated)) ||
      (diagnostic.event === "review.analysis_completed" && !diagnostic.coverageComplete)
    )
      console.warn(entry);
    else console.log(entry);
  };
}
