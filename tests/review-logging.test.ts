import { afterEach, expect, it, vi } from "vitest";
import type { ReviewJob } from "@sherpa/schemas";
import { createReviewLogger } from "../apps/worker/src/review-logging";

afterEach(() => vi.restoreAllMocks());
it("indexes diagnostic objects with shared correlation and actionable log levels", () => {
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const job: ReviewJob = {
    reviewId: "a".repeat(64),
    deliveryId: "private delivery",
    installationId: 1,
    repositoryId: 2,
    owner: "private owner",
    repo: "private repo",
    number: 3,
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
    action: "opened",
  };
  const emit = createReviewLogger(job);
  emit({
    event: "review.repository_ready",
    fileCount: 1,
    repositoryAvailable: true,
    incrementalBaseSha: job.baseSha,
    durationMs: 1,
  });
  emit({ event: "review.coverage_incomplete", code: "INVESTIGATION_CONTEXT_INCOMPLETE" });
  emit({
    event: "review.model_invocation_failed",
    agent: "testing",
    phase: "VERIFY",
    callId: 2,
    code: "MODEL_INVALID_SCHEMA",
  });
  const entries = [info.mock.calls[0]![0], warning.mock.calls[0]![0], error.mock.calls[0]![0]];
  expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  for (const entry of entries)
    expect(entry).toMatchObject({
      reviewId: job.reviewId,
      runId: entries[0].runId,
      pr: 3,
      headSha: job.headSha,
      baseSha: job.baseSha,
      diagnosticsVersion: 2,
    });
  expect(entries[2]).toMatchObject({
    event: "review.model_invocation_failed",
    message: "review.model_invocation_failed",
    agent: "testing",
    phase: "VERIFY",
    callId: 2,
  });
  expect(JSON.stringify(entries)).not.toContain("private");
  createReviewLogger(job)({
    event: "review.coverage_incomplete",
    code: "INVESTIGATION_CONTEXT_INCOMPLETE",
  });
  expect(warning.mock.calls[1]![0].runId).not.toBe(entries[0].runId);
});
