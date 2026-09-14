import {
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

export type SetupSettingsStub = {
  getGateway(): Promise<CloudflareGatewayConfig | null>;
  putGateway(config: CloudflareGatewayConfig): Promise<void>;
  status(): Promise<GatewayStatus>;
  clear(): Promise<void>;
};
export type SetupEnv = {
  GITHUB_APP_ID: string;
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
    return html('<h1>Setup unavailable</h1><p class="err">OAuth is not configured.</p>', 503);
  const url = new URL(request.url);
  const oauth = new GitHubUserOAuth({
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    fetch: deps.fetch,
  });
  const redirectUri = `${url.origin}/setup/callback`;
  const now = deps.now?.() ?? Date.now();
  if (url.pathname === "/setup" && request.method === "GET")
    return startOrShow(request, env, oauth, redirectUri, now);
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
): Promise<Response> {
  const url = new URL(request.url);
  const session = await readSession(env.SETUP_SESSION_SECRET, request, now);
  if (!session)
    return redirectToGithub(env, oauth, redirectUri, url.searchParams.get("installation_id"));
  try {
    const installations = await oauth.installations(session.token, Number(env.GITHUB_APP_ID));
    const selected = accessibleInstallation(
      installations,
      Number(url.searchParams.get("installation_id")),
    );
    if (!selected) return installationList(installations, session.login);
    const status = await env.INSTALLATION_SETTINGS.getByName(String(selected.id)).status();
    const csrf = await signValue(env.SETUP_SESSION_SECRET, `csrf:${session.userId}:${selected.id}`);
    return gatewayForm(selected, status, csrf, session.login);
  } catch {
    return html(
      '<h1>Setup failed</h1><p class="err">Could not list GitHub App installations.</p>',
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
    return html('<h1>Invalid form</h1><p class="err">CSRF token mismatch.</p>', 403);
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
      '<h1>Forbidden</h1><p class="err">That installation is not available to this user.</p>',
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
      "Removed the saved Gateway for this installation.",
    );
  }
  const parsed = gatewayConfigSchema.safeParse({
    accountId: fields.get("account_id"),
    gatewayId: fields.get("gateway_id"),
    apiToken: fields.get("api_token"),
  });
  if (!parsed.success)
    return gatewayForm(
      selected,
      await stub.status(),
      csrf,
      session.login,
      undefined,
      "Account ID, gateway name, or token is invalid.",
    );
  await stub.putGateway(parsed.data);
  log("setup.gateway_saved", { installationId: selected.id });
  return gatewayForm(
    selected,
    await stub.status(),
    csrf,
    session.login,
    "Saved. Open a nondraft code pull request to start reviews. Inference bills this Gateway.",
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

function installationList(installations: UserInstallation[], login: string): Response {
  if (!installations.length)
    return html(
      `<h1>No installations</h1><p>Signed in as <strong>${escapeHtml(login)}</strong>.</p><p>Install the GitHub App on a repository first, then return here.</p>`,
    );
  const items = installations
    .map(
      (installation) =>
        `<li><a href="/setup?installation_id=${installation.id}">${escapeHtml(installation.accountLogin)}</a> (${escapeHtml(installation.accountType)})</li>`,
    )
    .join("");
  return html(
    `<h1>Choose an installation</h1><p class="muted">Signed in as <strong>${escapeHtml(login)}</strong>. Pick the GitHub account or organization that installed Sherpa — never paste a token for an account you do not recognize.</p><ul>${items}</ul>`,
  );
}

function gatewayForm(
  installation: UserInstallation,
  status: GatewayStatus,
  csrf: string,
  login: string,
  message?: string,
  error?: string,
): Response {
  const configured = status.configured
    ? `<p class="ok">Gateway saved for <code>${escapeHtml(status.accountId ?? "")}</code> / <code>${escapeHtml(status.gatewayId ?? "")}</code>. The token is not shown.</p>`
    : `<p class="muted">No Gateway saved yet. Reviews on this installation will not call models until you save one.</p>`;
  return html(`
    <h1>Sherpa AI billing</h1>
    <p class="muted">Signed in as <strong>${escapeHtml(login)}</strong></p>
    <p>Installation: <strong>${escapeHtml(installation.accountLogin)}</strong></p>
    ${configured}
    ${message ? `<p class="ok">${escapeHtml(message)}</p>` : ""}
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    <p class="muted">Use your Cloudflare account ID, AI Gateway name, and a token with Account → Workers AI → Read. Unified Billing on that gateway pays for reviews of every repository on this installation.</p>
    <form method="post" action="/setup/gateway">
      <input type="hidden" name="installation_id" value="${installation.id}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <label>Cloudflare account ID</label>
      <input name="account_id" required maxlength="32" pattern="[a-fA-F0-9]{32}" value="${escapeHtml(status.accountId ?? "")}">
      <label>AI Gateway name</label>
      <input name="gateway_id" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]{0,63}" value="${escapeHtml(status.gatewayId ?? "")}">
      <label>API token</label>
      <input name="api_token" type="password" required maxlength="4096" autocomplete="off">
      <button type="submit">Save Gateway</button>
    </form>
    <form method="post" action="/setup/gateway" style="margin-top:1rem">
      <input type="hidden" name="installation_id" value="${installation.id}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="action" value="clear">
      <button type="submit">Remove saved Gateway</button>
    </form>
    <p class="muted"><a href="/setup">All installations</a></p>
  `);
}

function html(body: string, status = 200, extraCookies: string[] = []): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  for (const value of extraCookies) headers.append("set-cookie", value);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sherpa setup</title><style>
      body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#111;line-height:1.45}
      input{width:100%;padding:.4rem;margin:.2rem 0 .8rem;box-sizing:border-box}
      button{padding:.45rem .8rem}
      .muted{color:#555}
      .ok{color:#05620a}
      .err{color:#9b1c1c}
    </style></head><body>${body}</body></html>`,
    { status, headers },
  );
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
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
