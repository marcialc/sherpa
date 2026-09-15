import ignore from "ignore";
import { z } from "zod";
import { indexConfigSchema, indexVersion, type IndexConfig } from "./config";
import { D1RepositoryIndexStore } from "./store";
import { deterministicSummary } from "./summary";
import { isGeneratedSource, parseSource, shouldIndexFile } from "./parser";
import {
  fileSummarySchema,
  indexJobSchema,
  sourceFileSchema,
  type FileSummary,
  type ParsedFile,
  type RepositoryIndexJob,
  type RepositorySource,
  type SourceFile,
  type IndexTelemetry,
} from "./types";

export type IndexBuildResult = {
  status: "ready" | "busy" | "disabled" | "superseded" | "failed";
  filesParsed: number;
  filesReused: number;
  filesSkipped: number;
  summariesGenerated: number;
};
export type IndexerOptions = {
  config: IndexConfig;
  summarize?: (file: SourceFile, parsed: ParsedFile, source: string) => Promise<FileSummary>;
  telemetry?: IndexTelemetry;
};
export class RepositoryIndexer {
  constructor(
    private readonly store: D1RepositoryIndexStore,
    private readonly source: RepositorySource,
    private readonly options: IndexerOptions,
  ) {}
  async build(input: RepositoryIndexJob): Promise<IndexBuildResult> {
    let job = indexJobSchema.parse(input);
    const config = indexConfigSchema.parse(this.options.config),
      started = Date.now();
    const result: IndexBuildResult = {
      status: "failed",
      filesParsed: 0,
      filesReused: 0,
      filesSkipped: 0,
      summariesGenerated: 0,
    };
    const emit = (event: string, fields: Record<string, string | number | boolean>) => {
      try {
        this.options.telemetry?.(event, {
          installationId: job.installationId,
          repositoryId: job.repositoryId,
          ...fields,
        });
      } catch {
        /* Optional telemetry never controls publication. */
      }
    };
    if (!config.enabled) return { ...result, status: "disabled" };
    const version = await indexVersion(config);
    const active = await this.store.active(job);
    if (active?.commitSha === job.commitSha && active.version === version)
      return { ...result, status: "ready", filesReused: active.fileCount };
    if (job.trigger === "bootstrap" && active) {
      if (active.version === version) return { ...result, status: "superseded" };
      // Upgrade the existing immutable revision, never overwrite it with an older PR base.
      job = { ...job, commitSha: active.commitSha };
    }
    const lease = await this.store.begin(job, job.commitSha, version, config.maxDurationMs + 30000);
    if (!lease) return { ...result, status: "busy" };
    // Recheck under the lease: a push may have published after the optimistic active read.
    if (job.trigger === "bootstrap" && lease.previousId !== (active?.id ?? null)) {
      await this.store.finish(lease, "superseded");
      return { ...result, status: "superseded" };
    }
    const assertTime = () => {
      if (Date.now() - started >= config.maxDurationMs) throw new Error("INDEX_DEADLINE");
    };
    let summaryAttempts = 0,
      summaryUnavailable = false;
    try {
      emit("index.started", { mode: active ? "incremental" : "initial" });
      // Git's immutable tree/blob identities are the change set; no compare endpoint truncation.
      const tree = z
        .array(sourceFileSchema)
        .max(20000)
        .parse(await this.source.listFiles(job.commitSha));
      if (
        tree.length > config.maxFiles ||
        new Set(tree.map((file) => file.path)).size !== tree.length
      )
        throw new Error("INDEX_TREE_LIMIT");
      const rules: { directory: string; matcher: ReturnType<typeof ignore> }[] = [];
      const ignoreFiles = tree.filter((file) => /(^|\/)\.gitignore$/.test(file.path));
      if (ignoreFiles.length > 100) throw new Error("INDEX_IGNORE_LIMIT");
      for (const file of ignoreFiles.sort((a, b) => a.path.length - b.path.length)) {
        assertTime();
        if (file.size > 32768) throw new Error("INDEX_IGNORE_LIMIT");
        const contents = await this.source.readFile(job.commitSha, file.path, file.blobSha);
        rules.push({ directory: file.path.slice(0, -10), matcher: ignore().add(contents) });
      }
      const isIgnored = (path: string) => {
        const segments = path.split("/");
        // Git cannot re-include a file beneath an excluded parent directory.
        for (let length = 1; length <= segments.length; length++) {
          const candidate =
            segments.slice(0, length).join("/") + (length < segments.length ? "/" : "");
          let ignored = false;
          for (const rule of rules) {
            if (!candidate.startsWith(rule.directory) || candidate === rule.directory) continue;
            const match = rule.matcher.test(candidate.slice(rule.directory.length));
            if (match.ignored) ignored = true;
            else if (match.unignored) ignored = false;
          }
          if (ignored) return true;
        }
        return false;
      };
      const files = tree.filter((file) => shouldIndexFile(file, config) && !isIgnored(file.path));
      result.filesSkipped = tree.length - files.length;
      let expectedFiles = 0;
      for (let offset = 0; offset < files.length; offset += 50) {
        assertTime();
        const batch = files.slice(offset, offset + 50),
          cache = await this.store.cachedMany(job, batch, version);
        const reusable = batch.filter((file) => {
          const saved = cache.get(file.path);
          return saved?.blobSha === file.blobSha && saved.size === file.size;
        });
        await this.store.reuse(lease, reusable);
        result.filesReused += reusable.length;
        expectedFiles += reusable.length;
        const changed = batch.filter((file) => !reusable.includes(file));
        for (let index = 0; index < changed.length; index += config.concurrency) {
          assertTime();
          const outcomes = await Promise.allSettled(
            changed.slice(index, index + config.concurrency).map(async (file) => {
              const source = await this.source.readFile(job.commitSha, file.path, file.blobSha);
              if (new TextEncoder().encode(source).length !== file.size)
                throw new Error("INDEX_SOURCE_SIZE_MISMATCH");
              if (source.includes("\0") || isGeneratedSource(source)) {
                result.filesSkipped++;
                return;
              }
              const parsed = parseSource(file, source);
              result.filesParsed++;
              let summary = deterministicSummary(file, parsed),
                summaryKind: "model" | "deterministic" = "deterministic";
              if (
                this.options.summarize &&
                !parsed.parseIncomplete &&
                !summaryUnavailable &&
                summaryAttempts < config.summaryLimit
              ) {
                summaryAttempts++;
                try {
                  summary = fileSummarySchema.parse(
                    await this.options.summarize(file, parsed, source),
                  );
                  summaryKind = "model";
                  result.summariesGenerated++;
                } catch {
                  summaryUnavailable = true;
                  emit("index.summary_failed", { code: "INDEX_SUMMARY_FAILED" });
                }
              }
              assertTime();
              await this.store.put(lease, { ...file, ...parsed, ...summary, summaryKind });
              expectedFiles++;
            }),
          );
          // Wait for every in-flight writer before releasing the lease on failure.
          if (outcomes.some((outcome) => outcome.status === "rejected"))
            throw new Error("INDEX_FILE_FAILED");
        }
      }
      assertTime();
      // Late/default-branch webhook deliveries cannot move the active pointer backwards.
      if (job.trigger === "push" && !(await this.source.isCurrentDefaultRevision(job.commitSha))) {
        await this.store.finish(lease, "superseded");
        result.status = "superseded";
      } else {
        if (!(await this.store.publish(lease, expectedFiles)))
          throw new Error("INDEX_PUBLICATION_FENCED");
        result.status = "ready";
      }
      await this.store
        .prune(job)
        .catch(() => emit("index.cleanup_failed", { code: "INDEX_CLEANUP_FAILED" }));
      emit("index.completed", {
        mode: active ? "incremental" : "initial",
        durationMs: Date.now() - started,
        ...result,
        summaryAttempts,
        embeddingOperations: 0,
      });
      return result;
    } catch {
      await this.store.finish(lease, "failed").catch(() => undefined);
      emit("index.failed", {
        durationMs: Date.now() - started,
        code: "INDEX_BUILD_FAILED",
        ...result,
      });
      return result;
    }
  }
}
