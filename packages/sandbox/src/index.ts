import {
  repositoryPathSchema,
  reviewJobSchema,
  shaSchema,
  toolRequestSchema,
  type ChangedFile,
  type RepoConfig,
  type ReviewJob,
  type ToolRequest,
  type ToolResult,
} from "@sherpa/schemas";
import { SUPERVISOR_COMMAND, type CommandResult, type CommandSpec } from "./runner";
import { EVIDENCE_RUNNER } from "./evidence";
import { npmLockPackages, queryOsv } from "./osv";
import type { ExecOptions } from "@cloudflare/sandbox";
export { repositoryFailureCode } from "./diagnostics";

export interface RepositorySandboxClient {
  exec(
    command: string,
    options?: Pick<ExecOptions, "env" | "timeout">,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; success: boolean }>;
  beginPreparation(job: ReviewJob): Promise<void>;
  endPreparation(): Promise<void>;
  setPackageAccess(enabled: boolean): Promise<void>;
  destroy(): Promise<unknown>;
}
export type RepositorySessionOptions = {
  /** Must come from the trusted BASE config after service limits are applied. */
  validation?: RepoConfig["validation"];
  allowValidation?: boolean;
  maxOutputBytes?: number;
  commandTimeoutMs?: number;
  validationTimeoutMs?: number;
  /** Trusted Worker-side OSV transport; never exposed inside the container. */
  advisoryFetch?: typeof fetch;
};
const ROOT = "/workspace/sherpa";
const REPO = `${ROOT}/repo`;
const GIT_DIR = `${ROOT}/git`;
const GIT = [
  "git",
  `--git-dir=${GIT_DIR}`,
  `--work-tree=${REPO}`,
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "http.followRedirects=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "diff.external=",
  "-c",
  "credential.helper=",
];
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/** One isolated immutable review snapshot. Model requests never select a shell command or URL. */
export class RepositorySession {
  private job?: ReviewJob;
  private incrementalBaseSha?: string;
  private prepared = false;
  private validationDone = new Map<string, ToolResult>();
  private reproductionCount = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private packageManager?: "pnpm" | "npm" | "yarn";
  private packageScripts = new Set<string>();
  private readonly maxBytes: number;
  private readonly commandTimeout: number;
  private readonly validationTimeout: number;
  constructor(
    private readonly sandbox: RepositorySandboxClient,
    private readonly options: RepositorySessionOptions = {},
  ) {
    this.maxBytes = Math.max(1024, Math.min(options.maxOutputBytes ?? 32768, 131072));
    this.commandTimeout = Math.max(100, Math.min(options.commandTimeoutMs ?? 20000, 60000));
    this.validationTimeout = Math.max(100, Math.min(options.validationTimeoutMs ?? 60000, 180000));
  }
  private async run(
    argv: string[],
    options: Partial<Omit<CommandSpec, "argv">> = {},
  ): Promise<CommandResult> {
    const spec: CommandSpec = {
      argv,
      maxBytes: this.maxBytes,
      timeoutMs: this.commandTimeout,
      ...options,
    };
    const response = await this.sandbox.exec(SUPERVISOR_COMMAND, {
      // SDK 0.12.9 forwards per-command env, but silently drops the documented stdin option.
      env: { SHERPA_COMMAND_SPEC: JSON.stringify(spec) },
      timeout: spec.timeoutMs + 10000,
    });
    if (!response.success) throw new Error("SANDBOX_SUPERVISOR_FAILED");
    const parsed: unknown = JSON.parse(response.stdout);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("output" in parsed) ||
      typeof parsed.output !== "string" ||
      !("exitCode" in parsed) ||
      typeof parsed.exitCode !== "number" ||
      !("truncated" in parsed) ||
      typeof parsed.truncated !== "boolean" ||
      !("timedOut" in parsed) ||
      typeof parsed.timedOut !== "boolean"
    )
      throw new Error("INVALID_SANDBOX_RESPONSE");
    return {
      output: parsed.output,
      stderr: "stderr" in parsed && typeof parsed.stderr === "string" ? parsed.stderr : "",
      exitCode: parsed.exitCode,
      truncated: parsed.truncated,
      timedOut: parsed.timedOut,
    };
  }
  private async must(
    argv: string[],
    options: Partial<Omit<CommandSpec, "argv">> = {},
  ): Promise<string> {
    const result = await this.run(argv, options);
    if (result.exitCode !== 0 || result.timedOut || result.truncated)
      throw new Error(
        result.timedOut
          ? "REPOSITORY_COMMAND_TIMEOUT"
          : result.truncated
            ? "REPOSITORY_OUTPUT_LIMIT"
            : "REPOSITORY_COMMAND_FAILED",
      );
    return result.output;
  }
  async prepare(
    input: ReviewJob,
    previousSha?: string,
  ): Promise<{ incrementalBaseSha: string; warnings: string[] }> {
    if (this.job) throw new Error("SESSION_ALREADY_PREPARED");
    const job = reviewJobSchema.parse(input);
    if (previousSha) shaSchema.parse(previousSha);
    this.job = job;
    const warnings: string[] = [];
    await this.sandbox.beginPreparation(job);
    try {
      await this.must(["mkdir", "-p", ROOT, REPO, "/tmp/sherpa-home"]);
      await this.must(["git", "init", "--bare", GIT_DIR]);
      // HTTP is confined to Cloudflare's internal ContainerProxy hop. The trusted
      // outbound handler enforces HTTPS to GitHub and adds credentials there.
      const remote = `http://github.com/${job.owner}/${job.repo}.git`;
      await this.must([...GIT, "remote", "add", "origin", remote]);
      await this.must(
        [
          ...GIT,
          "fetch",
          "--no-tags",
          "--depth=256",
          "origin",
          `+refs/pull/${job.number}/head:refs/sherpa/head`,
          job.baseSha,
        ],
        { timeoutMs: 120000 },
      );
      const fetchedHead = (
        await this.must([...GIT, "rev-parse", "refs/sherpa/head^{commit}"])
      ).trim();
      if (fetchedHead !== job.headSha) throw new Error("PULL_REQUEST_HEAD_CHANGED");
      let mergeBase = await this.run([...GIT, "merge-base", job.baseSha, job.headSha]);
      if (mergeBase.exitCode !== 0) {
        await this.must(
          [
            ...GIT,
            "fetch",
            "--no-tags",
            "--deepen=1024",
            "origin",
            `+refs/pull/${job.number}/head:refs/sherpa/head`,
            job.baseSha,
          ],
          { timeoutMs: 120000 },
        );
        mergeBase = await this.run([...GIT, "merge-base", job.baseSha, job.headSha]);
      }
      if (mergeBase.exitCode !== 0 || mergeBase.truncated || mergeBase.timedOut)
        throw new Error("MERGE_BASE_UNAVAILABLE");
      this.incrementalBaseSha = shaSchema.parse(mergeBase.output.trim());
      if (previousSha) {
        const available = await this.run([...GIT, "cat-file", "-e", `${previousSha}^{commit}`]);
        const fetched =
          available.exitCode === 0
            ? available
            : await this.run([...GIT, "fetch", "--no-tags", "--depth=256", "origin", previousSha], {
                timeoutMs: 120000,
              });
        const ancestor =
          fetched.exitCode === 0
            ? await this.run([...GIT, "merge-base", "--is-ancestor", previousSha, job.headSha])
            : fetched;
        if (ancestor.exitCode === 0 && !ancestor.timedOut && !ancestor.truncated)
          this.incrementalBaseSha = previousSha;
        else
          warnings.push(
            "Previous reviewed commit is unavailable or is not an ancestor; reviewing from the merge base.",
          );
      }
      await this.must([...GIT, "config", "core.bare", "false"]);
      await this.must([...GIT, "checkout", "--force", "--detach", job.headSha], {
        timeoutMs: 60000,
      });
      this.prepared = true;
    } finally {
      await this.sandbox.endPreparation();
    }
    if (this.options.allowValidation && this.options.validation?.enabled) {
      await this.configureValidation(warnings);
    }
    return { incrementalBaseSha: this.incrementalBaseSha, warnings };
  }
  async getChangedFiles(): Promise<ChangedFile[]> {
    return this.serial(async () => {
      this.assertPrepared();
      const range = [this.incrementalBaseSha!, this.job!.headSha];
      const output = await this.must(
        [
          ...GIT,
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--numstat",
          "-z",
          ...range,
          "--",
        ],
        { maxBytes: 131072 },
      );
      const stats = output.split("\0").filter(Boolean);
      if (stats.length > 200) throw new Error("TOO_MANY_CHANGED_FILES");
      const files: ChangedFile[] = [];
      let remaining = 524288;
      for (const row of stats) {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
        if (!match) throw new Error("INVALID_GIT_DIFF");
        const path = repositoryPathSchema.parse(match[3]);
        const result = await this.run(
          [
            ...GIT,
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--unified=3",
            ...range,
            "--",
            path,
          ],
          { maxBytes: Math.min(remaining, 65536) },
        );
        if (result.exitCode !== 0 || result.truncated || result.timedOut)
          throw new Error("CHANGED_FILE_DIFF_LIMIT");
        remaining -= byteLength(result.output);
        if (remaining < 1024) throw new Error("REVIEW_DIFF_LIMIT");
        // Match GitHub's files API: ChangedFile.patch contains unified hunks only.
        // Raw gitDiff tool output still includes file headers and mode changes.
        const firstHunk = result.output.search(/^@@ /m);
        files.push({
          path,
          additions: Number(match[1]) || 0,
          deletions: Number(match[2]) || 0,
          status: result.output.includes("\nnew file mode ")
            ? "added"
            : result.output.includes("\ndeleted file mode ")
              ? "removed"
              : "modified",
          ...(firstHunk >= 0 ? { patch: result.output.slice(firstHunk) } : {}),
        });
      }
      return files;
    });
  }
  private assertPrepared(): void {
    if (!this.prepared || !this.job || !this.incrementalBaseSha)
      throw new Error("REPOSITORY_NOT_PREPARED");
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  execute(input: ToolRequest): Promise<ToolResult> {
    return this.serial(async () => {
      const started = Date.now();
      const parsed = toolRequestSchema.safeParse(input);
      if (!parsed.success)
        return {
          tool: input.tool,
          status: "failed",
          output: "INVALID_TOOL_REQUEST",
          truncated: false,
          durationMs: Date.now() - started,
        };
      const request = parsed.data;
      try {
        this.assertPrepared();
        if (request.tool === "runReproduction") return await this.reproduce(request, started);
        if (request.tool === "runStaticScan") return await this.staticScan(request, started);
        if (request.tool.startsWith("run")) return await this.validate(request.tool, started);
        const head = this.job!.headSha;
        let args: string[];
        let outputLimit = this.maxBytes;
        switch (request.tool) {
          case "readFile":
            if ((request.endLine ?? 100000) < (request.startLine ?? 1))
              throw new Error("INVALID_LINE_RANGE");
            await this.assertRegularBlob(head, request.path);
            args = ["show", `${head}:${request.path}`];
            outputLimit = 262144;
            break;
          case "gitShow": {
            if ((request.endLine ?? 100000) < (request.startLine ?? 1))
              throw new Error("INVALID_LINE_RANGE");
            const revision =
              request.revision === "head"
                ? head
                : request.revision === "base"
                  ? this.job!.baseSha
                  : this.incrementalBaseSha!;
            if (!(await this.assertRegularBlob(revision, request.path, true)))
              return {
                tool: request.tool,
                status: "ok",
                output: "FILE_ABSENT_AT_REVISION",
                fileExists: false,
                truncated: false,
                durationMs: Date.now() - started,
              };
            args = ["show", `${revision}:${request.path}`];
            if (request.startLine !== undefined || request.endLine !== undefined)
              outputLimit = 262144;
            break;
          }
          case "search":
          case "grep":
          case "findReferences":
            args = ["grep", "-n", "-I", "-F", "--no-color", "-e", request.query, head, "--"];
            break;
          case "gitDiff":
            args = [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--no-renames",
              "--unified=3",
              this.incrementalBaseSha!,
              head,
              "--",
              ...(request.path ? [request.path] : []),
            ];
            break;
          case "gitLog":
            args = [
              "log",
              "--max-count=12",
              "--format=%h %s",
              head,
              "--",
              ...(request.path ? [request.path] : []),
            ];
            break;
          default:
            throw new Error("UNKNOWN_TOOL");
        }
        const result = await this.run([...GIT, ...args], { maxBytes: outputLimit });
        let output = result.output;
        let rangeSatisfied = false;
        if (
          request.tool === "readFile" ||
          (request.tool === "gitShow" &&
            (request.startLine !== undefined || request.endLine !== undefined))
        ) {
          const start = request.startLine ?? 1;
          const requestedEnd = request.endLine ?? start + 199;
          const end = Math.min(requestedEnd, start + 499);
          const lines = output.split("\n");
          // A capped source may still contain every requested complete line.
          rangeSatisfied =
            !result.timedOut &&
            ((result.exitCode === 0 && !result.truncated) ||
              (result.truncated && lines.length > end));
          result.truncated = requestedEnd > end || !rangeSatisfied;
          output = lines
            .slice(start - 1, end)
            .map((line, index) => `${start + index}: ${line}`)
            .join("\n");
        }
        const bounded = new TextEncoder().encode(output);
        if (bounded.length > this.maxBytes) {
          output = new TextDecoder().decode(bounded.slice(0, this.maxBytes));
          result.truncated = true;
        }
        const noMatches =
          ["search", "grep", "findReferences"].includes(request.tool) && result.exitCode === 1;
        return {
          tool: request.tool,
          status:
            result.timedOut ||
            (!result.truncated && result.exitCode !== 0 && !noMatches && !rangeSatisfied)
              ? "failed"
              : "ok",
          output: result.timedOut ? `${output}\nCOMMAND_TIMEOUT` : output,
          truncated: result.truncated,
          durationMs: Date.now() - started,
          ...(["readFile", "gitShow"].includes(request.tool) ? { fileExists: true } : {}),
        };
      } catch (error) {
        return {
          tool: request.tool,
          status: "failed",
          output:
            error instanceof Error && /^[A-Z_]+$/.test(error.message)
              ? error.message
              : "REPOSITORY_TOOL_FAILED",
          truncated: false,
          durationMs: Date.now() - started,
        };
      }
    });
  }
  private async assertRegularBlob(
    revision: string,
    path: string,
    allowAbsent = false,
  ): Promise<boolean> {
    const entry = await this.must([...GIT, "ls-tree", "-z", revision, "--", path], {
      maxBytes: 2048,
    });
    if (entry === "" && allowAbsent) return false;
    if (
      !/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry) ||
      entry.split("\0").filter(Boolean).length !== 1
    )
      throw new Error("NOT_A_REGULAR_REPOSITORY_FILE");
    return true;
  }
  private evidenceAllowed(kind: "tests" | "security"): boolean {
    return Boolean(
      this.options.allowValidation &&
      this.options.validation?.enabled &&
      this.options.validation[kind],
    );
  }
  private skipped(tool: ToolRequest["tool"], started: number, output: string): ToolResult {
    return { tool, status: "skipped", output, truncated: false, durationMs: Date.now() - started };
  }
  private async reproduce(
    request: Extract<ToolRequest, { tool: "runReproduction" }>,
    started: number,
  ): Promise<ToolResult> {
    if (!this.evidenceAllowed("tests"))
      return this.skipped(
        request.tool,
        started,
        "Reproduction requires service approval and tests enabled in trusted base configuration.",
      );
    if (this.reproductionCount >= 3)
      return this.skipped(request.tool, started, "REPRODUCTION_ATTEMPT_LIMIT");
    this.reproductionCount++;
    const result = await this.run(
      [
        "python3",
        "-I",
        "-c",
        EVIDENCE_RUNNER,
        JSON.stringify({
          mode: "reproduction",
          head: this.job!.headSha,
          language: request.language,
          source: request.source,
          hypothesis: request.hypothesis,
        }),
      ],
      {
        untrusted: true,
        evidence: "reproduction",
        timeoutMs: Math.min(15000, this.validationTimeout),
      },
    );
    return this.commandEvidence(request.tool, started, result);
  }
  private commandEvidence(
    tool: ToolRequest["tool"],
    started: number,
    result: CommandResult,
  ): ToolResult {
    return {
      tool,
      status: result.exitCode === 0 && !result.timedOut && !result.truncated ? "ok" : "failed",
      output: result.output + result.stderr + (result.timedOut ? "\nCOMMAND_TIMEOUT" : ""),
      truncated: result.truncated,
      durationMs: Date.now() - started,
    };
  }
  private async staticScan(
    request: Extract<ToolRequest, { tool: "runStaticScan" }>,
    started: number,
  ): Promise<ToolResult> {
    if (!this.evidenceAllowed("security"))
      return this.skipped(
        request.tool,
        started,
        "Static scanning requires service approval and security enabled in trusted base configuration.",
      );
    const key = `${request.tool}:${request.scanner}`;
    const cached = this.validationDone.get(key);
    if (cached) return cached;
    this.validationDone.set(
      key,
      this.skipped(request.tool, started, "SCANNER_ATTEMPT_ALREADY_USED"),
    );
    let value: ToolResult;
    if (request.scanner === "opengrep") {
      value = this.skipped(request.tool, started, "OPENGREP_NOT_INSTALLED_USE_SEMGREP");
    } else if (request.scanner === "osv") {
      if (!(await this.assertRegularBlob(this.job!.headSha, "package-lock.json", true)))
        return this.skipped(request.tool, started, "OSV_REQUIRES_NPM_LOCKFILE_V2_OR_V3");
      const source = await this.must([...GIT, "show", `${this.job!.headSha}:package-lock.json`], {
        maxBytes: 262144,
      });
      const locked = npmLockPackages(source);
      if (!locked.packages.length)
        return this.skipped(request.tool, started, "OSV_NO_SUPPORTED_LOCKED_PACKAGES");
      const evidence = await queryOsv(locked.packages, this.options.advisoryFetch);
      const output = JSON.stringify({
        scanner: "osv",
        evidenceOnly: true,
        lockfile: "package-lock.json",
        packagesChecked: locked.packages.length,
        matches: evidence.matches,
      });
      const bytes = new TextEncoder().encode(output);
      value = {
        tool: request.tool,
        status: "ok",
        output: new TextDecoder().decode(bytes.slice(0, this.maxBytes)),
        truncated: locked.incomplete || evidence.incomplete || bytes.length > this.maxBytes,
        durationMs: Date.now() - started,
      };
    } else {
      const changed = await this.must(
        [
          ...GIT,
          "diff",
          "--no-renames",
          "--name-only",
          "--diff-filter=AM",
          "-z",
          this.incrementalBaseSha!,
          this.job!.headSha,
          "--",
        ],
        { maxBytes: 65536 },
      );
      const paths = changed
        .split("\0")
        .filter(Boolean)
        .map((path) => repositoryPathSchema.parse(path))
        .filter((path) => /\.(?:[cm]?js|jsx|[cm]?ts|tsx|py)$/.test(path));
      if (paths.length > 200) throw new Error("SCANNER_FILE_LIMIT");
      if (!paths.length)
        return this.skipped(request.tool, started, "SEMGREP_NO_SUPPORTED_CHANGED_FILES");
      const result = await this.run(
        [
          "python3",
          "-I",
          "-c",
          EVIDENCE_RUNNER,
          JSON.stringify({ mode: "scanner", head: this.job!.headSha, paths }),
        ],
        {
          untrusted: true,
          evidence: "scanner",
          timeoutMs: Math.min(60000, this.validationTimeout),
        },
      );
      value = this.commandEvidence(request.tool, started, result);
    }
    this.validationDone.set(key, value);
    return value;
  }
  private async configureValidation(warnings: string[]): Promise<void> {
    const listing = await this.must([...GIT, "ls-tree", "--name-only", this.job!.headSha], {
      maxBytes: 32768,
    });
    const names = new Set(listing.split("\n"));
    const managers = [
      names.has("pnpm-lock.yaml") ? "pnpm" : undefined,
      names.has("package-lock.json") ? "npm" : undefined,
      names.has("yarn.lock") ? "yarn" : undefined,
    ].filter((value): value is "pnpm" | "npm" | "yarn" => Boolean(value));
    if (managers.length !== 1 || !names.has("package.json")) {
      warnings.push(
        "Validation skipped: exactly one supported lockfile and package.json are required.",
      );
      return;
    }
    this.packageManager = managers[0];
    await this.assertRegularBlob(this.job!.headSha, "package.json");
    const manifest: unknown = JSON.parse(
      await this.must([...GIT, "show", `${this.job!.headSha}:package.json`], { maxBytes: 32768 }),
    );
    if (
      manifest &&
      typeof manifest === "object" &&
      "scripts" in manifest &&
      manifest.scripts &&
      typeof manifest.scripts === "object"
    )
      this.packageScripts = new Set(Object.keys(manifest.scripts));
    // Working files are writable by the isolated UID; immutable Git objects stay root-owned.
    await this.must(["chown", "-hR", "65534:65534", REPO, "/tmp/sherpa-home"]);
    if (this.options.validation!.installDependencies) {
      await this.sandbox.setPackageAccess(true);
      try {
        const argv =
          this.packageManager === "pnpm"
            ? [
                "pnpm",
                "install",
                "--frozen-lockfile",
                "--ignore-scripts",
                "--config.ignore-pnpmfile=true",
                "--config.manage-package-manager-versions=false",
                "--config.package-manager-strict=false",
                "--config.registry=https://registry.npmjs.org",
              ]
            : this.packageManager === "npm"
              ? [
                  "npm",
                  "ci",
                  "--ignore-scripts",
                  "--no-audit",
                  "--registry=https://registry.npmjs.org",
                ]
              : [
                  "yarn",
                  "install",
                  "--frozen-lockfile",
                  "--ignore-scripts",
                  "--non-interactive",
                  "--registry=https://registry.yarnpkg.com",
                ];
        const result = await this.run(argv, {
          cwd: REPO,
          timeoutMs: this.validationTimeout,
          untrusted: true,
        });
        if (result.exitCode !== 0 || result.truncated || result.timedOut)
          warnings.push(
            "Dependency installation did not complete; validation results may be incomplete.",
          );
      } finally {
        await this.sandbox.setPackageAccess(false);
      }
    }
  }
  private async validate(tool: ToolRequest["tool"], started: number): Promise<ToolResult> {
    const cached = this.validationDone.get(tool);
    if (cached) return cached;
    const validation = this.options.validation;
    const script =
      tool === "runTests"
        ? "test"
        : tool === "runTypecheck"
          ? "typecheck"
          : tool === "runLint"
            ? "lint"
            : "security";
    const enabled =
      tool === "runTests"
        ? validation?.tests
        : tool === "runTypecheck"
          ? validation?.typecheck
          : tool === "runLint"
            ? validation?.lint
            : validation?.security;
    if (
      !this.options.allowValidation ||
      !validation?.enabled ||
      !enabled ||
      !this.packageManager ||
      !this.packageScripts.has(script)
    )
      return {
        tool,
        status: "skipped",
        output:
          "Validation requires service approval, trusted base configuration, one supported lockfile, and a matching package script.",
        truncated: false,
        durationMs: Date.now() - started,
      };
    // No network namespace access to the Sandbox API; read-only root and Git objects.
    // Fail closed when the container runtime does not support unprivileged namespaces.
    const argv = [
      "bwrap",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--unshare-ipc",
      "--unshare-uts",
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      REPO,
      REPO,
      "--tmpfs",
      "/tmp",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--",
      this.packageManager,
      "run",
      script,
    ];
    const result = await this.run(argv, {
      cwd: REPO,
      timeoutMs: this.validationTimeout,
      untrusted: true,
    });
    const value: ToolResult = {
      tool,
      status: result.exitCode === 0 && !result.timedOut && !result.truncated ? "ok" : "failed",
      output: result.output + result.stderr + (result.timedOut ? "\nCOMMAND_TIMEOUT" : ""),
      truncated: result.truncated,
      durationMs: Date.now() - started,
    };
    this.validationDone.set(tool, value);
    return value;
  }
  async destroy(): Promise<void> {
    this.prepared = false;
    await this.sandbox.destroy();
  }
}
