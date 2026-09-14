import { describe, expect, it, vi } from "vitest";
import { signValue, type Fetcher } from "@sherpa/github";
import type { CloudflareGatewayConfig } from "@sherpa/models";
import { handleSetup, type SetupEnv, type SetupSettingsStub } from "../apps/worker/src/setup";
import type { GatewayStatus } from "../apps/worker/src/billing";

const secret = "setup-session-secret";
const gateway = {
  accountId: "a".repeat(32),
  gatewayId: "sherpa",
  apiToken: "cf-customer-token",
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value));
}
function cookieValue(response: Response, name: string): string {
  const header = [...response.headers.getSetCookie()].find((value) => value.startsWith(`${name}=`));
  expect(header).toBeTruthy();
  return header!.slice(name.length + 1).split(";")[0]!;
}
function githubFetch(): Fetcher {
  return vi.fn<Fetcher>(async (input) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token")
      return json({ access_token: "user_token", token_type: "bearer" });
    if (url.endsWith("/user")) return json({ id: 9, login: "alice" });
    if (url.includes("/user/installations"))
      return json({
        installations: [{ id: 17, app_id: 123, account: { login: "acme", type: "Organization" } }],
      });
    throw new Error(`UNEXPECTED ${url}`);
  });
}
function memorySettings() {
  const stored = new Map<string, CloudflareGatewayConfig>();
  return {
    stored,
    getByName(id: string): SetupSettingsStub {
      return {
        getGateway: async () => stored.get(id) ?? null,
        putGateway: async (config) => {
          stored.set(id, config);
        },
        status: async (): Promise<GatewayStatus> => {
          const config = stored.get(id);
          return config
            ? {
                configured: true,
                accountId: config.accountId,
                gatewayId: config.gatewayId,
                updatedAt: 1,
              }
            : { configured: false };
        },
        clear: async () => {
          stored.delete(id);
        },
      };
    },
  };
}
function env(settings = memorySettings(), fetch = githubFetch()): SetupEnv & { fetch: Fetcher } {
  return {
    GITHUB_APP_ID: "123",
    GITHUB_CLIENT_ID: "Iv1.test1",
    GITHUB_CLIENT_SECRET: "client-secret-value",
    SETUP_SESSION_SECRET: secret,
    INSTALLATION_SETTINGS: settings,
    fetch,
  };
}

async function authorize(setup: ReturnType<typeof env>, installationId?: string) {
  const start = await handleSetup(
    new Request(
      `https://sherpa.example.workers.dev/setup${installationId ? `?installation_id=${installationId}` : ""}`,
    ),
    setup,
    { fetch: setup.fetch },
  );
  expect(start.status).toBe(302);
  const location = new URL(start.headers.get("location")!);
  const callback = await handleSetup(
    new Request(
      `https://sherpa.example.workers.dev/setup/callback?code=oauth-code-1&state=${location.searchParams.get("state")}`,
      { headers: { cookie: `sherpa_oauth=${cookieValue(start, "sherpa_oauth")}` } },
    ),
    setup,
    { fetch: setup.fetch },
  );
  expect(callback.status).toBe(302);
  return `sherpa_setup=${cookieValue(callback, "sherpa_setup")}`;
}

describe("installation Gateway setup", () => {
  it("rejects a missing or mismatched OAuth state", async () => {
    const setup = env();
    const missing = await handleSetup(
      new Request("https://sherpa.example.workers.dev/setup/callback"),
      setup,
      { fetch: setup.fetch },
    );
    expect(missing.status).toBe(400);
    const start = await handleSetup(
      new Request("https://sherpa.example.workers.dev/setup"),
      setup,
      {
        fetch: setup.fetch,
      },
    );
    const mismatched = await handleSetup(
      new Request(
        "https://sherpa.example.workers.dev/setup/callback?code=oauth-code-1&state=deadbeefdeadbeef",
        {
          headers: { cookie: `sherpa_oauth=${cookieValue(start, "sherpa_oauth")}` },
        },
      ),
      setup,
      { fetch: setup.fetch },
    );
    expect(mismatched.status).toBe(400);
  });

  it("saves a Gateway for an accessible installation and never returns the token", async () => {
    const settings = memorySettings();
    const setup = env(settings);
    const cookie = await authorize(setup, "17");
    const form = await handleSetup(
      new Request("https://sherpa.example.workers.dev/setup?installation_id=17", {
        headers: { cookie },
      }),
      setup,
      { fetch: setup.fetch },
    );
    const html = await form.text();
    expect(form.status).toBe(200);
    expect(html).toContain("acme");
    expect(html).toContain("alice");
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
    expect(csrf).toBeTruthy();
    const saved = await handleSetup(
      new Request("https://sherpa.example.workers.dev/setup/gateway", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          installation_id: "17",
          csrf: csrf!,
          account_id: gateway.accountId,
          gateway_id: gateway.gatewayId,
          api_token: gateway.apiToken,
        }),
      }),
      setup,
      { fetch: setup.fetch },
    );
    const body = await saved.text();
    expect(body).toContain("Saved");
    expect(body).not.toContain(gateway.apiToken);
    expect(body).toContain(gateway.accountId);
    expect(JSON.stringify(await settings.getByName("17").status())).not.toContain(gateway.apiToken);
    expect(await settings.getByName("17").getGateway()).toEqual(gateway);
  });

  it("does not write another installation's Gateway from a spoofed id", async () => {
    const settings = memorySettings();
    const setup = env(settings);
    const cookie = await authorize(setup);
    const csrf = await signValue(secret, "csrf:9:99");
    const denied = await handleSetup(
      new Request("https://sherpa.example.workers.dev/setup/gateway", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          installation_id: "99",
          csrf,
          account_id: gateway.accountId,
          gateway_id: gateway.gatewayId,
          api_token: gateway.apiToken,
        }),
      }),
      setup,
      { fetch: setup.fetch },
    );
    expect(denied.status).toBe(403);
    expect(settings.stored.size).toBe(0);
  });

  it("ignores installation_id on a GitHub-initiated callback without signed state", async () => {
    const setup = env();
    const callback = await handleSetup(
      new Request(
        "https://sherpa.example.workers.dev/setup/callback?code=oauth-code-1&installation_id=99",
      ),
      setup,
      { fetch: setup.fetch },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/setup");
  });
});
