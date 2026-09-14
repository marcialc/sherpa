import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi, type Fetcher } from "./http";
import { GitHubUserOAuth } from "./oauth";

afterEach(() => vi.unstubAllGlobals());

// Node's fetch accepts arbitrary receivers; the Workers runtime rejects them.
function workerFetch(): Fetcher {
  return async function (this: unknown, input, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    if (init?.redirect === "error") throw new TypeError("Unsupported redirect mode");
    if (String(input) === "https://github.com/login/oauth/access_token")
      return Response.json({ access_token: "test-user-token", token_type: "bearer" });
    if (String(input) === "https://api.github.com/user")
      return Response.json({ id: 9, login: "alice" });
    throw new Error("UNEXPECTED_TEST_REQUEST");
  };
}

describe.each(["default", "injected"] as const)("Workers-compatible %s fetch", (source) => {
  function configureFetch(): Fetcher | undefined {
    const fetcher = workerFetch();
    if (source === "injected") return fetcher;
    vi.stubGlobal("fetch", fetcher);
    return undefined;
  }

  it("exchanges an OAuth code and loads the signed-in identity", async () => {
    const client = new GitHubUserOAuth({
      clientId: "Iv1.test1",
      clientSecret: "test-client-secret",
      fetch: configureFetch(),
    });
    const token = await client.exchange("test-oauth-code", "https://sherpa.example/setup/callback");
    expect(token).toBe("test-user-token");
    await expect(client.identity(token)).resolves.toEqual({ userId: 9, login: "alice" });
  });

  it("makes authenticated GitHub API requests", async () => {
    const client = new GitHubApi("test-user-token", configureFetch());
    await expect(client.request("/user")).resolves.toMatchObject({
      data: { id: 9, login: "alice" },
    });
  });
});

it.each([301, 302, 303, 307, 308])(
  "rejects HTTP %i without forwarding credentials",
  async (status) => {
    const fetcher = vi.fn<Fetcher>(
      async () =>
        new Response(null, { status, headers: { location: "https://other.example/token" } }),
    );
    const oauth = new GitHubUserOAuth({
      clientId: "Iv1.test1",
      clientSecret: "test-client-secret",
      fetch: fetcher,
    });
    await expect(
      oauth.exchange("test-oauth-code", "https://sherpa.example/setup/callback"),
    ).rejects.toMatchObject({ code: "GITHUB_OAUTH_EXCHANGE_FAILED", status });
    await expect(new GitHubApi("test-user-token", fetcher).request("/user")).rejects.toMatchObject({
      code: `GITHUB_HTTP_${status}`,
      status,
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
    ]);
    for (const [, init] of fetcher.mock.calls) expect(init?.redirect).toBe("manual");
  },
);
