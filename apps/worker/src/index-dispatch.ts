import { hashText } from "@sherpa/shared";
import { indexJobSchema, type RepositoryIndexJob } from "@sherpa/repository-index";
import { reviewJobSchema, shaSchema, type ReviewJob } from "@sherpa/schemas";
import { z } from "zod";

export interface IndexWorkflowLauncher {
  create(options: { id: string; params: RepositoryIndexJob }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}

async function makeJob(input: Omit<RepositoryIndexJob, "indexId">): Promise<RepositoryIndexJob> {
  // Delivery distinguishes safe fresh attempts after failed builds. Redeliveries dedupe.
  const indexId = await hashText(
    JSON.stringify([
      "sherpa-index-v1",
      input.installationId,
      input.repositoryId,
      input.commitSha,
      input.trigger,
      input.deliveryId,
    ]),
  );
  return indexJobSchema.parse({ ...input, indexId });
}

export async function bootstrapIndexJob(job: ReviewJob): Promise<RepositoryIndexJob> {
  return makeJob({
    installationId: job.installationId,
    repositoryId: job.repositoryId,
    owner: job.owner,
    repo: job.repo,
    commitSha: job.baseSha,
    trigger: "bootstrap",
    deliveryId: job.deliveryId,
  });
}

/** Only call after HMAC verification over the original body. */
export async function parseIndexPush(
  deliveryId: string | null,
  payload: unknown,
): Promise<RepositoryIndexJob | null> {
  const parsed = z
    .object({
      ref: z.string().min(1).max(1024),
      deleted: z.boolean(),
      after: shaSchema,
      installation: z.object({ id: z.number().int().positive().safe() }),
      repository: z.object({
        id: z.number().int().positive().safe(),
        name: reviewJobSchema.shape.repo,
        owner: z.object({ login: reviewJobSchema.shape.owner }),
        default_branch: z.string().min(1).max(255),
      }),
    })
    .parse(payload);
  if (parsed.deleted || parsed.ref !== `refs/heads/${parsed.repository.default_branch}`)
    return null;
  if (/^0+$/.test(parsed.after)) throw new Error("INVALID_INDEX_PUSH_SHA");
  return makeJob({
    installationId: parsed.installation.id,
    repositoryId: parsed.repository.id,
    owner: parsed.repository.owner.login,
    repo: parsed.repository.name,
    commitSha: parsed.after,
    trigger: "push",
    deliveryId: indexJobSchema.shape.deliveryId.parse(deliveryId),
  });
}

export async function dispatchIndex(
  workflows: IndexWorkflowLauncher,
  job: RepositoryIndexJob,
): Promise<"started" | "duplicate"> {
  indexJobSchema.parse(job);
  try {
    await workflows.create({ id: job.indexId, params: job });
    return "started";
  } catch (error) {
    // Never restart a failed paid attempt. A later delivery gets a fresh Workflow ID.
    try {
      await (await workflows.get(job.indexId)).status();
      return "duplicate";
    } catch {
      throw error;
    }
  }
}
