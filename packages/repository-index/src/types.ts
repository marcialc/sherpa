import { z } from "zod";
import { repositoryPathSchema, shaSchema, reviewJobSchema } from "@sherpa/schemas";

export const INDEX_SCHEMA_VERSION = 1;
export const SUMMARY_PROMPT_VERSION = 1;
export const EMBEDDING_MODEL_VERSION = "none";
export const repositoryScopeSchema = z.object({
  installationId: z.number().int().positive().safe(),
  repositoryId: z.number().int().positive().safe(),
});
export type RepositoryScope = z.infer<typeof repositoryScopeSchema>;
export const indexJobSchema = repositoryScopeSchema.extend({
  owner: reviewJobSchema.shape.owner,
  repo: reviewJobSchema.shape.repo,
  commitSha: shaSchema,
  trigger: z.enum(["push", "bootstrap"]),
  deliveryId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
  indexId: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RepositoryIndexJob = z.infer<typeof indexJobSchema>;
export const sourceFileSchema = z.object({
  path: repositoryPathSchema,
  blobSha: shaSchema,
  size: z.number().int().nonnegative().max(1_000_000_000),
});
export type SourceFile = z.infer<typeof sourceFileSchema>;
export interface RepositorySource {
  listFiles(commitSha: string): Promise<SourceFile[]>;
  readFile(commitSha: string, path: string, blobSha: string): Promise<string>;
  isCurrentDefaultRevision(commitSha: string): Promise<boolean>;
}
export const symbolSchema = z.object({
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
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  exported: z.boolean(),
});
export const parsedFileSchema = z.object({
  language: z.enum(["typescript", "javascript"]),
  symbols: z.array(symbolSchema).max(200),
  imports: z.array(z.string().max(300)).max(100),
  exports: z.array(z.string().max(200)).max(200),
  parseIncomplete: z.boolean(),
});
export type ParsedFile = z.infer<typeof parsedFileSchema>;
export const fileSummarySchema = z
  .object({
    summary: z.string().min(1).max(700),
    concepts: z.array(z.string().min(1).max(60)).max(12),
  })
  .strict();
export type FileSummary = z.infer<typeof fileSummarySchema>;
export const indexedFileSchema = sourceFileSchema.extend({
  ...parsedFileSchema.shape,
  ...fileSummarySchema.shape,
  summaryKind: z.enum(["deterministic", "model"]),
});
export type IndexedFile = z.infer<typeof indexedFileSchema>;
export type IndexRevision = RepositoryScope & {
  id: string;
  commitSha: string;
  version: string;
  status: "building" | "ready" | "failed" | "superseded";
  createdAt: number;
  updatedAt: number;
  fileCount: number;
};
export type IndexHit = RepositoryScope & {
  commitSha: string;
  path: string;
  summary: string;
  symbols: z.infer<typeof symbolSchema>[];
  score: number;
  signals: string[];
};
export type IndexContext = {
  authority: "discovery-only";
  status:
    | "exact"
    | "base"
    | "stale"
    | "missing"
    | "building"
    | "failed"
    | "version-mismatch"
    | "unavailable";
  requestedSha: string;
  indexedSha?: string;
  results: IndexHit[];
};
export type IndexQuery = RepositoryScope & {
  headSha: string;
  baseSha: string;
  query: string;
  changedPaths: string[];
  limit?: number;
};
export type IndexTelemetry = (
  event: string,
  fields: Record<string, string | number | boolean>,
) => void;
