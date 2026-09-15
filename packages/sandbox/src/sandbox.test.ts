import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositorySession, repositoryFailureCode, type RepositorySandboxClient } from "./index";
import { SUPERVISOR, SUPERVISOR_COMMAND, type CommandSpec, type CommandResult } from "./runner";
import { handleReviewOutbound, type OutboundPolicy } from "./outbound";
import { repoConfigSchema, type ReviewJob, type ToolRequest } from "@sherpa/schemas";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function temporary(): string {
  const value = mkdtempSync(join(tmpdir(), "sherpa-sandbox-"));
  directories.push(value);
  return value;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function supervised(spec: CommandSpec): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-I", "-c", SUPERVISOR], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SHERPA_COMMAND_SPEC: JSON.stringify(spec) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout) as CommandResult);
    });
  });
}
function fixture(extraFiles: Record<string, string> = {}) {
  const directory = temporary();
  const remote = join(directory, "remote");
  mkdirSync(remote);
  git(remote, "init", "-b", "main");
  git(remote, "config", "user.email", "test@example.invalid");
  git(remote, "config", "user.name", "Sherpa Test");
  writeFileSync(join(remote, "main.ts"), "export const count = 1;\n");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "base");
  const baseSha = git(remote, "rev-parse", "HEAD");
  for (const [name, source] of Object.entries(extraFiles))
    writeFileSync(join(remote, name), source);
  writeFileSync(
    join(remote, "main.ts"),
    "export const count = 2;\nexport const next = count + 1;\n",
  );
  writeFileSync(join(remote, "$(touch hacked).ts"), "literal filename\n");
  symlinkSync("/etc/passwd", join(remote, "passwd"));
  git(remote, "add", ".");
  git(remote, "commit", "-m", "head");
  const headSha = git(remote, "rev-parse", "HEAD");
  git(remote, "update-ref", "refs/pull/1/head", headSha);
  const job: ReviewJob = {
    reviewId: "review-1",
    deliveryId: "delivery-1",
    installationId: 1,
    repositoryId: 2,
    owner: "example",
    repo: "project",
    number: 1,
    baseSha,
    headSha,
    action: "opened",
  };
  const commands: CommandSpec[] = [];
  const beginPreparation = vi.fn(async () => undefined);
  const endPreparation = vi.fn(async () => undefined);
  const client: RepositorySandboxClient = {
    beginPreparation,
    endPreparation,
    setPackageAccess: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    exec: async (command, options) => {
      expect(command).toBe(SUPERVISOR_COMMAND);
      const spec = JSON.parse(options!.env!.SHERPA_COMMAND_SPEC!) as CommandSpec;
      commands.push(structuredClone(spec));
      // The production adapter never receives local paths or enables the file protocol.
      spec.argv = spec.argv.map((arg) =>
        arg
          .replaceAll("/workspace/sherpa", join(directory, "sandbox"))
          .replaceAll("/tmp/sherpa-home", join(directory, "home"))
          .replace("http://github.com/example/project.git", `file://${remote}`)
          .replace("protocol.file.allow=never", "protocol.file.allow=always"),
      );
      if (spec.cwd) spec.cwd = spec.cwd.replace("/workspace/sherpa", join(directory, "sandbox"));
      const result = await supervised(spec);
      return { stdout: JSON.stringify(result), stderr: "", exitCode: 0, success: true };
    },
  };
  return { directory, remote, job, client, commands, beginPreparation, endPreparation };
}

describe("bounded command supervisor", () => {
  it("logs fixed failure codes without SDK command text or repository data", () => {
    expect(repositoryFailureCode(new Error("SANDBOX_SUPERVISOR_FAILED"))).toBe(
      "SANDBOX_SUPERVISOR_FAILED",
    );
    expect(repositoryFailureCode(new Error("command failed: private-source token-value"))).toBe(
      "SANDBOX_UNAVAILABLE",
    );
  });
  it("uses per-command env with closed stdin and preserves hostile text literally", () => {
    const directory = temporary();
    const literal = "quotes '\"; $(touch injected); `touch injected`\nUnicode: 雪";
    const spec: CommandSpec = {
      argv: [
        "python3",
        "-c",
        "import json, os, sys; print(json.dumps([sys.argv[1], os.getenv('SHERPA_COMMAND_SPEC')], ensure_ascii=False))",
        literal,
      ],
      cwd: directory,
      maxBytes: 1024,
      timeoutMs: 2000,
    };
    const stdout = execFileSync("/bin/sh", ["-c", SUPERVISOR_COMMAND], {
      env: { ...process.env, SHERPA_COMMAND_SPEC: JSON.stringify(spec) },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    const result = JSON.parse(stdout) as CommandResult;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual([literal, null]);
  });
  it("preserves ordinary exit statuses and never inherits live credentials", async () => {
    process.env.SHERPA_TEST_SECRET = "should-not-appear";
    const result = await supervised({
      argv: ["python3", "-c", "import os; print(os.getenv('SHERPA_TEST_SECRET', 'absent'))"],
      maxBytes: 1024,
      timeoutMs: 2000,
    });
    delete process.env.SHERPA_TEST_SECRET;
    expect(result).toMatchObject({
      exitCode: 0,
      output: "absent\n",
      truncated: false,
      timedOut: false,
    });
  });
  it("kills unbounded output before SDK buffering", async () => {
    const result = await supervised({
      argv: ["python3", "-c", "while True: print('x' * 10000)"],
      maxBytes: 4096,
      timeoutMs: 2000,
    });
    expect(Buffer.byteLength(result.output) + Buffer.byteLength(result.stderr)).toBe(4096);
    expect(result.truncated).toBe(true);
  });
  it("kills a silent process at its deadline", async () => {
    const started = Date.now();
    const result = await supervised({
      argv: ["python3", "-c", "import time; time.sleep(30)"],
      maxBytes: 4096,
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("repository snapshot tools against real local Git", () => {
  it("fetches the base repository pull ref, reviews immutable blobs, diffs and history", async () => {
    const data = fixture();
    const session = new RepositorySession(data.client);
    const prepared = await session.prepare(data.job);
    expect(prepared.incrementalBaseSha).toBe(data.job.baseSha);
    expect(
      data.commands.some((command) => command.argv.includes("+refs/pull/1/head:refs/sherpa/head")),
    ).toBe(true);
    expect(data.endPreparation).toHaveBeenCalledOnce();
    expect(
      await session.execute({ tool: "readFile", path: "main.ts", startLine: 1, endLine: 1 }),
    ).toMatchObject({ output: "1: export const count = 2;", truncated: false, fileExists: true });
    expect(
      await session.execute({
        tool: "gitShow",
        path: "main.ts",
        revision: "previous",
        startLine: 1,
        endLine: 1,
      }),
    ).toMatchObject({ output: "1: export const count = 1;", truncated: false, fileExists: true });
    expect(
      await session.execute({
        tool: "gitShow",
        path: "$(touch hacked).ts",
        revision: "previous",
        startLine: 1,
        endLine: 10,
      }),
    ).toMatchObject({
      status: "ok",
      output: "FILE_ABSENT_AT_REVISION",
      fileExists: false,
      truncated: false,
    });
    expect(
      await session.execute({
        tool: "gitShow",
        path: "passwd",
        revision: "head",
        startLine: 1,
        endLine: 10,
      }),
    ).toMatchObject({ status: "failed", output: "NOT_A_REGULAR_REPOSITORY_FILE" });
    expect(
      (await session.execute({ tool: "gitShow", path: "main.ts", revision: "base" })).output,
    ).toContain("count = 1");
    expect((await session.execute({ tool: "search", query: "next" })).output).toContain(
      "main.ts:2:",
    );
    expect((await session.execute({ tool: "findReferences", query: "no matches" })).status).toBe(
      "ok",
    );
    expect((await session.execute({ tool: "gitLog" })).output).toContain("head");
    const files = await session.getChangedFiles();
    expect(files.find((file) => file.path === "main.ts")).toMatchObject({
      additions: 2,
      deletions: 1,
      status: "modified",
    });
    const canonicalPatch = files.find((file) => file.path === "main.ts")?.patch;
    expect(canonicalPatch?.startsWith("@@ -1 +1,2 @@")).toBe(true);
    expect(canonicalPatch).not.toContain("diff --git");
    expect((await session.execute({ tool: "gitDiff", path: "main.ts" })).output).toContain(
      "diff --git",
    );
    writeFileSync(join(data.directory, "sandbox/repo/main.ts"), "tampered\n");
    expect((await session.execute({ tool: "readFile", path: "main.ts" })).output).toContain(
      "count = 2",
    );
    await session.destroy();
    expect(data.client.destroy).toHaveBeenCalledOnce();
  });
  it("rejects traversal, absolute paths, symlinks, revisions and arbitrary commands", async () => {
    const data = fixture();
    const session = new RepositorySession(data.client);
    await session.prepare(data.job);
    for (const path of ["../etc/passwd", "/etc/passwd", ".git/config", "a\\b", "a\nfile"]) {
      expect((await session.execute({ tool: "readFile", path })).status).toBe("failed");
    }
    expect((await session.execute({ tool: "readFile", path: "passwd" })).output).toBe(
      "NOT_A_REGULAR_REPOSITORY_FILE",
    );
    expect(
      (await session.execute({ tool: "readFile", path: "$(touch hacked).ts" })).output,
    ).toContain("literal filename");
    expect(
      (
        await session.execute({
          tool: "gitShow",
          path: "main.ts",
          revision: "HEAD; touch hacked",
        } as unknown as ToolRequest)
      ).status,
    ).toBe("failed");
    expect(
      (await session.execute({ tool: "exec", command: "echo hacked" } as unknown as ToolRequest))
        .status,
    ).toBe("failed");
    const count = data.commands.length;
    expect((await session.execute({ tool: "runTests" })).status).toBe("skipped");
    expect((await session.execute({ tool: "runStaticScan", scanner: "semgrep" })).status).toBe(
      "skipped",
    );
    expect(
      (
        await session.execute({
          tool: "runReproduction",
          language: "python",
          source: "print('x')",
          hypothesis: "Check x",
        })
      ).status,
    ).toBe("skipped");
    expect(data.commands).toHaveLength(count);
  });
  it("scans exact immutable lock coordinates through trusted OSV transport and caches results", async () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { name: "project" },
        "node_modules/lodash": {
          version: "4.17.15",
          resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz",
        },
      },
    };
    const data = fixture({ "package-lock.json": JSON.stringify(lock) });
    const fetcher = vi.fn(async () =>
      Response.json({ results: [{ vulns: [{ id: "GHSA-35jh-r3h4-6jhm" }] }] }),
    );
    const session = new RepositorySession(data.client, {
      allowValidation: true,
      validation: repoConfigSchema.parse({ validation: { enabled: true, security: true } })
        .validation,
      advisoryFetch: fetcher,
    });
    await session.prepare(data.job);
    writeFileSync(join(data.directory, "sandbox/repo/package-lock.json"), "tampered");
    const result = await session.execute({ tool: "runStaticScan", scanner: "osv" });
    expect(result).toMatchObject({ status: "ok", truncated: false });
    expect(JSON.parse(result.output)).toMatchObject({
      packagesChecked: 1,
      matches: [{ name: "lodash", version: "4.17.15", advisoryIds: ["GHSA-35jh-r3h4-6jhm"] }],
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await session.execute({ tool: "runStaticScan", scanner: "osv" })).toEqual(result);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(data.client.setPackageAccess).not.toHaveBeenCalled();
  });
  it("bounds model reproduction attempts and fails closed when isolation cannot start", async () => {
    const data = fixture();
    const originalExec = data.client.exec;
    const evidenceCommands: CommandSpec[] = [];
    data.client.exec = async (command, options) => {
      const spec = JSON.parse(options!.env!.SHERPA_COMMAND_SPEC!) as CommandSpec;
      if (!spec.evidence) return originalExec(command, options);
      evidenceCommands.push(spec);
      return {
        success: true,
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          output: "",
          stderr: "bwrap: unprivileged namespaces unavailable",
          exitCode: 1,
          truncated: false,
          timedOut: false,
        }),
      };
    };
    const session = new RepositorySession(data.client, {
      allowValidation: true,
      validation: repoConfigSchema.parse({
        validation: { enabled: true, tests: true, security: true },
      }).validation,
    });
    await session.prepare(data.job);
    const request = {
      tool: "runReproduction",
      language: "javascript",
      source: "console.log('$(touch hacked)');",
      hypothesis: "a named regression",
    } as const;
    for (let i = 0; i < 3; i++) expect((await session.execute(request)).status).toBe("failed");
    expect((await session.execute(request)).output).toBe("REPRODUCTION_ATTEMPT_LIMIT");
    expect(evidenceCommands).toHaveLength(3);
    expect(evidenceCommands[0]).toMatchObject({
      untrusted: true,
      evidence: "reproduction",
      timeoutMs: 15000,
    });
    expect(JSON.parse(evidenceCommands[0]!.argv.at(-1)!)).toMatchObject({
      source: request.source,
      head: data.job.headSha,
    });
    expect((await session.execute({ ...request, source: "x".repeat(12001) })).output).toBe(
      "INVALID_TOOL_REQUEST",
    );
    expect((await session.execute({ tool: "runStaticScan", scanner: "semgrep" })).status).toBe(
      "failed",
    );
    expect(evidenceCommands.at(-1)).toMatchObject({ untrusted: true, evidence: "scanner" });
    expect(JSON.parse(evidenceCommands.at(-1)!.argv.at(-1)!)).toMatchObject({
      mode: "scanner",
      paths: ["$(touch hacked).ts", "main.ts"],
    });
    expect((await session.execute({ tool: "runStaticScan", scanner: "opengrep" })).status).toBe(
      "skipped",
    );
    expect(data.client.setPackageAccess).not.toHaveBeenCalled();
  });
  it("reports complete early ranges and incomplete late ranges of source larger than the read ceiling", async () => {
    const data = fixture({
      "large.ts": Array.from({ length: 5000 }, (_, index) => `// ${index} ${"x".repeat(100)}`).join(
        "\n",
      ),
    });
    const session = new RepositorySession(data.client);
    await session.prepare(data.job);
    expect(
      await session.execute({ tool: "readFile", path: "large.ts", startLine: 1, endLine: 5 }),
    ).toMatchObject({ status: "ok", truncated: false });
    expect(
      (
        await session.execute({
          tool: "readFile",
          path: "large.ts",
          startLine: 4500,
          endLine: 4505,
        })
      ).truncated,
    ).toBe(true);
    expect(
      (await session.execute({ tool: "readFile", path: "large.ts", startLine: 1, endLine: 1000 }))
        .truncated,
    ).toBe(true);
    expect(
      (
        await session.execute({
          tool: "gitShow",
          path: "large.ts",
          revision: "head",
          startLine: 2,
          endLine: 1,
        })
      ).output,
    ).toBe("INVALID_LINE_RANGE");
  });
  it("uses the previous reviewed SHA when it is an ancestor", async () => {
    const data = fixture();
    const previousSha = data.job.headSha;
    writeFileSync(join(data.remote, "new.ts"), "export const added = true;\n");
    git(data.remote, "add", ".");
    git(data.remote, "commit", "-m", "new change");
    data.job.headSha = git(data.remote, "rev-parse", "HEAD");
    git(data.remote, "update-ref", "refs/pull/1/head", data.job.headSha);
    const session = new RepositorySession(data.client);
    expect((await session.prepare(data.job, previousSha)).incrementalBaseSha).toBe(previousSha);
    expect((await session.getChangedFiles()).map((file) => file.path)).toEqual(["new.ts"]);
  });
  it("falls back after a force push and always closes provisioning auth on failure", async () => {
    const data = fixture();
    git(data.remote, "checkout", "--detach", data.job.baseSha);
    writeFileSync(join(data.remote, "other.ts"), "unrelated branch\n");
    git(data.remote, "add", ".");
    git(data.remote, "commit", "-m", "diverged");
    const divergent = git(data.remote, "rev-parse", "HEAD");
    const session = new RepositorySession(data.client);
    const result = await session.prepare(data.job, divergent);
    expect(result.incrementalBaseSha).toBe(data.job.baseSha);
    expect(result.warnings).toHaveLength(1);
    const failed = fixture();
    const staleJob = { ...failed.job, headSha: "a".repeat(40) };
    await expect(new RepositorySession(failed.client).prepare(staleJob)).rejects.toThrow(
      "PULL_REQUEST_HEAD_CHANGED",
    );
    expect(failed.endPreparation).toHaveBeenCalledOnce();
  });
});

const outboundJob: ReviewJob = {
  reviewId: "review",
  deliveryId: "delivery",
  installationId: 4,
  repositoryId: 5,
  owner: "example",
  repo: "private",
  number: 1,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  action: "opened",
};
const policy = (phase: OutboundPolicy["phase"] = "git"): OutboundPolicy => ({
  job: outboundJob,
  phase,
  expiresAt: Date.now() + 60000,
});
describe("trusted outbound credential injection", () => {
  it.each(["http", "https"])(
    "forwards the %s Git POST body to GitHub over HTTPS",
    async (protocol) => {
      const token = vi.fn(async () => "installation-token");
      const fetcher = vi.fn<typeof fetch>(async (request) => {
        expect(request).toBeInstanceOf(Request);
        expect(await (request as Request).text()).toBe("0000");
        expect((request as Request).method).toBe("POST");
        expect((request as Request).url).toBe(
          "https://github.com/example/private.git/git-upload-pack",
        );
        expect((request as Request).headers.get("Authorization")).toBe(
          `Basic ${btoa("x-access-token:installation-token")}`,
        );
        return new Response("pack");
      });
      const request = new Request(`${protocol}://github.com/example/private.git/git-upload-pack`, {
        method: "POST",
        headers: { "Content-Type": "application/x-git-upload-pack-request" },
        body: "0000",
      });
      expect((await handleReviewOutbound(request, policy(), token, fetcher)).status).toBe(200);
    },
  );
  it.each(["http", "https"])(
    "injects scoped credentials for %s Git discovery and strips attacker headers",
    async (protocol) => {
      const token = vi.fn(async () => "installation-token");
      const fetcher = vi.fn<typeof fetch>(async () => new Response("git bytes"));
      const request = new Request(
        `${protocol}://github.com/example/private.git/info/refs?service=git-upload-pack`,
        { headers: { Authorization: "attacker", Cookie: "attacker", "Git-Protocol": "version=2" } },
      );
      expect((await handleReviewOutbound(request, policy(), token, fetcher)).status).toBe(200);
      expect(token).toHaveBeenCalledWith(outboundJob);
      const forwarded = fetcher.mock.calls[0]?.[0] as Request;
      expect(forwarded.url).toBe(
        "https://github.com/example/private.git/info/refs?service=git-upload-pack",
      );
      expect(forwarded.headers.get("Git-Protocol")).toBe("version=2");
      expect(forwarded.headers.get("Authorization")).toBe(
        `Basic ${btoa("x-access-token:installation-token")}`,
      );
      expect(forwarded.headers.has("Cookie")).toBe(false);
      expect(forwarded.redirect).toBe("manual");
      expect(request.headers.get("Authorization")).toBe("attacker");
    },
  );
  it("denies other repositories, git writes, spoofing, expired contexts and all post-setup Git", async () => {
    const token = vi.fn(async () => "secret");
    for (const url of [
      "https://github.com/other/private.git/info/refs?service=git-upload-pack",
      "https://github.com/example/private.git/git-receive-pack",
      "https://github.com.evil.invalid/example/private.git/info/refs?service=git-upload-pack",
      "http://github.com/other/private.git/info/refs?service=git-upload-pack",
      "http://github.com:444/example/private.git/info/refs?service=git-upload-pack",
      "http://github.com.evil.invalid/example/private.git/info/refs?service=git-upload-pack",
      "https://github.com:444/example/private.git/info/refs?service=git-upload-pack",
      "https://evil.invalid/",
    ]) {
      expect((await handleReviewOutbound(new Request(url), policy(), token)).status).toBe(403);
    }
    const request = new Request(
      "https://github.com/example/private.git/info/refs?service=git-upload-pack",
    );
    expect((await handleReviewOutbound(request, { ...policy(), expiresAt: 0 }, token)).status).toBe(
      403,
    );
    expect((await handleReviewOutbound(request, policy("closed"), token)).status).toBe(403);
    expect((await handleReviewOutbound(request, policy("packages"), token)).status).toBe(403);
    const internalRequest = new Request(request.url.replace("https:", "http:"));
    expect((await handleReviewOutbound(internalRequest, policy("closed"), token)).status).toBe(403);
    expect((await handleReviewOutbound(internalRequest, policy("packages"), token)).status).toBe(
      403,
    );
    expect(
      (
        await handleReviewOutbound(
          new Request("http://registry.npmjs.org/package"),
          policy("packages"),
          token,
        )
      ).status,
    ).toBe(403);
    expect(token).not.toHaveBeenCalled();
  });
  it("denies redirects and registry writes; registry fetches never receive Git credentials", async () => {
    const token = vi.fn(async () => "secret");
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response("redirect", { status: 302, headers: { Location: "https://evil.invalid/" } }),
    );
    expect(
      (
        await handleReviewOutbound(
          new Request("https://github.com/example/private.git/info/refs?service=git-upload-pack"),
          policy(),
          token,
          fetcher,
        )
      ).status,
    ).toBe(403);
    token.mockClear();
    const registry = "https://registry.npmjs.org/example/-/example-1.0.0.tgz";
    expect(
      (
        await handleReviewOutbound(
          new Request(registry, { method: "PUT" }),
          policy("packages"),
          token,
        )
      ).status,
    ).toBe(403);
    const registryFetch = vi.fn<typeof fetch>(async () => new Response("tarball"));
    expect(
      (await handleReviewOutbound(new Request(registry), policy("packages"), token, registryFetch))
        .status,
    ).toBe(200);
    expect(token).not.toHaveBeenCalled();
    expect((registryFetch.mock.calls[0]?.[0] as Request).headers.has("Authorization")).toBe(false);
  });
});
