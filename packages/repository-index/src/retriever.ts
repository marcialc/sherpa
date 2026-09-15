import { z } from "zod";
import { repositoryPathSchema, shaSchema } from "@sherpa/schemas";
import { indexConfigSchema, indexVersion, type IndexConfig } from "./config";
import { D1RepositoryIndexStore } from "./store";
import {
  repositoryScopeSchema,
  type IndexedFile,
  type IndexContext,
  type IndexHit,
  type IndexQuery,
  type IndexTelemetry,
} from "./types";
import { termsOf } from "./terms";

const querySchema = repositoryScopeSchema.extend({
  headSha: shaSchema,
  baseSha: shaSchema,
  query: z.string().max(1000),
  changedPaths: z.array(repositoryPathSchema).max(200),
  limit: z.number().int().min(1).max(10).optional(),
});
const directory = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
function rank(file: IndexedFile, query: IndexQuery): { score: number; signals: string[] } {
  const wanted = termsOf(query.query),
    pathWords = termsOf(file.path),
    symbolWords = termsOf(file.symbols.map((s) => s.name).join(" "));
  const summaryWords = termsOf(`${file.summary} ${file.concepts.join(" ")}`),
    imports = termsOf(file.imports.join(" "));
  const score = { score: 0, signals: [] as string[] };
  const add = (points: number, signal: string) => {
    if (points > 0) {
      score.score += points;
      score.signals.push(signal);
    }
  };
  const matched = (words: string[]) => wanted.filter((term) => words.includes(term)).length;
  add(
    file.symbols.some((s) => s.name.toLowerCase() === query.query.trim().toLowerCase()) ? 100 : 0,
    "exact-symbol",
  );
  add(file.path.toLowerCase() === query.query.trim().toLowerCase() ? 90 : 0, "exact-path");
  add(matched(symbolWords) * 15, "symbol");
  add(matched(pathWords) * 12, "path");
  add(matched(summaryWords) * 4, "summary-concept");
  add(matched(imports) * 6, "import");
  const changedTerms = termsOf(
    query.changedPaths.map((path) => path.split("/").pop() ?? path).join(" "),
  );
  add(imports.some((term) => changedTerms.includes(term)) ? 18 : 0, "imports-changed-module");
  if (score.score > 0) {
    add(query.changedPaths.includes(file.path) ? 6 : 0, "changed-file");
    add(
      query.changedPaths.some(
        (path) => directory(path) !== "" && directory(path) === directory(file.path),
      )
        ? 3
        : 0,
      "same-directory",
    );
    add(/(?:^|[/.])(?:test|spec)s?(?:[/.]|$)/i.test(file.path) ? 2 : 0, "related-test");
  }
  return score;
}
export class RepositoryRetriever {
  private readonly config: IndexConfig;
  constructor(
    private readonly store: D1RepositoryIndexStore,
    config: IndexConfig = indexConfigSchema.parse({}),
    private readonly telemetry?: IndexTelemetry,
  ) {
    this.config = indexConfigSchema.parse(config);
  }
  async retrieve(input: IndexQuery): Promise<IndexContext> {
    const started = Date.now();
    let query: IndexQuery;
    const emit = (event: string, fields: Record<string, string | number | boolean>) => {
      try {
        this.telemetry?.(event, fields);
      } catch {
        /* Telemetry is optional. */
      }
    };
    try {
      query = querySchema.parse(input);
      const empty = (status: IndexContext["status"]): IndexContext => ({
        authority: "discovery-only",
        status,
        requestedSha: query.headSha,
        results: [],
      });
      if (!this.config.enabled) return empty("unavailable");
      const version = await indexVersion(this.config);
      const exact = await this.store.findReady(query, query.headSha, version);
      const base = exact ? null : await this.store.findReady(query, query.baseSha, version);
      const active = exact ?? base ?? (await this.store.active(query));
      if (!active) {
        const latest = await this.store.latest(query);
        return empty(
          latest?.status === "building"
            ? "building"
            : latest?.status === "failed"
              ? "failed"
              : "missing",
        );
      }
      if (active.version !== version) return empty("version-mismatch");
      const status: IndexContext["status"] = exact ? "exact" : base ? "base" : "stale";
      const tokens = [
        ...new Set([
          ...termsOf(query.query),
          query.query.trim().toLowerCase(),
          ...termsOf(query.changedPaths.slice(0, 20).join(" ")),
        ]),
      ].slice(0, 40);
      const candidates = await this.store.candidates(active, tokens);
      const results: IndexHit[] = candidates
        // HEAD changes must be investigated from HEAD, never old summaries/ranges.
        .filter((file) => status === "exact" || !query.changedPaths.includes(file.path))
        .map((file) => ({
          ...rank(file, query),
          installationId: query.installationId,
          repositoryId: query.repositoryId,
          commitSha: active.commitSha,
          path: file.path,
          summary: file.summary,
          symbols: [...file.symbols]
            .sort(
              (a, b) =>
                Number(b.name.toLowerCase() === query.query.trim().toLowerCase()) -
                Number(a.name.toLowerCase() === query.query.trim().toLowerCase()),
            )
            .slice(0, 6),
        }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, query.limit ?? this.config.retrievalLimit);
      emit("index.retrieved", {
        installationId: query.installationId,
        repositoryId: query.repositoryId,
        durationMs: Date.now() - started,
        resultCount: results.length,
        stale: status === "stale",
        status,
      });
      return {
        authority: "discovery-only",
        status,
        requestedSha: query.headSha,
        indexedSha: active.commitSha,
        results,
      };
    } catch {
      emit("index.retrieval_failed", {
        durationMs: Date.now() - started,
        code: "INDEX_RETRIEVAL_FAILED",
      });
      return {
        authority: "discovery-only",
        status: "unavailable",
        requestedSha: typeof input.headSha === "string" ? input.headSha : "",
        results: [],
      };
    }
  }
}
