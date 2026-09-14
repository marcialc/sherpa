import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GitHubApp } from "./auth";
import { GitHubChecks } from "./checks";
import type { Fetcher } from "./http";
import { fixtureJob as job, repository } from "../../../tests/fixtures/pull-request";

const identity = { appId: 123, botLogin: "sherpa[bot]" };
const original = {
  id: 77,
  name: "Sherpa",
  head_sha: job.headSha,
  external_id: job.reviewId,
  app: { id: identity.appId },
  status: "queued",
};
const completion = { conclusion: "success" as const, title: "Approved", summary: "Verified." };
function fixture(
  options: { lostCreate?: boolean; lostUpdate?: boolean; unrelated?: boolean } = {},
) {
  const runs: (typeof original)[] = options.unrelated
    ? [
        { ...original, id: 41, app: { id: 999 } },
        { ...original, id: 42, external_id: "a-different-pr" },
        { ...original, id: 43, head_sha: "d".repeat(40) },
      ]
    : [];
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  let lostUpdate = options.lostUpdate;
  const fetcher = vi.fn<Fetcher>(async function (this: unknown, input, init) {
    // Native Workers fetch requires a free-function call and manual/follow redirects.
    expect(this).toBeUndefined();
    expect(init?.redirect).toBe("manual");
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      writes.push({ method: "POST", body });
      runs.push({ ...original });
      if (options.lostCreate) throw new Error("network lost secret=never-log");
      return Response.json(runs.at(-1));
    }
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      writes.push({ method: "PATCH", body });
      Object.assign(
        runs.find((r) => r.id === 77)!,
        body,
      );
      if (lostUpdate) {
        lostUpdate = false;
        throw new Error("lost update response");
      }
      return Response.json(runs.find((r) => r.id === 77));
    }
    if (url.pathname.includes("/commits/")) {
      expect(url.searchParams.get("filter")).toBe("all");
      expect(url.searchParams.get("app_id")).toBe("123");
      return Response.json({ check_runs: runs });
    }
    return Response.json(runs.find((r) => r.id === Number(url.pathname.split("/").at(-1))));
  });
  return { checks: new GitHubChecks("test-token", identity, fetcher), runs, writes, fetcher };
}

describe("GitHub review check lifecycle", () => {
  it("queues on the reviewed SHA, starts, and completes one check across replay", async () => {
    const { checks, writes } = fixture();
    const id = await checks.queue(job);
    expect(await checks.queue(job)).toBe(id);
    await checks.start(job, id);
    await checks.start(job, id);
    await checks.complete(job, id, completion);
    await checks.start(job, id);
    await checks.complete(job, id, { ...completion, conclusion: "failure" });
    expect(writes).toHaveLength(3);
    expect(writes[0]).toMatchObject({
      method: "POST",
      body: {
        name: "Sherpa",
        head_sha: job.headSha,
        external_id: job.reviewId,
        status: "queued",
        details_url: "https://github.com/acme/calculator/pull/7",
      },
    });
    expect(writes[1]).toMatchObject({ method: "PATCH", body: { status: "in_progress" } });
    expect(writes[2]).toMatchObject({
      method: "PATCH",
      body: { status: "completed", conclusion: "success" },
    });
  });

  it("reconciles a lost create response without posting a duplicate", async () => {
    const { checks, writes } = fixture({ lostCreate: true });
    expect(await checks.queue(job)).toBe(77);
    expect(writes.filter((write) => write.method === "POST")).toHaveLength(1);
  });

  it("does not repeat an update that succeeded before its response was lost", async () => {
    const { checks, writes } = fixture({ lostUpdate: true });
    const id = await checks.queue(job);
    await expect(checks.complete(job, id, completion)).rejects.toThrow("GITHUB_NETWORK_ERROR");
    await checks.complete(job, id, completion);
    expect(writes.filter((write) => write.method === "PATCH")).toHaveLength(1);
  });

  it("ignores checks for another app, PR, or commit and refuses to update them", async () => {
    const { checks, writes } = fixture({ unrelated: true });
    expect(await checks.queue(job)).toBe(77);
    for (const id of [41, 42, 43])
      await expect(checks.start(job, id)).rejects.toThrow("GITHUB_CHECK_SCOPE_MISMATCH");
    expect(writes).toHaveLength(1);
  });

  it("never creates after incomplete pagination or a failed lookup", async () => {
    const fetcher = vi.fn<Fetcher>(async () =>
      Response.json(
        { check_runs: [] },
        {
          headers: { link: '<https://api.github.com/example?page=2>; rel="next"' },
        },
      ),
    );
    const checks = new GitHubChecks("test-token", identity, fetcher);
    await expect(checks.queue(job)).rejects.toThrow("GITHUB_CHECK_PAGINATION_LIMIT");
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
});

describe("Checks permission isolation", () => {
  let privateKey: string;
  beforeAll(() => {
    privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
  });
  function app(granted: Record<string, string | undefined>, repos = [repository]) {
    const fetcher = vi.fn<Fetcher>(async (url, init) => {
      if (String(url).endsWith("/installation"))
        return Response.json({ id: job.installationId, app_id: identity.appId });
      expect(JSON.parse(String(init?.body))).toEqual({
        repository_ids: [job.repositoryId],
        permissions: { metadata: "read", checks: "write" },
      });
      return Response.json({
        token: "checks-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: granted,
        repositories: repos,
      });
    });
    return new GitHubApp({ appId: identity.appId, privateKey, fetch: fetcher });
  }
  it("mints a checks-only token restricted to the selected repository", async () => {
    expect(await app({ metadata: "read", checks: "write" }).installationToken(job, "checks")).toBe(
      "checks-token",
    );
  });
  it("rejects insufficient or broader permissions and other repositories", async () => {
    for (const permissions of [
      { checks: "read" },
      { checks: "write", contents: "write" },
      { checks: "write", pull_requests: "write" },
    ])
      await expect(app(permissions).installationToken(job, "checks")).rejects.toThrow(
        "INVALID_GITHUB_INSTALLATION_TOKEN",
      );
    await expect(
      app({ checks: "write" }, [{ ...repository, id: 999 }]).installationToken(job, "checks"),
    ).rejects.toThrow("GITHUB_TOKEN_SCOPE_MISMATCH");
  });
});
