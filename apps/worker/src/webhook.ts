import { parseWebhook, verifyWebhookSignature } from "@sherpa/github";
import type { ReviewJob } from "@sherpa/schemas";
import type { RepositoryIndexJob } from "@sherpa/repository-index";
import { bootstrapIndexJob, parseIndexPush } from "./index-dispatch";
import { log, readBoundedText } from "@sherpa/shared";

export interface WebhookDependencies {
  secret: string;
  start(job: ReviewJob): Promise<"started" | "duplicate">;
  startIndex?(job: RepositoryIndexJob): Promise<"started" | "duplicate">;
}

export async function handleWebhook(
  request: Request,
  deps: WebhookDependencies,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (!deps.secret) return Response.json({ error: "WEBHOOK_NOT_CONFIGURED" }, { status: 503 });
  let body: string;
  try {
    body = await readBoundedText(request.body, 2 * 1024 * 1024);
  } catch {
    return Response.json({ error: "INVALID_OR_OVERSIZED_BODY" }, { status: 413 });
  }
  if (
    !(await verifyWebhookSignature(deps.secret, body, request.headers.get("x-hub-signature-256")))
  ) {
    return Response.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
  }
  if (request.headers.get("x-github-event") === "push" && deps.startIndex) {
    let indexJob: RepositoryIndexJob | null;
    try {
      indexJob = await parseIndexPush(request.headers.get("x-github-delivery"), JSON.parse(body));
    } catch {
      return Response.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
    }
    if (!indexJob) return Response.json({ status: "ignored" });
    try {
      const status = await deps.startIndex(indexJob);
      return Response.json({ status, indexId: indexJob.indexId }, { status: 202 });
    } catch {
      log("index.dispatch_failed", {
        installationId: indexJob.installationId,
        repositoryId: indexJob.repositoryId,
        code: "INDEX_WORKFLOW_START_FAILED",
      });
      return Response.json({ error: "INDEX_WORKFLOW_START_FAILED" }, { status: 503 });
    }
  }
  let job: ReviewJob | null;
  try {
    job = await parseWebhook(
      request.headers.get("x-github-event"),
      request.headers.get("x-github-delivery"),
      JSON.parse(body),
    );
  } catch {
    return Response.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
  }
  if (!job) return Response.json({ status: "ignored" });
  try {
    const status = await deps.start(job);
    if (deps.startIndex) {
      try {
        await deps.startIndex(await bootstrapIndexJob(job));
      } catch {
        // Discovery initialization cannot change successful review dispatch.
        log("index.dispatch_failed", {
          installationId: job.installationId,
          repositoryId: job.repositoryId,
          code: "INDEX_BOOTSTRAP_START_FAILED",
        });
      }
    }
    log("webhook.accepted", {
      reviewId: job.reviewId,
      installationId: job.installationId,
      repositoryId: job.repositoryId,
      pr: job.number,
    });
    return Response.json({ status, reviewId: job.reviewId }, { status: 202 });
  } catch {
    log("webhook.start_failed", { reviewId: job.reviewId, code: "WORKFLOW_START_FAILED" });
    return Response.json(
      { error: "WORKFLOW_START_FAILED" },
      { status: 503, headers: { "Retry-After": "10" } },
    );
  }
}
