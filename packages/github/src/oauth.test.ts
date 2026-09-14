import { describe, expect, it, vi } from "vitest";
import {
  GitHubUserOAuth,
  accessibleInstallation,
  randomOAuthState,
  signValue,
  verifySignedValue,
  type Fetcher,
} from "./index";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

describe("GitHub user OAuth", () => {
  const oauth = (fetch: Fetcher) =>
    new GitHubUserOAuth({ clientId: "Iv1.test1", clientSecret: "client-secret-value", fetch });

  it("exchanges a code and lists only this App's installations", async () => {
    const fetch = vi.fn<Fetcher>(async (input, init) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        expect(init?.redirect).toBe("error");
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        expect(body.code).toBe("oauth-code-1");
        expect(JSON.stringify(body)).not.toContain("\n");
        return json({ access_token: "user_token", token_type: "bearer" });
      }
      if (url.endsWith("/user")) return json({ id: 9, login: "alice" });
      if (url.includes("/user/installations"))
        return json({
          installations: [
            { id: 17, app_id: 123, account: { login: "acme", type: "Organization" } },
            { id: 99, app_id: 999, account: { login: "other", type: "User" } },
          ],
        });
      throw new Error("UNEXPECTED_TEST_REQUEST");
    });
    const client = oauth(fetch);
    expect(
      client.authorizeUrl({
        redirectUri: "https://sherpa.example.workers.dev/setup/callback",
        state: "a".repeat(16),
      }),
    ).toContain("client_id=Iv1.test1");
    expect(
      await client.exchange("oauth-code-1", "https://sherpa.example.workers.dev/setup/callback"),
    ).toBe("user_token");
    expect(await client.identity("user_token")).toEqual({ userId: 9, login: "alice" });
    const installations = await client.installations("user_token", 123);
    expect(installations).toEqual([{ id: 17, accountLogin: "acme", accountType: "Organization" }]);
    expect(accessibleInstallation(installations, 17)?.accountLogin).toBe("acme");
    expect(accessibleInstallation(installations, 99)).toBeUndefined();
  });

  it("rejects denied OAuth exchanges without echoing GitHub error bodies", async () => {
    const fetch: Fetcher = async () =>
      json({ error: "bad_verification_code", error_description: "secret" });
    await expect(
      oauth(fetch).exchange("oauth-code-1", "https://sherpa.example.workers.dev/setup/callback"),
    ).rejects.toThrow("GITHUB_OAUTH_DENIED");
  });

  it("signs and verifies setup cookies", async () => {
    const secret = "setup-session-secret";
    const signed = await signValue(secret, "payload");
    expect(await verifySignedValue(secret, signed)).toBe("payload");
    expect(await verifySignedValue("other-session-secret", signed)).toBeNull();
    expect(await verifySignedValue(secret, "payload.AAAA")).toBeNull();
    expect(await randomOAuthState()).toMatch(/^[a-f0-9]{48}$/);
  });
});
