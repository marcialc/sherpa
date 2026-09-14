import { z } from "zod";
import { boundedText, GitHubApi, GitHubError, type Fetcher } from "./http";

export type UserInstallation = { id: number; accountLogin: string; accountType: string };
const encoder = new TextEncoder();
const clientIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/);
const clientSecretSchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[\x21-\x7e]+$/);
const oauthCodeSchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[a-zA-Z0-9._-]+$/);
const redirectUriSchema = z
  .string()
  .url()
  .max(500)
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.hostname === "localhost") &&
      !url.username &&
      !url.password &&
      url.pathname === "/setup/callback"
    );
  });
const stateSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

export class GitHubUserOAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetcher: Fetcher;

  constructor(options: { clientId: string; clientSecret: string; fetch?: Fetcher }) {
    this.clientId = clientIdSchema.parse(options.clientId);
    this.clientSecret = clientSecretSchema.parse(options.clientSecret);
    this.fetcher = options.fetch ?? fetch;
  }

  authorizeUrl(input: { redirectUri: string; state: string }): string {
    const redirectUri = redirectUriSchema.parse(input.redirectUri);
    const state = stateSchema.parse(input.state);
    return `https://github.com/login/oauth/authorize?${new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      state,
    })}`;
  }

  async exchange(code: string, redirectUri: string): Promise<string> {
    const parsedCode = oauthCodeSchema.parse(code);
    const parsedRedirect = redirectUriSchema.parse(redirectUri);
    // Workers rejects native fetch when called with this client as its receiver.
    const fetcher = this.fetcher;
    let response: Response;
    try {
      response = await fetcher("https://github.com/login/oauth/access_token", {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code: parsedCode,
          redirect_uri: parsedRedirect,
        }),
      });
    } catch {
      throw new GitHubError("GITHUB_OAUTH_NETWORK_ERROR");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubError("GITHUB_OAUTH_EXCHANGE_FAILED", response.status);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await boundedText(response, 4096));
    } catch {
      throw new GitHubError("INVALID_GITHUB_OAUTH_RESPONSE");
    }
    const parsed = z
      .object({
        access_token: z
          .string()
          .min(1)
          .max(16384)
          .refine((value) => !/[\r\n]/.test(value)),
        token_type: z.string().optional(),
      })
      .safeParse(payload);
    if (!parsed.success) throw new GitHubError("GITHUB_OAUTH_DENIED");
    return parsed.data.access_token;
  }

  async identity(token: string): Promise<{ userId: number; login: string }> {
    const result = await new GitHubApi(token, this.fetcher).request("/user", { maxBytes: 65536 });
    const parsed = z
      .object({
        id: z.number().int().positive(),
        login: z
          .string()
          .min(1)
          .max(39)
          .regex(/^[A-Za-z0-9-]+$/),
      })
      .safeParse(result?.data);
    if (!parsed.success) throw new GitHubError("INVALID_GITHUB_USER");
    return { userId: parsed.data.id, login: parsed.data.login };
  }

  async installations(token: string, appId: number): Promise<UserInstallation[]> {
    if (!Number.isSafeInteger(appId) || appId <= 0) throw new GitHubError("INVALID_GITHUB_APP_ID");
    const api = new GitHubApi(token, this.fetcher);
    const found: UserInstallation[] = [];
    let page = 1;
    while (page <= 3) {
      const result = await api.request(`/user/installations?per_page=100&page=${page}`, {
        maxBytes: 1048576,
      });
      const parsed = z
        .object({
          installations: z
            .array(
              z.object({
                id: z.number().int().positive(),
                app_id: z.number().int().positive(),
                account: z.object({
                  login: z.string().min(1).max(39),
                  type: z.string().max(50),
                }),
              }),
            )
            .max(100),
        })
        .safeParse(result?.data);
      if (!parsed.success) throw new GitHubError("INVALID_GITHUB_INSTALLATIONS");
      for (const installation of parsed.data.installations) {
        if (installation.app_id !== appId) continue;
        found.push({
          id: installation.id,
          accountLogin: installation.account.login,
          accountType: installation.account.type,
        });
      }
      if (!result?.hasNext || parsed.data.installations.length < 100) break;
      page += 1;
    }
    return found;
  }
}

export function accessibleInstallation(
  installations: UserInstallation[],
  installationId: number,
): UserInstallation | undefined {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return undefined;
  return installations.find((installation) => installation.id === installationId);
}

export async function randomOAuthState(): Promise<string> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signValue(secret: string, value: string): Promise<string> {
  if (!secret || secret.length < 16 || secret.length > 256)
    throw new GitHubError("INVALID_SETUP_SECRET");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return `${value}.${base64url(new Uint8Array(signature))}`;
}

export async function verifySignedValue(secret: string, signed: string): Promise<string | null> {
  const split = signed.lastIndexOf(".");
  if (split < 1) return null;
  const value = signed.slice(0, split);
  const encoded = signed.slice(split + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 128) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      base64urlDecode(encoded),
      encoder.encode(value),
    );
    return ok ? value : null;
  } catch {
    return null;
  }
}

function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
