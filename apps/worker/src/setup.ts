import {
  GitHubApp,
  GitHubUserOAuth,
  accessibleInstallation,
  randomOAuthState,
  signValue,
  verifySignedValue,
  type Fetcher,
  type UserInstallation,
} from "@sherpa/github";
import { gatewayConfigSchema, type CloudflareGatewayConfig } from "@sherpa/models";
import { log, readBoundedText } from "@sherpa/shared";
import { z } from "zod";
import type { GatewayStatus } from "./billing";
import { gatewayForm, html, installationList, type GatewayFormErrors } from "./setup-page";

export type SetupSettingsStub = {
  getGateway(): Promise<CloudflareGatewayConfig | null>;
  putGateway(config: CloudflareGatewayConfig): Promise<void>;
  status(): Promise<GatewayStatus>;
  clear(): Promise<void>;
};
export type SetupEnv = {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SETUP_SESSION_SECRET: string;
  INSTALLATION_SETTINGS: { getByName(id: string): SetupSettingsStub };
};
const SESSION_MAX_AGE = 3600;
const STATE_MAX_AGE = 600;

export async function handleSetup(
  request: Request,
  env: SetupEnv,
  deps: { fetch?: Fetcher; now?: () => number } = {},
): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SETUP_SESSION_SECRET)
    return html(
      '<h1>Setup is not available yet.</h1><p class="err">The host still needs to enable GitHub sign-in for Sherpa.</p>',
      503,
    );
  const url = new URL(request.url);
  const oauth = new GitHubUserOAuth({
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    fetch: deps.fetch,
  });
  const redirectUri = `${url.origin}/setup/callback`;
  const now = deps.now?.() ?? Date.now();
  if (url.pathname === "/setup" && request.method === "GET")
    return startOrShow(request, env, oauth, redirectUri, now, deps.fetch);
  if (url.pathname === "/setup/callback" && request.method === "GET")
    return callback(request, env, oauth, redirectUri, now);
  if (url.pathname === "/setup/gateway" && request.method === "POST")
    return saveGateway(request, env, oauth, now);
  return new Response("Not found", { status: 404 });
}

async function startOrShow(
  request: Request,
  env: SetupEnv,
  oauth: GitHubUserOAuth,
  redirectUri: string,
  now: number,
  fetcher?: Fetcher,
): Promise<Response> {
  const url = new URL(request.url);
  const session = await readSession(env.SETUP_SESSION_SECRET, request, now);
  if (!session || url.searchParams.get("sign_in") === "1")
    return redirectToGithub(env, oauth, redirectUri, url.searchParams.get("installation_id"));
  try {
    const installations = await oauth.installations(session.token, Number(env.GITHUB_APP_ID));
    const selected = accessibleInstallation(
      installations,
      Number(url.searchParams.get("installation_id")),
    );
    if (!selected) {
      let installUrl: string | undefined;
      if (env.GITHUB_PRIVATE_KEY) {
        try {
          const identity = await new GitHubApp({
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_PRIVATE_KEY,
            fetch: fetcher,
          }).getIdentity();
          installUrl = `https://github.com/apps/${identity.botLogin.slice(0, -5)}/installations/new`;
        } catch {
          // Account selection remains available if app metadata is temporarily unavailable.
        }
      }
      return installationList(installations, session.login, installUrl);
    }
    const status = await env.INSTALLATION_SETTINGS.getByName(String(selected.id)).status();
    const csrf = await signValue(env.SETUP_SESSION_SECRET, `csrf:${session.userId}:${selected.id}`);
    return gatewayForm(selected, status, csrf, session.login);
  } catch {
    return html(
      '<h1>Setup failed</h1><p class="err">We couldn’t load your GitHub accounts. Sign in again to retry.</p>',
      502,
      [clearCookie("sherpa_setup")],
    );
  }
}

async function redirectToGithub(
  env: SetupEnv,
  oauth: GitHubUserOAuth,
  redirectUri: string,
  installationId: string | null,
): Promise<Response> {
  const stateNonce = await randomOAuthState();
  const state = await signValue(
    env.SETUP_SESSION_SECRET,
    JSON.stringify({
      n: stateNonce,
      i: installationId && /^\d{1,20}$/.test(installationId) ? installationId : undefined,
    }),
  );
  return new Response(null, {
    status: 302,
    headers: {
      location: oauth.authorizeUrl({ redirectUri, state: stateNonce }),
      "set-cookie": cookie("sherpa_oauth", state, STATE_MAX_AGE),
    },
  });
}

async function callback(
  request: Request,
  env: SetupEnv,
  oauth: GitHubUserOAuth,
  redirectUri: string,
  now: number,
): Promise<Response> {
  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get("cookie"));
  const signedState = cookies.sherpa_oauth;
  const returned = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  let trustedInstallationId: string | undefined;
  if (signedState && returned) {
    const payload = await verifySignedValue(env.SETUP_SESSION_SECRET, signedState);
    if (!payload)
      return html('<h1>Authorization failed</h1><p class="err">Invalid OAuth state.</p>', 400, [
        clearCookie("sherpa_oauth"),
      ]);
    let parsedState: { n?: string; i?: string };
    try {
      parsedState = JSON.parse(payload) as { n?: string; i?: string };
    } catch {
      return html('<h1>Authorization failed</h1><p class="err">Invalid OAuth state.</p>', 400, [
        clearCookie("sherpa_oauth"),
      ]);
    }
    if (parsedState.n !== returned)
      return html('<h1>Authorization failed</h1><p class="err">OAuth state mismatch.</p>', 400, [
        clearCookie("sherpa_oauth"),
      ]);
    trustedInstallationId = parsedState.i;
  } else if (!code) {
    return html('<h1>Authorization failed</h1><p class="err">Missing OAuth state.</p>', 400, [
      clearCookie("sherpa_oauth"),
    ]);
  }
  if (!code)
    return html(
      '<h1>Authorization failed</h1><p class="err">GitHub did not return a code.</p>',
      400,
      [clearCookie("sherpa_oauth")],
    );
  try {
    const token = await oauth.exchange(code, redirectUri);
    const identity = await oauth.identity(token);
    const session = await signValue(
      env.SETUP_SESSION_SECRET,
      JSON.stringify({
        u: identity.userId,
        l: identity.login,
        t: token,
        e: now + SESSION_MAX_AGE * 1000,
      }),
    );
    const location =
      trustedInstallationId && /^\d{1,20}$/.test(trustedInstallationId)
        ? `/setup?installation_id=${trustedInstallationId}`
        : "/setup";
    const headers = new Headers({ location });
    headers.append("set-cookie", cookie("sherpa_setup", session, SESSION_MAX_AGE));
    headers.append("set-cookie", clearCookie("sherpa_oauth"));
    return new Response(null, { status: 302, headers });
  } catch {
    log("setup.oauth_failed", { code: "GITHUB_OAUTH_FAILED" });
    return html(
      '<h1>Authorization failed</h1><p class="err">Could not complete GitHub sign-in.</p>',
      502,
      [clearCookie("sherpa_oauth")],
    );
  }
}

async function saveGateway(
  request: Request,
  env: SetupEnv,
  oauth: GitHubUserOAuth,
  now: number,
): Promise<Response> {
  const session = await readSession(env.SETUP_SESSION_SECRET, request, now);
  if (!session)
    return html('<h1>Sign in required</h1><p><a href="/setup">Authorize with GitHub</a></p>', 401);
  let fields: URLSearchParams;
  try {
    fields = new URLSearchParams(await readBoundedText(request.body, 8192));
  } catch {
    return html('<h1>Invalid form</h1><p class="err">The form was missing or too large.</p>', 413);
  }
  const installationId = Number(fields.get("installation_id"));
  const csrf = fields.get("csrf") ?? "";
  const expectedCsrf = await signValue(
    env.SETUP_SESSION_SECRET,
    `csrf:${session.userId}:${installationId}`,
  );
  if (!(await sameSignature(csrf, expectedCsrf)))
    return html(
      '<h1>Invalid form</h1><p class="err">This form has expired. Return to setup and try saving again.</p>',
      403,
    );
  let installations: UserInstallation[];
  try {
    installations = await oauth.installations(session.token, Number(env.GITHUB_APP_ID));
  } catch {
    return html(
      '<h1>Setup failed</h1><p class="err">Could not verify the GitHub installation.</p>',
      502,
    );
  }
  const selected = accessibleInstallation(installations, installationId);
  if (!selected)
    return html(
      '<h1>Forbidden</h1><p class="err">You don’t have access to this GitHub account. Return to setup and choose one of your available accounts.</p>',
      403,
    );
  const stub = env.INSTALLATION_SETTINGS.getByName(String(selected.id));
  if (fields.get("action") === "clear") {
    await stub.clear();
    log("setup.gateway_cleared", { installationId: selected.id });
    return gatewayForm(
      selected,
      { configured: false },
      csrf,
      session.login,
      "Gateway removed. Save a gateway below to resume reviews for this account.",
    );
  }
  const values = {
    accountId: (fields.get("account_id") ?? "").trim(),
    gatewayId: (fields.get("gateway_id") ?? "").trim(),
  };
  const parsed = gatewayConfigSchema.safeParse({
    ...values,
    apiToken: (fields.get("api_token") ?? "").trim(),
  });
  if (!parsed.success) {
    const errors: GatewayFormErrors = {};
    for (const issue of parsed.error.issues) {
      if (issue.path[0] === "accountId")
        errors.accountId =
          "Paste the 32-character account ID from Cloudflare (letters a–f and numbers).";
      if (issue.path[0] === "gatewayId")
        errors.gatewayId =
          "Use the gateway name: up to 64 lowercase letters, numbers, hyphens, or underscores, starting with a letter or number.";
      if (issue.path[0] === "apiToken")
        errors.apiToken =
          "Paste a valid Cloudflare API token with Account → Workers AI → Read permission.";
    }
    return gatewayForm(
      selected,
      await stub.status(),
      csrf,
      session.login,
      undefined,
      errors,
      values,
    );
  }
  await stub.putGateway(parsed.data);
  log("setup.gateway_saved", { installationId: selected.id });
  return gatewayForm(
    selected,
    await stub.status(),
    csrf,
    session.login,
    "Saved. Follow the steps below to start a review in GitHub.",
  );
}

const sessionSchema = z.object({
  u: z.number().int().positive(),
  l: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[A-Za-z0-9-]+$/),
  t: z
    .string()
    .min(1)
    .max(16384)
    .refine((value) => !/[\r\n]/.test(value)),
  e: z.number().int().positive(),
});
type Session = { userId: number; login: string; token: string };

async function readSession(secret: string, request: Request, now: number): Promise<Session | null> {
  const signed = parseCookies(request.headers.get("cookie")).sherpa_setup;
  if (!signed) return null;
  const value = await verifySignedValue(secret, signed);
  if (!value) return null;
  try {
    const session = sessionSchema.parse(JSON.parse(value));
    if (session.e <= now) return null;
    return { userId: session.u, login: session.l, token: session.t };
  } catch {
    return null;
  }
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/setup; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function clearCookie(name: string): string {
  return `${name}=; Path=/setup; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const split = part.indexOf("=");
    if (split < 1) continue;
    const name = part.slice(0, split).trim();
    const value = part.slice(split + 1).trim();
    if (name && value.length <= 8192) out[name] = value;
  }
  return out;
}
async function sameSignature(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < a.byteLength; index++) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}
