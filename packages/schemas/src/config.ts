import { z } from "zod";
import { parseDocument } from "yaml";
import { agentNameSchema, modelRefSchema, repositoryPathSchema, severitySchema } from "./types";

export const policyPathPatternSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (pattern) =>
      !pattern.startsWith("/") &&
      !pattern.startsWith("!") &&
      !pattern.includes("\\") &&
      !pattern
        .split("/")
        .some((part) => part === ".." || part === "." || part === ".git" || part === "") &&
      !Array.from(pattern).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
    "Expected a repository-relative policy glob using * or **",
  );
export const reviewRuleSchema = z
  .object({
    paths: z.array(policyPathPatternSchema).min(1).max(10),
    agents: z.array(agentNameSchema).min(1).max(6).optional(),
    instructions: z.string().trim().min(1).max(2000),
  })
  .strict();
export type ReviewRule = z.infer<typeof reviewRuleSchema>;
const reviewRulesSchema = z
  .array(reviewRuleSchema)
  .max(20)
  .refine(
    (rules) =>
      rules.reduce(
        (bytes, rule) => bytes + new TextEncoder().encode(rule.instructions).byteLength,
        0,
      ) <= 24576,
    "Reviewer instructions exceed the 24 KiB policy limit",
  );
const instructionFileSchema = z
  .object({
    path: repositoryPathSchema.refine(
      (path) =>
        (path === "AGENTS.md" || path.endsWith("/AGENTS.md")) &&
        path.length <= 200 &&
        !path.includes("*") &&
        !path.split("/").includes("."),
      "Explicit instruction files must be AGENTS.md files without glob characters",
    ),
    agents: z.array(agentNameSchema).min(1).max(6).optional(),
  })
  .strict();

export const findingLimitsSchema = z
  .object({
    shouldFix: z.number().int().min(0).max(30).default(5),
    warnings: z.number().int().min(0).max(30).default(3),
    nits: z.number().int().min(0).max(30).default(3),
  })
  .strict();
export type FindingLimits = z.infer<typeof findingLimitsSchema>;

export const repoConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    reviewRules: reviewRulesSchema.default([]),
    instructionFiles: z.array(instructionFileSchema).max(6).default([]),
    review: z
      .object({
        minimumSeverity: severitySchema.default("info"),
        minimumConfidence: z.number().min(0.5).max(1).default(0.8),
        maxComments: z.number().int().min(0).max(30).default(10),
        reviewDrafts: z.boolean().default(false),
        findingLimits: findingLimitsSchema.default({ shouldFix: 5, warnings: 3, nits: 3 }),
        // Legacy setting is accepted; final priority now always determines the GitHub event.
        blockOnHighSeverity: z.boolean().optional(),
      })
      .default({
        minimumSeverity: "info",
        minimumConfidence: 0.8,
        maxComments: 10,
        reviewDrafts: false,
        findingLimits: { shouldFix: 5, warnings: 3, nits: 3 },
      }),
    agents: z
      .object({
        lightweight: z.boolean().default(true),
        correctness: z.boolean().default(true),
        security: z.boolean().default(true),
        performance: z.boolean().default(true),
        testing: z.boolean().default(true),
        types: z.boolean().default(true),
      })
      .default({
        lightweight: true,
        correctness: true,
        security: true,
        performance: true,
        testing: true,
        types: true,
      }),
    routing: z
      .object({
        paths: z.record(z.string().max(200), z.array(agentNameSchema).max(6)).default({}),
        docsOnly: z.enum(["skip", "lightweight"]).default("skip"),
      })
      .default({ paths: {}, docsOnly: "skip" }),
    models: z
      .object({
        router: modelRefSchema.optional(),
        defaultSpecialist: modelRefSchema.optional(),
        judge: modelRefSchema.optional(),
      })
      .default({}),
    budget: z
      .object({
        // The service controls spend; by default reviews are uncapped by dollars.
        maxUsdPerReview: z.number().positive().default(Number.MAX_VALUE),
        maxAgentCalls: z.number().int().min(1).max(100).default(18),
        maxDurationMs: z.number().int().min(1000).max(1800000).default(600000),
      })
      .default({ maxUsdPerReview: Number.MAX_VALUE, maxAgentCalls: 18, maxDurationMs: 600000 }),
    validation: z
      .object({
        enabled: z.boolean().default(false),
        installDependencies: z.boolean().default(false),
        tests: z.boolean().default(true),
        typecheck: z.boolean().default(true),
        lint: z.boolean().default(true),
        security: z.boolean().default(true),
      })
      .default({
        enabled: false,
        installDependencies: false,
        tests: true,
        typecheck: true,
        lint: true,
        security: true,
      }),
  })
  .strict();
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type ServiceLimits = {
  maxUsd: number;
  maxAgentCalls: number;
  maxDurationMs: number;
  allowValidation: boolean;
  allowedModels?: ModelRef[];
};
type ModelRef = z.infer<typeof modelRefSchema>;
export function parseRepoConfig(content?: string | null): RepoConfig {
  if (!content?.trim()) return repoConfigSchema.parse({});
  if (new TextEncoder().encode(content).byteLength > 32768) throw new Error("CONFIG_TOO_LARGE");
  const doc = parseDocument(content, { uniqueKeys: true });
  if (doc.errors.length) throw new Error("INVALID_REPOSITORY_CONFIG");
  return repoConfigSchema.parse(doc.toJS({ maxAliasCount: 0 }));
}
export function effectiveConfig(config: RepoConfig, limits: ServiceLimits): RepoConfig {
  const result = structuredClone(config);
  result.budget.maxUsdPerReview = Math.min(result.budget.maxUsdPerReview, limits.maxUsd);
  result.budget.maxAgentCalls = Math.min(result.budget.maxAgentCalls, limits.maxAgentCalls);
  result.budget.maxDurationMs = Math.min(result.budget.maxDurationMs, limits.maxDurationMs);
  result.validation.enabled &&= limits.allowValidation;
  for (const key of ["router", "defaultSpecialist", "judge"] as const) {
    const ref = result.models[key];
    if (
      ref &&
      !limits.allowedModels?.some((a) => a.provider === ref.provider && a.model === ref.model)
    )
      delete result.models[key];
  }
  return result;
}
