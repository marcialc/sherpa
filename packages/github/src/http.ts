export type Fetcher = typeof fetch;
export const GITHUB_API_VERSION = "2026-03-10";

export function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes - 3;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end)) + "…";
}

/** Error messages deliberately exclude request credentials and response bodies. */
export class GitHubError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
    public readonly ambiguous = false,
  ) {
    super(code);
    this.name = "GitHubError";
  }
}

export async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new GitHubError("GITHUB_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let output = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new GitHubError("GITHUB_RESPONSE_TOO_LARGE");
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class GitHubApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetcher = fetch,
  ) {
    if (!token || token.length > 16384 || /[\r\n]/.test(token))
      throw new GitHubError("INVALID_GITHUB_TOKEN");
  }

  async request(
    path: string,
    options: {
      method?: "GET" | "POST" | "PATCH";
      body?: unknown;
      maxBytes?: number;
      allow404?: boolean;
    } = {},
  ): Promise<{ data: unknown; hasNext: boolean } | null> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new GitHubError("INVALID_GITHUB_PATH");
    const method = options.method ?? "GET";
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body && new TextEncoder().encode(body).byteLength > 512000)
      throw new GitHubError("GITHUB_REQUEST_TOO_LARGE");
    // Workers rejects native fetch when called with this client as its receiver.
    const fetcher = this.fetcher;
    let response: Response;
    try {
      response = await fetcher(`https://api.github.com${path}`, {
        method,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": "Sherpa-GitHub-App",
        },
      });
    } catch {
      throw new GitHubError("GITHUB_NETWORK_ERROR", undefined, method === "POST");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404 && options.allow404) return null;
      throw new GitHubError(
        `GITHUB_HTTP_${response.status}`,
        response.status,
        method === "POST" && response.status >= 500,
      );
    }
    try {
      return {
        data: JSON.parse(await boundedText(response, options.maxBytes ?? 1048576)),
        hasNext: /rel="next"/.test(response.headers.get("link") ?? ""),
      };
    } catch {
      throw new GitHubError("INVALID_GITHUB_RESPONSE", response.status, method === "POST");
    }
  }
}
