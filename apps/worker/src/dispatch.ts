import type { ReviewJob } from "@sherpa/schemas";

type WorkflowHandle = { status(): Promise<{ status: string }>; restart(): Promise<void> };
export interface WorkflowLauncher {
  create(options: { id: string; params: ReviewJob & { recoveryOnly?: boolean } }): Promise<unknown>;
  get(id: string): Promise<WorkflowHandle>;
}

export async function dispatchReview(
  workflows: WorkflowLauncher,
  job: ReviewJob,
): Promise<"started" | "duplicate"> {
  try {
    await workflows.create({ id: job.reviewId, params: job });
    return "started";
  } catch (error) {
    // A lost create response does not establish failure. Confirm existence first.
    try {
      const existing = await (await workflows.get(job.reviewId)).status();
      if (existing.status === "errored" || existing.status === "terminated") {
        const recoveryId = `${job.reviewId}-recovery`;
        try {
          await workflows.create({ id: recoveryId, params: { ...job, recoveryOnly: true } });
        } catch {
          const recovery = await workflows.get(recoveryId);
          const state = await recovery.status();
          // Recovery only reads GitHub; restarting cannot repeat paid analysis or a review POST.
          if (state.status === "errored" || state.status === "terminated") await recovery.restart();
        }
      }
      return "duplicate";
    } catch {
      throw error;
    }
  }
}
