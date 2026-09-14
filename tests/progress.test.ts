import { describe, expect, it, vi } from "vitest";
import { GitHubError } from "@sherpa/github";
import type { Checkpoints, PipelineOutcome } from "@sherpa/workflow";
import { withReviewCheck } from "../apps/worker/src/progress";
import { fixtureJob as job } from "./fixtures/pull-request";

function fixture() {
  const calls: string[] = [];
  const checks = {
    queue: vi.fn(async () => {
      calls.push("queued");
      return 77;
    }),
    find: vi.fn(async () => 77 as number | undefined),
    start: vi.fn(async () => {
      calls.push("in_progress");
    }),
    complete: vi.fn(async () => {
      calls.push("completed");
    }),
  };
  const steps: Checkpoints = { run: (_name, _kind, work) => work(), sleep: async () => {} };
  return { checks, steps, calls };
}
describe("Sherpa progress reporting", () => {
  it.each([
    ["published", "PASS", "success", "✅ APPROVED"],
    ["published", "PASS_WITH_FINDINGS", "success", "🟡 APPROVED WITH COMMENTS"],
    ["published", "NEEDS_ATTENTION", "failure", "❌ NOT APPROVED"],
    ["published", "REVIEW_FAILED", "failure", "Review could not complete"],
    ["published", undefined, "failure", "Review could not complete"],
    ["skipped", undefined, "skipped", "Review skipped"],
    ["stale", undefined, "cancelled", "Review superseded"],
    ["failed", undefined, "failure", "Review could not complete"],
    ["duplicate", undefined, "failure", "Review result unavailable"],
  ] as const)("concludes %s / %s correctly", async (status, outcome, conclusion, title) => {
    const { checks, steps, calls } = fixture();
    const result: PipelineOutcome = { reviewId: job.reviewId, status, outcome };
    expect(
      await withReviewCheck(
        job,
        steps,
        async () => checks,
        async (start) => {
          calls.push("waiting-for-pr");
          await start();
          calls.push("review");
          return result;
        },
      ),
    ).toBe(result);
    expect(calls).toEqual(["queued", "waiting-for-pr", "in_progress", "review", "completed"]);
    expect(checks.complete).toHaveBeenCalledWith(
      job,
      77,
      expect.objectContaining({ conclusion, title }),
    );
  });

  it("marks startup errors failed without exposing credentials or raw errors", async () => {
    const { checks, steps, calls } = fixture();
    await expect(
      withReviewCheck(
        job,
        steps,
        async () => checks,
        async () => {
          throw new Error("secret=provider-token");
        },
      ),
    ).rejects.toThrow(/^REVIEW_FAILED$/);
    expect(calls).toEqual(["queued", "completed"]);
    expect(JSON.stringify(checks.complete.mock.calls)).not.toContain("provider-token");
    expect(checks.complete).toHaveBeenCalledWith(
      job,
      77,
      expect.objectContaining({ conclusion: "failure" }),
    );
  });

  it("runs the review if check permission is missing and logs only a safe code", async () => {
    const { checks, steps } = fixture();
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const run = vi.fn(async () => ({
      status: "published" as const,
      reviewId: job.reviewId,
      outcome: "PASS",
    }));
    try {
      const factory = async () => {
        throw new GitHubError("secret=token", 403);
      };
      await withReviewCheck(job, steps, factory, run);
      expect(run).toHaveBeenCalledOnce();
      expect(checks.complete).not.toHaveBeenCalled();
      expect(JSON.stringify(logs.mock.calls)).toContain("GITHUB_CHECK_PERMISSION_REQUIRED");
      expect(JSON.stringify(logs.mock.calls)).not.toContain("secret");
    } finally {
      logs.mockRestore();
    }
  });

  it("does not report a paid review as failed when progress updates fail", async () => {
    const { checks, steps } = fixture();
    checks.start.mockRejectedValue(new Error("secret"));
    checks.complete.mockRejectedValue(new Error("secret"));
    const result: PipelineOutcome = {
      status: "published",
      reviewId: job.reviewId,
      outcome: "PASS",
    };
    expect(
      await withReviewCheck(
        job,
        steps,
        async () => checks,
        async (start) => {
          await start();
          return result;
        },
      ),
    ).toBe(result);
  });

  it("recovers a lost create with reads before completion and never repeats the POST", async () => {
    const { checks, steps } = fixture();
    checks.queue.mockRejectedValue(new GitHubError("GITHUB_NETWORK_ERROR", undefined, true));
    await withReviewCheck(
      job,
      steps,
      async () => checks,
      async () => ({ status: "failed", reviewId: job.reviewId }),
    );
    expect(checks.queue).toHaveBeenCalledOnce();
    expect(checks.find).toHaveBeenCalledOnce();
    expect(checks.complete).toHaveBeenCalledOnce();
  });

  it("recovery updates an existing run without creating a check or re-running analysis", async () => {
    const { checks, steps } = fixture();
    const recover = vi.fn(async () => ({
      status: "published" as const,
      reviewId: job.reviewId,
      outcome: "NEEDS_ATTENTION",
    }));
    await withReviewCheck(job, steps, async () => checks, recover, true);
    expect(checks.queue).not.toHaveBeenCalled();
    expect(checks.start).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledOnce();
    expect(checks.complete).toHaveBeenCalledWith(
      job,
      77,
      expect.objectContaining({ conclusion: "failure" }),
    );
  });
});
