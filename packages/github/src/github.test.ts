import { createHmac, createPrivateKey, generateKeyPairSync, verify } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  calculateOutcome,
  type ChangedFile,
  type Finding,
  type ReviewJob,
  type ReviewResult,
} from "@sherpa/schemas";
import {
  GitHubApp,
  GitHubClient,
  GitHubError,
  findingFingerprint,
  findingMarker,
  formatFinding,
  formatSummary,
  trustedSetupOrigin,
  mapFindingToComment,
  parsePatch,
  parseWebhook,
  reviewMarker,
  verifyWebhookSignature,
  type Fetcher,
} from "./index";
import { boundedText, GitHubApi } from "./http";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const repo = { id: 42, name: "example", owner: { login: "acme" } };
const payload = {
  action: "opened",
  number: 8,
  installation: { id: 17 },
  repository: repo,
  pull_request: { number: 8, state: "open", base: { sha: baseSha, repo }, head: { sha: headSha } },
};
const identity = { appId: 123, botLogin: "sherpa-test[bot]" };
const file: ChangedFile = {
  path: "src/auth.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  patch:
    "@@ -1,2 +1,3 @@\n const session = load(id);\n-authorize(session);\n+deleteSession(session);\n+return success();",
};
const finding: Finding = {
  id: "one",
  title: "Session deletion lacks ownership check",
  description: "Another user's session can be deleted with its ID.",
  path: file.path,
  line: 2,
  severity: "high",
  priority: "must_fix",
  category: "security",
  confidence: 0.95,
  evidence: ["deleteSession(session) executes without authorizing the owner."],
  suggestedFix: "Compare the session owner to the authenticated user before deleting.",
  originatingAgent: "security",
  relatedSymbols: ["deleteSession"],
};
const result: ReviewResult = {
  outcome: "NEEDS_ATTENTION",
  findings: [finding],
  reviewedHeadSha: headSha,
  incrementalBaseSha: baseSha,
  coverageComplete: true,
  warnings: [],
  risk: { score: 80, reasons: ["auth"], agents: ["security"], skip: false },
  cost: { totalEstimatedUsd: 0.02, calls: [], unpricedCalls: 0 },
};
let job: ReviewJob;
let privateKey: string;
let publicKey: string;
beforeAll(async () => {
  job = (await parseWebhook("pull_request", "delivery-1", payload))!;
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  privateKey = keys.privateKey;
  publicKey = keys.publicKey;
});

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers });
}
function pr(extra: Record<string, unknown> = {}) {
  return {
    ...payload.pull_request,
    title: "Fix session handling",
    body: null,
    draft: false,
    changed_files: 1,
    ...extra,
  };
}
function review(extra: Record<string, unknown> = {}) {
  return {
    id: 91,
    body: reviewMarker(job),
    commit_id: headSha,
    state: "COMMENTED",
    user: { login: identity.botLogin, type: "Bot" },
    ...extra,
  };
}
function apiMock(
  options: {
    reviews?: unknown[];
    pr?: () => unknown;
    post?: () => Response | Promise<Response>;
    files?: unknown[];
  } = {},
): ReturnType<typeof vi.fn<Fetcher>> {
  return vi.fn<Fetcher>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/reviews") && init?.method === "POST")
      return options.post ? options.post() : json({ id: 91 });
    if (url.pathname.endsWith("/reviews")) return json(options.reviews ?? []);
    if (url.pathname.endsWith("/files"))
      return json(
        options.files ?? [
          {
            filename: file.path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            patch: file.patch,
          },
        ],
      );
    if (url.pathname.endsWith("/pulls/8")) return json(options.pr ? options.pr() : pr());
    throw new Error("UNEXPECTED_TEST_REQUEST");
  });
}

describe("authenticated webhook handling", () => {
  it("verifies GitHub's published HMAC test vector and rejects tampering", async () => {
    const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(
      await verifyWebhookSignature("It's a Secret to Everybody", "Hello, World!", signature),
    ).toBe(true);
    expect(
      await verifyWebhookSignature("It's a Secret to Everybody", "Hello, World?", signature),
    ).toBe(false);
    expect(await verifyWebhookSignature("", "Hello, World!", signature)).toBe(false);
    expect(await verifyWebhookSignature("secret", "body", null)).toBe(false);
    expect(await verifyWebhookSignature("secret", "body", "sha256=not-hex")).toBe(false);
  });

  it("handles UTF-8 bytes, and deduplicates deliveries/actions for identical immutable commits", async () => {
    const body = JSON.stringify({ ...payload, unicode: "λ 🏔️" });
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(await verifyWebhookSignature("secret", body, signature)).toBe(true);
    const repeated = await parseWebhook("pull_request", "delivery-2", {
      ...payload,
      action: "synchronize",
    });
    expect(repeated?.reviewId).toBe(job.reviewId);
    const anotherInstallation = await parseWebhook("pull_request", "delivery-2", {
      ...payload,
      installation: { id: 18 },
    });
    expect(anotherInstallation?.reviewId).not.toBe(job.reviewId);
    const anotherBase = await parseWebhook("pull_request", "delivery-2", {
      ...payload,
      pull_request: { ...payload.pull_request, base: { sha: "c".repeat(40), repo } },
    });
    expect(anotherBase?.reviewId).not.toBe(job.reviewId);
  });

  it("filters irrelevant events/actions and validates selected event payloads", async () => {
    expect(await parseWebhook("ping", null, null)).toBeNull();
    expect(await parseWebhook("pull_request", null, { action: "closed" })).toBeNull();
    await expect(parseWebhook("pull_request", "id", {})).rejects.toThrow("INVALID_WEBHOOK_PAYLOAD");
    await expect(parseWebhook("pull_request", null, payload)).rejects.toThrow(
      "INVALID_WEBHOOK_DELIVERY",
    );
    await expect(
      parseWebhook("pull_request", "id", { ...payload, installation: undefined }),
    ).rejects.toThrow("INVALID_WEBHOOK_PAYLOAD");
    await expect(
      parseWebhook("pull_request", "id", { ...payload, repository: { ...repo, id: 7 } }),
    ).rejects.toThrow("WEBHOOK_REPOSITORY_MISMATCH");
    await expect(parseWebhook("pull_request", "id", { ...payload, number: 7 })).rejects.toThrow(
      "WEBHOOK_REPOSITORY_MISMATCH",
    );
    expect(
      (await parseWebhook("pull_request", "id", { ...payload, action: "reopened" }))?.action,
    ).toBe("reopened");
    expect(await parseWebhook("check_run", "id", { action: "completed" })).toBeNull();
    expect(await parseWebhook("check_suite", "id", { action: "requested" })).toBeNull();
  });

  it("starts a distinct review when GitHub re-runs the Sherpa check", async () => {
    const associated = {
      number: 8,
      head: { sha: headSha, repo: { id: repo.id, name: repo.name } },
      base: { sha: baseSha, repo: { id: repo.id, name: repo.name } },
    };
    const checkRun = {
      action: "rerequested",
      installation: payload.installation,
      repository: repo,
      check_run: {
        name: "Sherpa",
        head_sha: headSha,
        external_id: job.reviewId,
        pull_requests: [associated],
      },
    };
    const rerun = await parseWebhook("check_run", "rerun-1", checkRun);
    expect(rerun).toMatchObject({
      action: "rerequested",
      installationId: 17,
      repositoryId: 42,
      owner: "acme",
      repo: "example",
      number: 8,
      baseSha,
      headSha,
    });
    expect(rerun?.reviewId).not.toBe(job.reviewId);
    expect((await parseWebhook("check_run", "rerun-1", checkRun))?.reviewId).toBe(rerun?.reviewId);
    expect((await parseWebhook("check_run", "rerun-2", checkRun))?.reviewId).not.toBe(
      rerun?.reviewId,
    );
    expect(
      await parseWebhook("check_run", "rerun-1", {
        ...checkRun,
        check_run: { ...checkRun.check_run, pull_requests: [] },
      }),
    ).toBeNull();
    const suite = await parseWebhook("check_suite", "rerun-suite", {
      action: "rerequested",
      installation: payload.installation,
      repository: repo,
      check_suite: { head_sha: headSha, pull_requests: [associated] },
    });
    expect(suite).toMatchObject({ action: "rerequested", number: 8, headSha });
    expect(suite?.reviewId).not.toBe(job.reviewId);
    await expect(
      parseWebhook("check_run", "rerun-1", {
        ...checkRun,
        check_run: { ...checkRun.check_run, name: "Other" },
      }),
    ).rejects.toThrow("INVALID_WEBHOOK_PAYLOAD");
  });
});

describe("GitHub App authentication", () => {
  it("also accepts PKCS#8 PEM used by standard secret provisioning tools", async () => {
    const pkcs8 = createPrivateKey(privateKey).export({ format: "pem", type: "pkcs8" }).toString();
    const app = new GitHubApp({
      appId: 123,
      privateKey: pkcs8,
      fetch: async () => json({ id: 123, slug: "sherpa-test" }),
    });
    expect(await app.getIdentity()).toEqual(identity);
  });
  it("signs a valid RS256 JWT from GitHub PKCS#1 PEM and requests only the selected repository", async () => {
    const mocked = vi.fn<Fetcher>(async (input, init) => {
      const jwt = new Headers(init?.headers).get("authorization")!.slice(7);
      const [header, claims, signature] = jwt.split(".");
      expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({
        alg: "RS256",
      });
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${claims}`),
          publicKey,
          Buffer.from(signature!, "base64url"),
        ),
      ).toBe(true);
      const decoded = JSON.parse(Buffer.from(claims!, "base64url").toString()) as {
        iss: string;
        iat: number;
        exp: number;
      };
      expect(decoded.iss).toBe("123");
      expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(600);
      expect(init?.redirect).toBe("manual");
      if (String(input).endsWith("/installation"))
        return json({ id: 17, app_id: 123, suspended_at: null });
      if (String(input).endsWith("/access_tokens")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          repository_ids: [42],
          permissions: { metadata: "read", contents: "read", pull_requests: "read" },
        });
        return json(
          {
            token: "ghs_token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions: { metadata: "read", contents: "read", pull_requests: "read" },
            repositories: [repo],
          },
          201,
        );
      }
      if (String(input).endsWith("/app")) return json({ id: 123, slug: "sherpa-test" });
      throw new Error("UNEXPECTED_TEST_REQUEST");
    });
    const app = new GitHubApp({ appId: "123", privateKey, fetch: mocked });
    expect(await app.installationToken(job)).toBe("ghs_token");
    expect(await app.getIdentity()).toEqual(identity);
    expect(await app.getIdentity()).toEqual(identity);
    expect(mocked).toHaveBeenCalledTimes(3);
  });

  it("issues index tokens from repository identity with the same installation and repository isolation", async () => {
    const mocked = vi.fn<Fetcher>(async (input, init) => {
      if (String(input).endsWith("/installation")) return json({ id: 17, app_id: 123 });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        permissions: { contents: "read", pull_requests: "read" },
      });
      return json({
        token: "index-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: { contents: "read", pull_requests: "read" },
        repositories: [repo],
      });
    });
    const scope = { installationId: 17, repositoryId: 42, owner: "acme", repo: "example" };
    const app = new GitHubApp({ appId: 123, privateKey, fetch: mocked });
    expect(await app.installationRepositoryToken(scope)).toBe("index-token");
    await expect(
      app.installationRepositoryToken({ ...scope, installationId: 999 }),
    ).rejects.toThrow("GITHUB_INSTALLATION_SCOPE_MISMATCH");
    await expect(app.installationRepositoryToken({ ...scope, repositoryId: 999 })).rejects.toThrow(
      "GITHUB_TOKEN_SCOPE_MISMATCH",
    );
  });

  it("rejects mismatched installations before token creation and hides key failures", async () => {
    const mocked = vi.fn<Fetcher>(async () => json({ id: 99, app_id: 123 }));
    await expect(
      new GitHubApp({ appId: 123, privateKey, fetch: mocked }).installationToken(job),
    ).rejects.toThrow("GITHUB_INSTALLATION_SCOPE_MISMATCH");
    expect(mocked).toHaveBeenCalledTimes(1);
    await expect(
      new GitHubApp({ appId: 123, privateKey: "secret-private-key", fetch: mocked }).getIdentity(),
    ).rejects.toThrow("INVALID_GITHUB_PRIVATE_KEY");
  });

  it("rejects broader token permissions or returned repository scope", async () => {
    for (const tokenResponse of [
      {
        permissions: { contents: "read", pull_requests: "read", administration: "write" },
        repositories: [repo],
      },
      {
        permissions: { contents: "read", pull_requests: "read" },
        repositories: [{ ...repo, id: 999 }],
      },
    ]) {
      const mocked: Fetcher = async (input) =>
        String(input).endsWith("/installation")
          ? json({ id: 17, app_id: 123 })
          : json({
              token: "secret",
              expires_at: new Date(Date.now() + 3600000).toISOString(),
              ...tokenResponse,
            });
      await expect(
        new GitHubApp({ appId: 123, privateKey, fetch: mocked }).installationToken(job),
      ).rejects.toThrow(/TOKEN/);
    }
  });
});

describe("changed-line mapping", () => {
  it("maps added HEAD lines and surviving deletion context in complete hunks", () => {
    expect(mapFindingToComment(finding, [file], "body")).toEqual({
      path: file.path,
      line: 2,
      side: "RIGHT",
      body: "body",
    });
    expect(
      mapFindingToComment({ ...finding, startLine: 1, line: 3 }, [file], "body"),
    ).toMatchObject({ start_line: 1, start_side: "RIGHT", line: 3 });
    expect(mapFindingToComment({ ...finding, line: 1 }, [file], "body")).toMatchObject({
      line: 1,
      side: "RIGHT",
    });
    expect(mapFindingToComment(finding, [{ ...file, status: "removed" }], "body")).toBeNull();
    expect(mapFindingToComment(finding, [{ ...file, patch: undefined }], "body")).toBeNull();
  });

  it("maps deletion-only regressions to surviving RIGHT context without crossing hunks", () => {
    const deletion = {
      ...file,
      additions: 0,
      deletions: 1,
      patch:
        "@@ -1,3 +1,2 @@\n function debit() {\n-  authorize();\n   withdraw();\n@@ -20 +19,2 @@\n unrelated();\n+newOperation();",
    };
    expect(mapFindingToComment({ ...finding, line: 2 }, [deletion], "body")).toMatchObject({
      line: 2,
      side: "RIGHT",
    });
    expect(mapFindingToComment({ ...finding, line: 19 }, [deletion], "body")).toBeNull();
    expect(
      mapFindingToComment({ ...finding, line: 20, startLine: 2 }, [deletion], "body"),
    ).toBeNull();
  });

  it("rejects truncated, overlapping, oversized or malformed diff hunks", () => {
    for (const patch of [
      "@@ -1 +1,2 @@\n-old\n+new",
      "@@ -1 +1 @@\n-old\n+new\n@@ -1 +1 @@\n-old\n+new",
      "@@ -1 +1 @@\nwat",
      "+".repeat(65537),
      "@@ -NaN +1 @@\n+bad",
    ])
      expect(parsePatch(patch)).toBeNull();
    expect(parsePatch("@@ -0,0 +1 @@\n+new\n\\ No newline at end of file")?.additions.has(1)).toBe(
      true,
    );
    expect(
      mapFindingToComment(
        { ...finding, startLine: 1, line: 5 },
        [{ ...file, patch: "@@ -1 +1 @@\n-a\n+b\n@@ -5 +5 @@\n-c\n+d" }],
        "body",
      ),
    ).toBeNull();
  });

  it("keeps fingerprints stable across shifted lines and agent duplication", async () => {
    expect(await findingFingerprint(finding)).toBe(
      await findingFingerprint({
        ...finding,
        id: "other",
        line: 99,
        originatingAgent: "correctness",
      }),
    );
    expect(await findingFingerprint(finding)).not.toBe(
      await findingFingerprint({ ...finding, evidence: ["A different execution path."] }),
    );
  });
});

describe("bounded GitHub context and trusted policy", () => {
  it("caps serialized Workflow context and supports a lightweight current-head check", async () => {
    const mocked = apiMock({
      pr: () => pr({ changed_files: 4, body: "λ".repeat(10000) }),
      files: Array.from({ length: 4 }, (_, index) => ({
        filename: `generated-${index}.js`,
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "x".repeat(60000),
      })),
    });
    const client = new GitHubClient("token", mocked);
    const context = await client.getPullRequest(job);
    expect(context.filesTruncated).toBe(true);
    expect(new TextEncoder().encode(context.body).byteLength).toBeLessThanOrEqual(8192);
    expect(
      context.files.reduce((sum, changed) => sum + (changed.patch?.length ?? 0), 0),
    ).toBeLessThanOrEqual(163840);
    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThan(300000);
    mocked.mockClear();
    expect(await client.isCurrent(job)).toBe(true);
    expect(mocked).toHaveBeenCalledTimes(1);
  });
  it("retrieves live PR data and detects pushes during file enumeration", async () => {
    const client = new GitHubClient("test-token", apiMock());
    expect(await client.getPullRequest(job)).toMatchObject({
      headSha,
      baseSha,
      files: [file],
      filesTruncated: false,
    });
    let reads = 0;
    const changing = apiMock({
      pr: () => pr(++reads > 1 ? { head: { sha: "c".repeat(40) } } : {}),
    });
    await expect(new GitHubClient("test-token", changing).getPullRequest(job)).rejects.toThrow(
      "GITHUB_PR_CHANGED_DURING_READ",
    );
  });

  it("rejects repository identity confusion and bounds generated patches", async () => {
    const mismatch = apiMock({
      pr: () => pr({ base: { sha: baseSha, repo: { ...repo, id: 999 } } }),
    });
    await expect(new GitHubClient("token", mismatch).getPullRequest(job)).rejects.toThrow(
      "GITHUB_REPOSITORY_SCOPE_MISMATCH",
    );
    const huge = apiMock({
      files: [
        {
          filename: "generated.js",
          status: "added",
          additions: 1,
          deletions: 0,
          patch: "+".repeat(100000),
        },
      ],
    });
    const context = await new GitHubClient("token", huge).getPullRequest(job);
    expect(context.filesTruncated).toBe(true);
    expect(context.files[0]?.patch).toBeUndefined();
  });

  it("reads only base-commit configuration and rejects symlink/oversized content", async () => {
    const yaml = "enabled: true\n";
    const mocked = vi.fn<Fetcher>(async () =>
      json({
        type: "file",
        size: Buffer.byteLength(yaml),
        encoding: "base64",
        content: Buffer.from(yaml).toString("base64"),
      }),
    );
    const client = new GitHubClient("token", mocked);
    expect(await client.getConfig(job, baseSha)).toBe(yaml);
    expect(String(mocked.mock.calls[0]![0])).toContain(`.ai-reviewer.yml?ref=${baseSha}`);
    await expect(client.getConfig(job, headSha)).rejects.toThrow("CONFIG_MUST_USE_TRUSTED_BASE");
    expect(
      await new GitHubClient("token", async () => json({}, 404)).getConfig(job, baseSha),
    ).toBeNull();
    await expect(
      new GitHubClient("token", async () =>
        json({ type: "symlink", size: 3, encoding: "base64", content: "YWJj" }),
      ).getConfig(job, baseSha),
    ).rejects.toThrow("INVALID_REPOSITORY_CONFIG_RESPONSE");
  });
});

describe("V0 round trip and reliable publication", () => {
  it.each([
    { priority: undefined, severity: "info", verdict: "✅ Approved", event: "APPROVE" },
    {
      priority: "should_fix",
      severity: "critical",
      verdict: "🟡 Approved With Comments",
      event: "COMMENT",
    },
    {
      priority: "warning",
      severity: "high",
      verdict: "🟡 Approved With Comments",
      event: "COMMENT",
    },
    { priority: "nit", severity: "info", verdict: "🟡 Approved With Comments", event: "COMMENT" },
    { priority: "must_fix", severity: "low", verdict: "❌ Not Approved", event: "REQUEST_CHANGES" },
  ] as const)(
    "publishes $verdict for $priority independently of severity",
    async ({ priority, severity, verdict, event }) => {
      const findings = priority ? [{ ...finding, priority, severity }] : [];
      const mocked = apiMock();
      await new GitHubClient("token", mocked, identity).publishReview(job, {
        ...result,
        findings,
        outcome: calculateOutcome(findings, true),
      });
      const posted = JSON.parse(
        String(mocked.mock.calls.find(([, init]) => init?.method === "POST")![1]?.body),
      ) as { body: string; event: string; comments: { body: string }[] };
      expect(posted.event).toBe(event);
      expect(posted.body).toMatch(new RegExp(`^## 🤖 AI Review\\n\\n### ${verdict}`));
      if (!priority) {
        expect(posted.body).toContain("No blocking or meaningful issues found.");
        expect(posted.body).not.toContain("### 🔴 Must Fix");
        expect(posted.body).not.toContain("0 Must Fix");
        expect(posted.comments).toEqual([]);
      } else {
        expect(posted.body).toContain(finding.title);
        expect(posted.body).toContain("**Fix:**");
        expect(posted.comments).toHaveLength(1);
      }
    },
  );

  it("groups all accepted findings, including inline comments, by priority and impact", async () => {
    const findings: Finding[] = [
      {
        ...finding,
        id: "nit",
        title: "Clarify the timeout name",
        priority: "nit",
        severity: "info",
      },
      {
        ...finding,
        id: "reliability",
        title: "Connection leak",
        priority: "must_fix",
        category: "reliability",
      },
      {
        ...finding,
        id: "test",
        title: "Test timeout cleanup",
        priority: "should_fix",
        category: "testing",
      },
      {
        ...finding,
        id: "assumption",
        title: "Document the supported server version",
        priority: "warning",
      },
      finding,
    ];
    const mocked = apiMock();
    await new GitHubClient("token", mocked, identity).publishReview(
      job,
      { ...result, findings },
      { maxComments: 1 },
    );
    const posted = JSON.parse(
      String(mocked.mock.calls.find(([, init]) => init?.method === "POST")![1]?.body),
    ) as { body: string; comments: { body: string }[] };
    expect(posted.body).toContain("**2 Must Fix · 1 Should Fix · 1 Warning · 1 Nit**");
    expect(posted.body.match(/^### [🔴🟠🟡🔵].*$/gmu)).toEqual([
      "### 🔴 Must Fix",
      "### 🟠 Should Fix",
      "### 🟡 Warnings",
      "### 🔵 Nits",
    ]);
    expect(posted.body).toContain(`1. **${finding.title}**`);
    expect(posted.body).toContain("2. **Connection leak**");
    expect(posted.comments[0]?.body).toContain("🔴 **Must Fix · Security**");
    expect(posted.comments[0]?.body).not.toContain("## 🤖 AI Review");
  });

  it("caps non-blocking feedback and never caps accepted blockers", async () => {
    const findings: Finding[] = (["nit", "warning", "should_fix", "must_fix"] as const).flatMap(
      (priority) =>
        Array.from({ length: priority === "must_fix" ? 35 : 7 }, (_, index) => ({
          ...finding,
          id: `${priority}-${index}`,
          title: `${priority} issue ${index}`,
          priority,
        })),
    );
    const mocked = apiMock();
    const published = await new GitHubClient("token", mocked, identity).publishReview(
      job,
      { ...result, findings },
      { maxComments: 0 },
    );
    const posted = JSON.parse(
      String(mocked.mock.calls.find(([, init]) => init?.method === "POST")![1]?.body),
    ) as { body: string; event: string; comments: unknown[] };
    expect(posted.event).toBe("REQUEST_CHANGES");
    expect(posted.comments).toEqual([]);
    expect(posted.body.match(/^\d+\. \*\*/gm)).toHaveLength(35 + 5 + 3 + 3);
    expect(published.postedFingerprints).toHaveLength(46);
    expect(posted.body).toContain("10 lower-priority findings omitted");
    expect(posted.body).toContain("35 Must Fix · 7 Should Fix · 7 Warnings · 7 Nits");
    expect(Buffer.byteLength(posted.body)).toBeLessThan(60000);
  });

  it("keeps a non-blocking verdict when custom display limits hide all feedback", async () => {
    const mocked = apiMock();
    const published = await new GitHubClient("token", mocked, identity).publishReview(
      job,
      {
        ...result,
        findings: [{ ...finding, priority: "should_fix" }],
        outcome: "PASS_WITH_FINDINGS",
      },
      { findingLimits: { shouldFix: 0 }, maxComments: 0 },
    );
    const posted = JSON.parse(
      String(mocked.mock.calls.find(([, init]) => init?.method === "POST")![1]?.body),
    ) as { body: string; event: string };
    expect(posted.event).toBe("COMMENT");
    expect(posted.body).toContain("🟡 Approved With Comments");
    expect(posted.body).toContain("1 Should Fix");
    expect(posted.body).toContain("1 lower-priority finding omitted");
    expect(published.postedFingerprints).toEqual([]);
  });

  it("deduplicates before counting and retains the highest accepted priority", async () => {
    const mocked = apiMock();
    const published = await new GitHubClient("token", mocked, identity).publishReview(job, {
      ...result,
      findings: [{ ...finding, priority: "nit" }, finding],
    });
    const posted = JSON.parse(
      String(mocked.mock.calls.find(([, init]) => init?.method === "POST")![1]?.body),
    ) as { body: string; event: string };
    expect(posted.body).toContain("**1 Must Fix**");
    expect(posted.body).not.toContain("1 Nit");
    expect(published.postedFingerprints).toHaveLength(1);
    expect(posted.event).toBe("REQUEST_CHANGES");
  });

  it.each([
    { findings: [], coverageComplete: false, outcome: "PASS" as const },
    { findings: [], coverageComplete: true, outcome: "REVIEW_FAILED" as const },
    {
      findings: [{ ...finding, priority: "should_fix" as const }],
      coverageComplete: false,
      outcome: "PASS_WITH_FINDINGS" as const,
    },
  ])("never approves an incomplete review: %j", async (partial) => {
    const mocked = apiMock();
    await new GitHubClient("token", mocked, identity).publishReview(job, { ...result, ...partial });
    const posted = JSON.parse(
      String(mocked.mock.calls.find(([, init]) => init?.method === "POST")![1]?.body),
    ) as { body: string; event: string };
    expect(posted.event).toBe("COMMENT");
    expect(posted.body).toContain("⚠️ Review Incomplete");
    expect(posted.body).not.toContain("### ✅ Approved");
    expect(posted.body).not.toContain("### ❌ Not Approved");
  });

  it("retains confirmed blockers when other review coverage is incomplete", async () => {
    const mocked = apiMock();
    await new GitHubClient("token", mocked, identity).publishReview(job, {
      ...result,
      coverageComplete: false,
    });
    const posted = JSON.parse(
      String(mocked.mock.calls.find(([, init]) => init?.method === "POST")![1]?.body),
    ) as { body: string; event: string };
    expect(posted.event).toBe("REQUEST_CHANGES");
    expect(posted.body).toContain("❌ Not Approved");
    expect(posted.body).toContain("Review coverage is incomplete.");
  });

  it("limits only inline comments while preserving accepted findings and outcome in the summary", async () => {
    for (const maxComments of [0, 1]) {
      const mocked = apiMock();
      const findings = [
        finding,
        {
          ...finding,
          id: "two",
          title: "Success is returned after unauthorized deletion",
          line: 3,
        },
      ];
      const published = await new GitHubClient("token", mocked, identity).publishReview(
        job,
        { ...result, findings },
        { maxComments },
      );
      const post = mocked.mock.calls.find(([, init]) => init?.method === "POST")!;
      const body = JSON.parse(String(post[1]?.body)) as { body: string; comments: unknown[] };
      expect(body.comments).toHaveLength(maxComments);
      expect(body.body).toContain("❌ Not Approved");
      expect(body.body).toContain("Success is returned after unauthorized deletion");
      expect(published.postedFingerprints).toHaveLength(2);
    }
  });
  it("keeps thirty Unicode summary findings bounded and neutralizes injected markers, mentions and credentials", () => {
    const hostile = {
      ...finding,
      description: "@everyone <!-- sherpa:review:injected --> ghs_" + "x".repeat(30),
    };
    const formatted = formatFinding(hostile);
    expect(formatted).not.toContain("@everyone");
    expect(formatted).not.toContain("<!-- sherpa:review:injected");
    expect(formatted).not.toContain("ghs_");
    const findings = Array.from({ length: 30 }, (_, index) => ({
      finding: {
        ...finding,
        id: String(index),
        path: "λ".repeat(490),
        description: "字".repeat(2000),
        evidence: ["字".repeat(1500)],
      },
      fingerprint: index.toString(16).padStart(64, "0"),
    }));
    const summary = formatSummary(
      job,
      result,
      findings,
      findings.map((entry) => entry.fingerprint),
    );
    expect(new TextEncoder().encode(summary).byteLength).toBeLessThan(60000);
    expect(summary.match(/<!-- sherpa:finding:/g)).toHaveLength(30);
  });

  it("links billing setup from a trusted origin and ignores untrusted URLs", () => {
    const failed = {
      ...result,
      outcome: "REVIEW_FAILED" as const,
      findings: [],
      coverageComplete: false,
      warnings: ["BILLING_NOT_CONFIGURED"],
    };
    const summary = formatSummary(job, failed, [], [], "https://sherpa.example.workers.dev");
    expect(summary).toContain("Configure billing at https://sherpa.example.workers.dev/setup");
    expect(summary).toContain("no Cloudflare AI Gateway");
    expect(formatSummary(job, failed, [], [], "javascript:alert(1)")).not.toContain("javascript:");
    expect(trustedSetupOrigin("https://sherpa.example.workers.dev/extra")).toBeUndefined();
  });

  it("restores posted fingerprints from an authenticated existing review manifest", async () => {
    const fingerprint = await findingFingerprint(finding);
    const mocked = apiMock({
      reviews: [review({ body: `${reviewMarker(job)}\n${findingMarker(fingerprint)}` })],
    });
    expect(await new GitHubClient("token", mocked, identity).findReview(job)).toEqual({
      id: 91,
      postedFingerprints: [fingerprint],
    });
  });
  it("processes a signed webhook through mocked PR retrieval and one REQUEST_CHANGES review", async () => {
    const raw = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", "webhook-secret").update(raw).digest("hex")}`;
    expect(await verifyWebhookSignature("webhook-secret", raw, signature)).toBe(true);
    const accepted = (await parseWebhook("pull_request", "round-trip", JSON.parse(raw)))!;
    const mocked = apiMock();
    const client = new GitHubClient("installation-token", mocked, identity);
    const published = await client.publishReview(accepted, result);
    expect(published).toEqual({ id: 91, postedFingerprints: [await findingFingerprint(finding)] });
    const posts = mocked.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0]![1]?.body)) as {
      event: string;
      commit_id: string;
      body: string;
      comments: unknown[];
    };
    expect(body.event).toBe("REQUEST_CHANGES");
    expect(body.commit_id).toBe(headSha);
    expect(body.body).toContain(reviewMarker(job));
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]).toMatchObject({ path: file.path, line: 2, side: "RIGHT" });
  });

  it("puts unanchorable blockers into the summary and requests changes by default", async () => {
    const mocked = apiMock();
    await new GitHubClient("token", mocked, identity).publishReview(job, {
      ...result,
      findings: [{ ...finding, line: 999 }],
    });
    const post = mocked.mock.calls.find(([, init]) => init?.method === "POST")!;
    const body = JSON.parse(String(post[1]?.body)) as {
      body: string;
      comments: unknown[];
      event: string;
    };
    expect(body.comments).toEqual([]);
    expect(body.body).toContain("src/auth.ts:999");
    expect(body.event).toBe("REQUEST_CHANGES");
  });

  it("reconciles only exact own-bot submitted reviews at the expected head", async () => {
    const forged = [
      review({ user: { login: "attacker", type: "User" } }),
      review({ user: { login: "other-app[bot]", type: "Bot" } }),
      review({ state: "PENDING" }),
      review({ commit_id: baseSha }),
    ];
    expect(
      await new GitHubClient("token", apiMock({ reviews: forged }), identity).findReview(job),
    ).toBeNull();
    const mocked = apiMock({ reviews: [...forged, review()] });
    expect(await new GitHubClient("token", mocked, identity).publishReview(job, result)).toEqual({
      id: 91,
      postedFingerprints: [],
    });
    expect(mocked.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await expect(new GitHubClient("token", mocked).findReview(job)).rejects.toThrow(
      "GITHUB_APP_IDENTITY_REQUIRED",
    );
  });

  it("fails closed when bounded review pagination cannot establish absence", async () => {
    const mocked = vi.fn<Fetcher>(async () =>
      json([review({ body: "other review" })], 200, {
        link: '<https://attacker.test/secret>; rel="next"',
      }),
    );
    await expect(new GitHubClient("secret", mocked, identity).findReview(job)).rejects.toThrow(
      "GITHUB_RECONCILIATION_LIMIT",
    );
    expect(mocked).toHaveBeenCalledTimes(10);
    expect(
      mocked.mock.calls.every(([url]) =>
        String(url).startsWith("https://api.github.com/repos/acme/example/"),
      ),
    ).toBe(true);
  });

  it("never retries ambiguous or rejected writes and exposes no secret error body", async () => {
    for (const post of [
      () => Promise.reject(new Error("token=secret")),
      () => json({ message: "secret-token-response" }, 500),
      () => json({ message: "secret-token-response" }, 422),
      () => new Response("bad-json"),
    ]) {
      const mocked = apiMock({ post });
      let error: unknown;
      try {
        await new GitHubClient("token", mocked, identity).publishReview(job, result);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GitHubError);
      expect(String(error)).not.toContain("secret");
      expect(mocked.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
  });

  it("discards stale results before publication", async () => {
    const mocked = apiMock({ pr: () => pr({ head: { sha: "c".repeat(40) } }) });
    await expect(
      new GitHubClient("token", mocked, identity).publishReview(job, result),
    ).rejects.toThrow("STALE_PULL_REQUEST");
    expect(mocked.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("stops unbounded streamed bodies and preserves POST ambiguity on oversized responses", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("oversized"));
        controller.close();
      },
    });
    await expect(boundedText(new Response(stream), 2)).rejects.toThrow("GITHUB_RESPONSE_TOO_LARGE");
    const api = new GitHubApi("token", async () => json({ id: 1, padding: "x".repeat(100) }));
    await expect(api.request("/post", { method: "POST", maxBytes: 10 })).rejects.toMatchObject({
      ambiguous: true,
    });
  });
});
