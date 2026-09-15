import { reviewJobSchema, type ReviewJob } from "@sherpa/schemas";

export type OutboundPolicy = {
  job: ReviewJob;
  phase: "git" | "packages" | "closed";
  expiresAt: number;
};
export type GitTokenProvider = (job: ReviewJob) => Promise<string>;
const REGISTRIES = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);
const denied = () => new Response("Outbound request denied", { status: 403 });

/** Trusted ContainerProxy params only. Never take policy or credentials from request headers/body. */
export async function handleReviewOutbound(
  request: Request,
  policy: unknown,
  token: GitTokenProvider,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (
    !policy ||
    typeof policy !== "object" ||
    !("job" in policy) ||
    !("phase" in policy) ||
    !("expiresAt" in policy) ||
    typeof policy.expiresAt !== "number" ||
    policy.expiresAt <= Date.now()
  )
    return denied();
  const parsed = reviewJobSchema.safeParse(policy.job);
  if (!parsed.success) return denied();
  const job = parsed.data;
  const url = new URL(request.url);
  const internalGitHttp = policy.phase === "git" && url.protocol === "http:";
  if (
    (!internalGitHttp && url.protocol !== "https:") ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    return denied();
  const headers = new Headers();
  if (policy.phase === "git") {
    const root = `/${job.owner}/${job.repo}.git`;
    const authorized =
      url.hostname === "github.com" &&
      ((request.method === "GET" &&
        url.pathname === `${root}/info/refs` &&
        url.search === "?service=git-upload-pack") ||
        (request.method === "POST" &&
          url.pathname === `${root}/git-upload-pack` &&
          !url.search &&
          request.headers.get("content-type") === "application/x-git-upload-pack-request"));
    if (!authorized) return denied();
    headers.set("Authorization", `Basic ${btoa(`x-access-token:${await token(job)}`)}`);
    headers.set("User-Agent", "Sherpa-Git-Reviewer");
    if (request.method === "POST")
      headers.set("Content-Type", "application/x-git-upload-pack-request");
    const protocol = request.headers.get("Git-Protocol");
    if (protocol === "version=2") headers.set("Git-Protocol", protocol);
  } else if (policy.phase === "packages") {
    const authorized =
      REGISTRIES.has(url.hostname) &&
      (request.method === "GET" || request.method === "HEAD") &&
      !url.search &&
      url.pathname.length <= 2048;
    if (!authorized) return denied();
    headers.set("Accept", "application/json, application/octet-stream");
  } else return denied();
  // Redirects never carry authentication or bypass host/path authorization.
  // Plain HTTP is confined to the ContainerProxy hop; never forward it to the public network.
  url.protocol = "https:";
  const response = await fetcher(
    new Request(new Request(url, request), {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    }),
  );
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return denied();
  }
  const responseHeaders = new Headers(response.headers);
  for (const name of ["set-cookie", "www-authenticate", "authorization", "location"])
    responseHeaders.delete(name);
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}
