import { z } from "zod";

export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const repositoryPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (s) =>
      !s.startsWith("/") &&
      !s.includes("\\") &&
      !s.split("/").some((p) => p === ".." || p === ".git" || p === "") &&
      !Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    "Expected a safe repository-relative path",
  );
export const severitySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof severitySchema>;
export const findingPrioritySchema = z.enum(["must_fix", "should_fix", "warning", "nit"]);
export type FindingPriority = z.infer<typeof findingPrioritySchema>;
export type ReviewVerdict = "APPROVED" | "APPROVED_WITH_COMMENTS" | "NOT_APPROVED";
export const categorySchema = z.enum([
  "security",
  "correctness",
  "performance",
  "types",
  "testing",
  "reliability",
  "compatibility",
]);
export const agentNameSchema = z.enum([
  "lightweight",
  "correctness",
  "security",
  "performance",
  "testing",
  "types",
]);
export type AgentName = z.infer<typeof agentNameSchema>;
export const findingSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(2000),
    path: repositoryPathSchema,
    line: z.number().int().positive().optional(),
    startLine: z.number().int().positive().optional(),
    severity: severitySchema,
    priority: findingPrioritySchema,
    category: categorySchema,
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string().min(1).max(1500)).min(1).max(8),
    suggestedFix: z.string().max(2000).optional(),
    originatingAgent: z.string().min(1).max(80),
    relatedSymbols: z.array(z.string().max(200)).max(20).optional(),
  })
  .refine(
    (f) => f.startLine === undefined || (f.line !== undefined && f.startLine <= f.line),
    "Invalid line range",
  );
export type Finding = z.infer<typeof findingSchema>;
export const findingsSchema = z.object({ findings: z.array(findingSchema).max(50) });

export const reviewJobSchema = z.object({
  reviewId: z.string().min(1).max(100),
  deliveryId: z.string().min(1).max(100),
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,100}$/)
    .refine((s) => s !== "." && s !== ".."),
  number: z.number().int().positive(),
  baseSha: shaSchema,
  headSha: shaSchema,
  action: z.enum(["opened", "reopened", "synchronize"]),
});
export type ReviewJob = z.infer<typeof reviewJobSchema>;
export type ChangedFile = {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};
export type PullRequestContext = {
  job: ReviewJob;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "closed";
  files: ChangedFile[];
  filesTruncated: boolean;
  baseSha: string;
  headSha: string;
};
export const modelRefSchema = z.object({
  provider: z.enum(["openai", "anthropic", "moonshot", "cloudflare"]),
  model: z.string().min(1).max(200),
});
export type ModelRef = z.infer<typeof modelRefSchema>;
export type ModelUsage = {
  provider: string;
  model: string;
  agent: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  estimatedUsd?: number;
  durationMs: number;
  failed?: boolean;
};
export type ReviewCost = { totalEstimatedUsd: number; calls: ModelUsage[]; unpricedCalls: number };
export type RiskProfile = { score: number; reasons: string[]; agents: AgentName[]; skip: boolean };
export type ReviewOutcome = "PASS" | "PASS_WITH_FINDINGS" | "NEEDS_ATTENTION" | "REVIEW_FAILED";

export const toolRequestSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("readFile"),
    path: repositoryPathSchema,
    startLine: z.number().int().positive().max(100000).optional(),
    endLine: z.number().int().positive().max(100000).optional(),
  }),
  z.object({
    tool: z.enum(["search", "grep", "findReferences"]),
    query: z.string().min(1).max(200),
  }),
  z.object({ tool: z.literal("gitDiff"), path: repositoryPathSchema.optional() }),
  z.object({
    tool: z.literal("gitShow"),
    path: repositoryPathSchema,
    revision: z.enum(["base", "head", "previous"]),
    startLine: z.number().int().positive().max(100000).optional(),
    endLine: z.number().int().positive().max(100000).optional(),
  }),
  z.object({ tool: z.literal("gitLog"), path: repositoryPathSchema.optional() }),
  z.object({ tool: z.enum(["runTests", "runTypecheck", "runLint", "runSecurityScan"]) }),
  z.object({
    tool: z.literal("runStaticScan"),
    scanner: z.enum(["semgrep", "opengrep", "osv"]),
  }),
  z.object({
    tool: z.literal("runReproduction"),
    language: z.enum(["javascript", "python"]),
    source: z.string().min(1).max(12000),
    hypothesis: z.string().min(1).max(300),
  }),
]);
export type ToolRequest = z.infer<typeof toolRequestSchema>;
export type ToolResult = {
  tool: ToolRequest["tool"];
  status: "ok" | "failed" | "skipped";
  output: string;
  truncated: boolean;
  durationMs: number;
  /** Attested by immutable Git tree membership, never inferred from command stderr. */
  fileExists?: boolean;
};
export interface RepositoryTools {
  execute(request: ToolRequest): Promise<ToolResult>;
}
export type ReviewResult = {
  coverageComplete: boolean;
  outcome: ReviewOutcome;
  findings: Finding[];
  cost: ReviewCost;
  risk: RiskProfile;
  warnings: string[];
  reviewedHeadSha: string;
  incrementalBaseSha: string;
};
