import { z } from "zod";
import { modelRefSchema } from "@sherpa/schemas";
import { hashText } from "@sherpa/shared";
import { INDEX_SCHEMA_VERSION, SUMMARY_PROMPT_VERSION, EMBEDDING_MODEL_VERSION } from "./types";

export const indexConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: modelRefSchema.default({ provider: "cloudflare", model: "openai/gpt-4.1-mini" }),
  maxFileBytes: z.number().int().min(1024).max(262144).default(131072),
  maxFiles: z.number().int().min(1).max(20000).default(20000),
  excludePaths: z.array(z.string().min(1).max(300)).max(30).default([]),
  summaryLimit: z.number().int().min(0).max(100).default(20),
  maxUsd: z.number().positive().max(10).default(0.25),
  retrievalLimit: z.number().int().min(1).max(10).default(6),
  concurrency: z.number().int().min(1).max(8).default(4),
  maxDurationMs: z.number().int().min(1000).max(840000).default(600000),
  // Embedding transport and vector lifecycle are intentionally not enabled in v1.
  semanticEmbeddings: z.literal(false).default(false),
});
export type IndexConfig = z.infer<typeof indexConfigSchema>;
export function getIndexConfig(env: {
  INDEX_CONFIG_JSON?: unknown;
  INDEX_ENABLED?: unknown;
  INDEX_MODEL?: unknown;
}): IndexConfig {
  const values = env.INDEX_CONFIG_JSON
    ? (JSON.parse(String(env.INDEX_CONFIG_JSON)) as unknown)
    : {};
  const settings = z.record(z.string(), z.unknown()).parse(values);
  return indexConfigSchema.parse({
    ...settings,
    ...(env.INDEX_ENABLED !== undefined ? { enabled: env.INDEX_ENABLED === "true" } : {}),
    model: { provider: "cloudflare", model: String(env.INDEX_MODEL || "openai/gpt-4.1-mini") },
  });
}
export async function indexVersion(config: IndexConfig): Promise<string> {
  return `${INDEX_SCHEMA_VERSION}:${SUMMARY_PROMPT_VERSION}:${EMBEDDING_MODEL_VERSION}:${await hashText(
    JSON.stringify({
      model: config.model,
      maxFileBytes: config.maxFileBytes,
      excludePaths: [...config.excludePaths].sort(),
      summaryEnabled: config.summaryLimit > 0,
    }),
  )}`;
}
