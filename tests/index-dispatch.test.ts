import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  bootstrapIndexJob,
  dispatchIndex,
  parseIndexPush,
} from "../apps/worker/src/index-dispatch";
import { handleWebhook } from "../apps/worker/src/webhook";
import { fixtureJob, webhook } from "./fixtures/pull-request";
const push = {
  installation: { id: 17 },
  repository: { id: 42, name: "example", owner: { login: "acme" }, default_branch: "main" },
  ref: "refs/heads/main",
  deleted: false,
  after: "a".repeat(40),
};
function request(event: string, payload: unknown, valid = true) {
  const body = JSON.stringify(payload);
  return new Request("https://sherpa.test/github/webhook", {
    method: "POST",
    body,
    headers: {
      "x-github-event": event,
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": `sha256=${createHmac("sha256", valid ? "secret" : "wrong")
        .update(body)
        .digest("hex")}`,
    },
  });
}
describe("index webhook dispatch", () => {
  it("indexes only nondeleted default branch pushes", async () => {
    expect(await parseIndexPush("delivery", push)).toMatchObject({
      commitSha: push.after,
      trigger: "push",
      installationId: 17,
      repositoryId: 42,
    });
    expect(await parseIndexPush("delivery", { ...push, ref: "refs/heads/feature" })).toBeNull();
    expect(
      await parseIndexPush("delivery", { ...push, deleted: true, after: "0".repeat(40) }),
    ).toBeNull();
    await expect(parseIndexPush("delivery", { ...push, after: "main" })).rejects.toThrow();
    await expect(parseIndexPush(null, push)).rejects.toThrow();
  });
  it("scopes deterministic job IDs by repository, installation, revision and delivery", async () => {
    const first = await parseIndexPush("one", push);
    expect((await parseIndexPush("one", push))?.indexId).toBe(first?.indexId);
    expect((await parseIndexPush("two", push))?.indexId).not.toBe(first?.indexId);
    expect((await parseIndexPush("one", { ...push, installation: { id: 18 } }))?.indexId).not.toBe(
      first?.indexId,
    );
    expect(await bootstrapIndexJob(fixtureJob)).toMatchObject({
      commitSha: fixtureJob.baseSha,
      trigger: "bootstrap",
    });
  });
  it("authenticates pushes and dispatches them without a review", async () => {
    const start = vi.fn(),
      startIndex = vi.fn(async () => "started" as const);
    expect(
      (await handleWebhook(request("push", push, false), { secret: "secret", start, startIndex }))
        .status,
    ).toBe(401);
    expect(startIndex).not.toHaveBeenCalled();
    expect(
      (await handleWebhook(request("push", push), { secret: "secret", start, startIndex })).status,
    ).toBe(202);
    expect(startIndex).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });
  it("continues reviewing when bootstrap dispatch is unavailable", async () => {
    const start = vi.fn(async () => "started" as const);
    const startIndex = vi.fn(async () => {
      throw new Error("private source must not be logged");
    });
    const logging = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      (
        await handleWebhook(request("pull_request", webhook), {
          secret: "secret",
          start,
          startIndex,
        })
      ).status,
    ).toBe(202);
    expect(start).toHaveBeenCalledOnce();
    expect(startIndex).toHaveBeenCalledOnce();
    expect(JSON.stringify(logging.mock.calls)).not.toContain("private source");
    logging.mockRestore();
  });
  it("confirms lost create responses without restarting paid builds", async () => {
    const job = (await parseIndexPush("one", push))!;
    expect(
      await dispatchIndex(
        {
          create: async () => {
            throw new Error("lost");
          },
          get: async () => ({ status: async () => ({ status: "errored" }) }),
        },
        job,
      ),
    ).toBe("duplicate");
    await expect(
      dispatchIndex(
        {
          create: async () => {
            throw new Error("lost");
          },
          get: async () => {
            throw new Error("missing");
          },
        },
        job,
      ),
    ).rejects.toThrow("lost");
  });
});
