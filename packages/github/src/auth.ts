import { reviewJobSchema, type ReviewJob } from "@sherpa/schemas";
import { z } from "zod";
import { GitHubApi, GitHubError, type Fetcher } from "./http";
import { repositorySchema } from "./webhook";
import { repositoryIdentitySchema, type RepositoryIdentity } from "./repository";

export type AppIdentity = { appId: number; botLogin: string };
const encoder = new TextEncoder();
function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function der(tag: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = data.length;
  const size: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) size.unshift(n & 255);
  return new Uint8Array([
    tag,
    ...(length < 128 ? [length] : [0x80 | size.length, ...size]),
    ...data,
  ]);
}

/** GitHub downloads PKCS#1 PEM; WebCrypto accepts PKCS#8. Wrap DER, never parse secret integers. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, "\n").trim();
  const match =
    /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s+([a-zA-Z0-9+/=\s]+)\s+-----END \1-----$/.exec(
      normalized,
    );
  if (!match || normalized.length > 20000) throw new GitHubError("INVALID_GITHUB_PRIVATE_KEY");
  try {
    let bytes = Uint8Array.from(atob(match[2]!.replace(/\s/g, "")), (c) => c.charCodeAt(0));
    if (match[1] === "RSA PRIVATE KEY") {
      const rsaAlgorithm = [
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
      ];
      bytes = der(0x30, new Uint8Array([0x02, 0x01, 0x00, ...rsaAlgorithm, ...der(0x04, bytes)]));
    }
    return await crypto.subtle.importKey(
      "pkcs8",
      bytes as Uint8Array<ArrayBuffer>,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new GitHubError("INVALID_GITHUB_PRIVATE_KEY");
  }
}

export class GitHubApp {
  private readonly appId: number;
  private readonly pem: string;
  private readonly fetcher: Fetcher;
  private key?: Promise<CryptoKey>;
  private identity?: AppIdentity;

  constructor(options: { appId: string | number; privateKey: string; fetch?: Fetcher }) {
    const id = Number(options.appId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new GitHubError("INVALID_GITHUB_APP_ID");
    this.appId = id;
    this.pem = options.privateKey;
    this.fetcher = options.fetch ?? fetch;
  }

  private async api(): Promise<GitHubApi> {
    this.key ??= importPrivateKey(this.pem);
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const payload = base64url(
      encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(this.appId) })),
    );
    const signed = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      await this.key,
      encoder.encode(signed),
    );
    return new GitHubApi(`${signed}.${base64url(new Uint8Array(signature))}`, this.fetcher);
  }

  async getIdentity(): Promise<AppIdentity> {
    if (this.identity) return { ...this.identity };
    const result = await (await this.api()).request("/app", { maxBytes: 131072 });
    const parsed = z
      .object({ id: z.literal(this.appId), slug: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/) })
      .safeParse(result?.data);
    if (!parsed.success) throw new GitHubError("GITHUB_APP_IDENTITY_MISMATCH");
    this.identity = { appId: this.appId, botLogin: `${parsed.data.slug}[bot]` };
    return { ...this.identity };
  }

  async installationToken(
    input: ReviewJob,
    permissions: "read" | "write" | "checks" = "read",
  ): Promise<string> {
    return this.installationRepositoryToken(reviewJobSchema.parse(input), permissions);
  }

  async installationRepositoryToken(
    input: RepositoryIdentity,
    permissions: "read" | "write" | "checks" = "read",
  ): Promise<string> {
    const job = repositoryIdentitySchema.parse(input);
    const api = await this.api();
    const installation = await api.request(`/repos/${job.owner}/${job.repo}/installation`, {
      maxBytes: 131072,
    });
    const matched = z
      .object({
        id: z.literal(job.installationId),
        app_id: z.literal(this.appId),
        suspended_at: z.null().optional(),
      })
      .safeParse(installation?.data);
    if (!matched.success) throw new GitHubError("GITHUB_INSTALLATION_SCOPE_MISMATCH");
    const response = await api.request(`/app/installations/${job.installationId}/access_tokens`, {
      method: "POST",
      maxBytes: 131072,
      body: {
        repository_ids: [job.repositoryId],
        permissions:
          permissions === "checks"
            ? { metadata: "read", checks: "write" }
            : { metadata: "read", contents: "read", pull_requests: permissions },
      },
    });
    const parsed = z
      .object({
        token: z
          .string()
          .min(1)
          .max(16384)
          .refine((v) => !/[\r\n]/.test(v)),
        expires_at: z.iso.datetime(),
        permissions:
          permissions === "checks"
            ? z
                .object({ metadata: z.literal("read").optional(), checks: z.literal("write") })
                .strict()
            : z
                .object({
                  metadata: z.literal("read").optional(),
                  contents: z.literal("read"),
                  pull_requests: z.literal(permissions),
                })
                .strict(),
        repositories: z.array(repositorySchema).max(1).optional(),
      })
      .safeParse(response?.data);
    if (!parsed.success || Date.parse(parsed.data.expires_at) <= Date.now() + 30000)
      throw new GitHubError("INVALID_GITHUB_INSTALLATION_TOKEN");
    const repos = parsed.data.repositories;
    if (
      repos &&
      (repos.length !== 1 ||
        repos[0]!.id !== job.repositoryId ||
        repos[0]!.name.toLowerCase() !== job.repo.toLowerCase() ||
        repos[0]!.owner.login.toLowerCase() !== job.owner.toLowerCase())
    )
      throw new GitHubError("GITHUB_TOKEN_SCOPE_MISMATCH");
    return parsed.data.token;
  }
}
