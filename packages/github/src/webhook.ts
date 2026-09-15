import { reviewJobSchema, shaSchema, type ReviewJob } from "@sherpa/schemas";
import { z } from "zod";

const encoder = new TextEncoder();
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signature: string | null,
): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, (hex) =>
    Number.parseInt(hex, 16),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, bytes, encoder.encode(rawBody));
}

export const repositorySchema = z.object({
  id: z.number().int().positive(),
  name: reviewJobSchema.shape.repo,
  owner: z.object({ login: reviewJobSchema.shape.owner }),
});

const pullRequestActions = ["opened", "reopened", "synchronize"] as const;
const webhookSchema = z.object({
  action: z.enum(pullRequestActions),
  number: z.number().int().positive(),
  installation: z.object({ id: z.number().int().positive() }),
  repository: repositorySchema,
  pull_request: z.object({
    number: z.number().int().positive(),
    state: z.enum(["open", "closed"]),
    base: z.object({ sha: shaSchema, repo: repositorySchema }),
    head: z.object({ sha: shaSchema }),
  }),
});

const associatedPullRequestSchema = z.object({
  number: z.number().int().positive(),
  head: z.object({ sha: shaSchema }),
  base: z.object({
    sha: shaSchema,
    repo: z.object({
      id: z.number().int().positive(),
      name: reviewJobSchema.shape.repo,
    }),
  }),
});
const associatedPullRequestsSchema = z.array(associatedPullRequestSchema).max(10);
const checkRunRerequestSchema = z.object({
  action: z.literal("rerequested"),
  installation: z.object({ id: z.number().int().positive() }),
  repository: repositorySchema,
  check_run: z.object({
    name: z.literal("Sherpa"),
    head_sha: shaSchema,
    external_id: z.string().regex(/^[a-f0-9]{64}$/),
    pull_requests: associatedPullRequestsSchema,
    check_suite: z.object({ pull_requests: associatedPullRequestsSchema.optional() }).optional(),
  }),
});
const checkSuiteRerequestSchema = z.object({
  action: z.literal("rerequested"),
  installation: z.object({ id: z.number().int().positive() }),
  repository: repositorySchema,
  check_suite: z.object({
    head_sha: shaSchema,
    pull_requests: associatedPullRequestsSchema,
  }),
});

function requireDeliveryId(deliveryId: string | null): string {
  if (!deliveryId || !/^[a-zA-Z0-9-]{1,100}$/.test(deliveryId))
    throw new Error("INVALID_WEBHOOK_DELIVERY");
  return deliveryId;
}

function associatedPullRequest(
  pullRequests: z.infer<typeof associatedPullRequestSchema>[],
  repository: z.infer<typeof repositorySchema>,
  headSha: string,
): z.infer<typeof associatedPullRequestSchema> | undefined {
  const matches = pullRequests.filter(
    (pr) =>
      pr.head.sha === headSha &&
      pr.base.repo.id === repository.id &&
      pr.base.repo.name.toLowerCase() === repository.name.toLowerCase(),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

async function reviewJobFrom(input: {
  deliveryId: string;
  installationId: number;
  repository: z.infer<typeof repositorySchema>;
  number: number;
  baseSha: string;
  headSha: string;
  action: ReviewJob["action"];
  rerun?: boolean;
}): Promise<ReviewJob> {
  const reviewId = await sha256(
    JSON.stringify([
      "sherpa-v1",
      input.installationId,
      input.repository.id,
      input.number,
      input.baseSha,
      input.headSha,
      ...(input.rerun ? ["rerequested", input.deliveryId] : []),
    ]),
  );
  return reviewJobSchema.parse({
    reviewId,
    deliveryId: input.deliveryId,
    installationId: input.installationId,
    repositoryId: input.repository.id,
    owner: input.repository.owner.login,
    repo: input.repository.name,
    number: input.number,
    baseSha: input.baseSha,
    headSha: input.headSha,
    action: input.action,
  });
}

/** Call only after authenticating the raw request bytes. Irrelevant events return null. */
export async function parseWebhook(
  event: string | null,
  deliveryId: string | null,
  payload: unknown,
): Promise<ReviewJob | null> {
  const action = z.object({ action: z.string() }).safeParse(payload);
  if (event === "pull_request") {
    if (!action.success) throw new Error("INVALID_WEBHOOK_PAYLOAD");
    if (!(pullRequestActions as readonly string[]).includes(action.data.action)) return null;
    const delivery = requireDeliveryId(deliveryId);
    const parsed = webhookSchema.safeParse(payload);
    if (!parsed.success) throw new Error("INVALID_WEBHOOK_PAYLOAD");
    const { repository, installation, pull_request: pr } = parsed.data;
    if (
      pr.number !== parsed.data.number ||
      pr.base.repo.id !== repository.id ||
      pr.base.repo.name.toLowerCase() !== repository.name.toLowerCase() ||
      pr.base.repo.owner.login.toLowerCase() !== repository.owner.login.toLowerCase()
    )
      throw new Error("WEBHOOK_REPOSITORY_MISMATCH");
    if (pr.state !== "open") return null;
    return reviewJobFrom({
      deliveryId: delivery,
      installationId: installation.id,
      repository,
      number: pr.number,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      action: parsed.data.action,
    });
  }
  if (event !== "check_run" && event !== "check_suite") return null;
  if (!action.success) throw new Error("INVALID_WEBHOOK_PAYLOAD");
  if (action.data.action !== "rerequested") return null;
  const delivery = requireDeliveryId(deliveryId);
  if (event === "check_run") {
    const parsed = checkRunRerequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error("INVALID_WEBHOOK_PAYLOAD");
    const { repository, installation, check_run: check } = parsed.data;
    const pr = associatedPullRequest(
      check.pull_requests.length ? check.pull_requests : (check.check_suite?.pull_requests ?? []),
      repository,
      check.head_sha,
    );
    if (!pr) return null;
    return reviewJobFrom({
      deliveryId: delivery,
      installationId: installation.id,
      repository,
      number: pr.number,
      baseSha: pr.base.sha,
      headSha: check.head_sha,
      action: "rerequested",
      rerun: true,
    });
  }
  const parsed = checkSuiteRerequestSchema.safeParse(payload);
  if (!parsed.success) throw new Error("INVALID_WEBHOOK_PAYLOAD");
  const { repository, installation, check_suite: suite } = parsed.data;
  const pr = associatedPullRequest(suite.pull_requests, repository, suite.head_sha);
  if (!pr) return null;
  return reviewJobFrom({
    deliveryId: delivery,
    installationId: installation.id,
    repository,
    number: pr.number,
    baseSha: pr.base.sha,
    headSha: suite.head_sha,
    action: "rerequested",
    rerun: true,
  });
}
