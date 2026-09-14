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

const webhookSchema = z.object({
  action: reviewJobSchema.shape.action,
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

/** Call only after authenticating the raw request bytes. Irrelevant events return null. */
export async function parseWebhook(
  event: string | null,
  deliveryId: string | null,
  payload: unknown,
): Promise<ReviewJob | null> {
  if (event !== "pull_request") return null;
  const action = z.object({ action: z.string() }).safeParse(payload);
  if (!action.success) throw new Error("INVALID_WEBHOOK_PAYLOAD");
  if (!["opened", "reopened", "synchronize"].includes(action.data.action)) return null;
  if (!deliveryId || !/^[a-zA-Z0-9-]{1,100}$/.test(deliveryId))
    throw new Error("INVALID_WEBHOOK_DELIVERY");
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
  const reviewId = await sha256(
    JSON.stringify([
      "sherpa-v1",
      installation.id,
      repository.id,
      pr.number,
      pr.base.sha,
      pr.head.sha,
    ]),
  );
  return reviewJobSchema.parse({
    reviewId,
    deliveryId,
    installationId: installation.id,
    repositoryId: repository.id,
    owner: repository.owner.login,
    repo: repository.name,
    number: pr.number,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    action: parsed.data.action,
  });
}
