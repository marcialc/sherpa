import { z } from "zod";
import type {
  AgentName,
  ChangedFile,
  RepoConfig,
  RepositoryTools,
  ToolRequest,
  ToolResult,
} from "@sherpa/schemas";
import { BudgetError, ProviderError, type ReviewBudget } from "@sherpa/models";
import { strictToolRequestSchema, type EvidenceRecord, type Hypothesis } from "./investigation";

const encoder = new TextEncoder();
const resultSchema = z
  .object({
    tool: z.string(),
    status: z.enum(["ok", "failed", "skipped"]),
    output: z.string(),
    truncated: z.boolean(),
    durationMs: z.number().finite().nonnegative(),
    fileExists: z.boolean().optional(),
  })
  .strict();

export class EvidenceStore {
  readonly records: EvidenceRecord[] = [];
  private attemptedTools = 0;
  constructor(
    private readonly tools: RepositoryTools,
    private readonly budget: ReviewBudget,
    private readonly config: RepoConfig,
    private readonly incomplete: (code: string) => void,
  ) {}

  async capture(
    input: ToolRequest,
    owner: AgentName | "judge",
    purpose: EvidenceRecord["purpose"],
    hypothesisId: string,
    reserveMs = 0,
  ): Promise<EvidenceRecord> {
    let request = strictToolRequestSchema.parse(input);
    if (this.attemptedTools >= 128) throw new BudgetError("REPOSITORY_TOOL_LIMIT");
    this.attemptedTools++;
    this.budget.assertTime();
    const timeoutMs = Math.min(30000, this.budget.remainingMs() - reserveMs);
    if (timeoutMs <= 0) throw new BudgetError("TOOL_TIME_RESERVE");
    if (request.tool === "readFile" || request.tool === "gitShow") {
      const startLine = request.startLine ?? 1;
      const endLine = request.endLine ?? startLine + 59;
      if (endLine < startLine || endLine - startLine >= 100)
        throw new ProviderError("UNSCOPED_TOOL_REQUEST");
      request = { ...request, startLine, endLine };
    }
    if ((request.tool === "gitDiff" || request.tool === "gitLog") && !request.path)
      throw new ProviderError("UNSCOPED_TOOL_REQUEST");
    const validationKey: Record<string, "tests" | "typecheck" | "lint" | "security"> = {
      runTests: "tests",
      runTypecheck: "typecheck",
      runLint: "lint",
      runSecurityScan: "security",
      runStaticScan: "security",
      runReproduction: "tests",
    };
    const policyKey = validationKey[request.tool];
    let result: ToolResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (policyKey && (!this.config.validation.enabled || !this.config.validation[policyKey])) {
        result = {
          tool: request.tool,
          status: "skipped",
          output: "VALIDATION_DISABLED",
          truncated: false,
          durationMs: 0,
        };
      } else {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new BudgetError("TOOL_DEADLINE")), timeoutMs);
        });
        const raw = await Promise.race([this.tools.execute(request), timeout]);
        const parsed = resultSchema.safeParse(raw);
        if (!parsed.success || parsed.data.tool !== request.tool)
          throw new ProviderError("INVALID_TOOL_RESULT");
        const data = parsed.data;
        const rawBytes = encoder.encode(data.output);
        const output =
          rawBytes.byteLength > 6000
            ? new TextDecoder().decode(rawBytes.slice(0, 6000))
            : data.output;
        result = {
          ...data,
          tool: request.tool,
          output,
          truncated: data.truncated || rawBytes.byteLength > 6000,
        };
      }
    } catch (error) {
      result = {
        tool: request.tool,
        status: "failed",
        output: error instanceof BudgetError ? error.code : "TOOL_FAILED",
        truncated: false,
        durationMs: 0,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (result.status !== "ok" || result.truncated)
      this.incomplete("INVESTIGATION_CONTEXT_INCOMPLETE");
    // IDs, ownership, purpose and metadata originate here, outside model control.
    const record: EvidenceRecord = {
      id: `ev-${this.records.length + 1}`,
      hypothesisId,
      owner,
      purpose,
      request,
      result,
    };
    this.records.push(record);
    return record;
  }

  async surrounding(
    hypothesis: Hypothesis,
    file: ChangedFile,
    owner: AgentName | "judge",
    reserveMs = 0,
  ): Promise<EvidenceRecord[]> {
    const startLine = Math.max(1, (hypothesis.startLine ?? hypothesis.line) - 12);
    const endLine = hypothesis.line + 12;
    let baselineLine = hypothesis.line;
    // Account for line shifts at the candidate hunk when choosing the baseline range.
    for (const line of (file.patch ?? "").split("\n")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (
        match &&
        hypothesis.line >= Number(match[3]) &&
        hypothesis.line < Number(match[3]) + Number(match[4] ?? 1)
      ) {
        baselineLine = Math.max(
          1,
          Number(match[1]) +
            Math.min(hypothesis.line - Number(match[3]), Math.max(0, Number(match[2] ?? 1) - 1)),
        );
        break;
      }
    }
    const head = await this.capture(
      { tool: "readFile", path: hypothesis.path, startLine, endLine },
      owner,
      "head",
      hypothesis.id,
      reserveMs,
    );
    const baseline = await this.capture(
      {
        tool: "gitShow",
        path: file.previousPath ?? hypothesis.path,
        revision: "previous",
        startLine: Math.max(1, baselineLine - 12),
        endLine: baselineLine + 12,
      },
      owner,
      "baseline",
      hypothesis.id,
      reserveMs,
    );
    return [head, baseline];
  }
}
