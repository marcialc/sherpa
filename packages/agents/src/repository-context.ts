import { z } from "zod";
import { repositoryPathSchema, shaSchema } from "@sherpa/schemas";
import type { IndexContext, IndexQuery } from "@sherpa/repository-index";
import { emitDiagnostic, type ReviewDiagnostic } from "./diagnostics";

const hitSchema = z.object({
  installationId: z.number().int().positive().safe(),
  repositoryId: z.number().int().positive().safe(),
  commitSha: shaSchema,
  path: repositoryPathSchema,
  summary: z.string().max(700),
  symbols: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        kind: z.enum([
          "class",
          "function",
          "method",
          "interface",
          "type",
          "constant",
          "variable",
          "enum",
          "namespace",
        ]),
        startLine: z.number().int().positive().safe(),
        endLine: z.number().int().positive().safe(),
        exported: z.boolean(),
      }),
    )
    .max(200),
  score: z.number().finite(),
  signals: z.array(z.string().max(100)).max(20),
});
const contextSchema = z.object({
  authority: z.literal("discovery-only"),
  status: z.enum([
    "exact",
    "base",
    "stale",
    "missing",
    "building",
    "failed",
    "version-mismatch",
    "unavailable",
  ]),
  requestedSha: shaSchema,
  indexedSha: shaSchema.optional(),
  results: z.array(hitSchema).max(20),
});

export type RetrieveRepositoryContext = (query: IndexQuery) => Promise<IndexContext>;

/** This separate channel cannot create tool results or executor-owned evidence IDs. */
export async function retrieveDiscoveryContext(
  retrieve: RetrieveRepositoryContext,
  query: IndexQuery,
  onDiagnostic?: (event: ReviewDiagnostic) => void,
  timeoutMs = 1500,
): Promise<IndexContext | undefined> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => retrieve(query)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("INDEX_RETRIEVAL_TIMEOUT")), timeoutMs);
      }),
    ]);
    const parsed = contextSchema.parse(raw);
    if (
      parsed.requestedSha !== query.headSha ||
      (parsed.status === "exact" && parsed.indexedSha !== query.headSha) ||
      (parsed.status === "base" && parsed.indexedSha !== query.baseSha) ||
      parsed.results.some(
        (hit) =>
          hit.installationId !== query.installationId ||
          hit.repositoryId !== query.repositoryId ||
          hit.commitSha !== parsed.indexedSha ||
          hit.symbols.some((symbol) => symbol.endLine < symbol.startLine),
      )
    )
      throw new Error("INVALID_INDEX_CONTEXT");
    const context: IndexContext = { ...parsed, results: [] };
    const changed = new Set(query.changedPaths);
    if (["exact", "base", "stale"].includes(parsed.status)) {
      for (const hit of parsed.results) {
        if (context.results.length >= (query.limit ?? 6)) break;
        if (parsed.status !== "exact" && changed.has(hit.path)) continue;
        const bounded = {
          ...hit,
          summary: hit.summary.slice(0, 450),
          symbols: hit.symbols.slice(0, 4),
        };
        if (
          new TextEncoder().encode(
            JSON.stringify({ ...context, results: [...context.results, bounded] }),
          ).byteLength > 3072
        )
          continue;
        context.results.push(bounded);
      }
    }
    emitDiagnostic(onDiagnostic, {
      event: "review.index_retrieved",
      status: context.status,
      resultCount: context.results.length,
      durationMs: Date.now() - started,
    });
    if (context.results.length && context.status !== "exact")
      emitDiagnostic(onDiagnostic, {
        event: "review.index_stale_used",
        status: context.status,
        resultCount: context.results.length,
      });
    return context;
  } catch {
    emitDiagnostic(onDiagnostic, {
      event: "review.index_retrieval_failed",
      code: "INDEX_CONTEXT_UNAVAILABLE",
      durationMs: Date.now() - started,
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
