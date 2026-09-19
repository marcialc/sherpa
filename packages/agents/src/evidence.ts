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
import { log } from "@sherpa/shared";
import {
  maxToolLineSpan,
  strictToolRequestSchema,
  type EvidenceRecord,
  type Hypothesis,
} from "./investigation";
import { emitDiagnostic, toolDiagnosticCode, type ReviewDiagnostic } from "./diagnostics";

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
    private readonly onDiagnostic?: (event: ReviewDiagnostic) => void,
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
    // A rejection here fails the whole specialist, so record which rule refused it. The
    // tool name, the rule and the span are enough to tell the two causes apart; the path
    // and the output stay out, because repository content does not belong in a log.
    const unscoped = (reason: string, span?: number): never => {
      log("tool_rejected", {
        tool: request.tool,
        reason,
        agent: owner,
        ...(span === undefined ? {} : { span }),
      });
      throw new ProviderError("UNSCOPED_TOOL_REQUEST");
    };
    if (request.tool === "readFile" || request.tool === "gitShow") {
      const startLine = request.startLine ?? 1;
      const endLine = request.endLine ?? startLine + 59;
      if (endLine < startLine) unscoped("inverted_range", endLine - startLine);
      if (endLine - startLine > maxToolLineSpan) unscoped("line_span", endLine - startLine);
      request = { ...request, startLine, endLine };
    }
    if ((request.tool === "gitDiff" || request.tool === "gitLog") && !request.path)
      unscoped("missing_path");
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
    const started = Date.now();
    let outputBytes = 0;
    let sourceTruncated = false;
    let contextTruncated = false;
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
        outputBytes = rawBytes.byteLength;
        sourceTruncated = data.truncated;
        contextTruncated = rawBytes.byteLength > 6000;
        // Keep file/line hits visible when long matching source lines consume the
        // context budget. This is still truncated discovery data, never a quote.
        const discoveryBytes =
          contextTruncated && ["search", "grep", "findReferences"].includes(request.tool)
            ? encoder.encode(
                data.output
                  .split("\n")
                  .map(
                    (row) => /^(?:[a-f0-9]{40}:)?[^\n]+?:\d+:/.exec(row)?.[0] ?? row.slice(0, 120),
                  )
                  .join("\n"),
              )
            : rawBytes;
        const output =
          rawBytes.byteLength > 6000
            ? new TextDecoder().decode(discoveryBytes.slice(0, 6000))
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
        output:
          error instanceof BudgetError
            ? error.code
            : error instanceof ProviderError && error.code === "INVALID_TOOL_RESULT"
              ? error.code
              : "TOOL_FAILED",
        truncated: false,
        durationMs: 0,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const partialDiscovery =
      result.status === "ok" &&
      result.truncated &&
      ["search", "grep", "findReferences"].includes(request.tool);
    // Partial search hits are retrieval hints, never evidence or proof of absence.
    // Completion is checked after the reviewer has had a chance to read those files.
    if ((result.status !== "ok" || result.truncated) && !partialDiscovery)
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
    emitDiagnostic(this.onDiagnostic, {
      event: "review.tool_completed",
      agent: owner,
      hypothesisId,
      evidenceId: record.id,
      purpose,
      tool: request.tool,
      status: result.status,
      code: toolDiagnosticCode(result),
      truncated: result.truncated,
      sourceTruncated,
      contextTruncated,
      outputBytes: outputBytes || encoder.encode(result.output).byteLength,
      retainedBytes: encoder.encode(result.output).byteLength,
      durationMs: Date.now() - started,
      ...("startLine" in request ? { startLine: request.startLine, endLine: request.endLine } : {}),
      ...("revision" in request ? { revision: request.revision } : {}),
      ...(result.fileExists !== undefined ? { fileExists: result.fileExists } : {}),
    });
    return record;
  }

  hasUnresolvedDiscovery(owner: AgentName | "judge"): boolean {
    return this.records.some((record, index) => {
      if (
        record.owner !== owner ||
        !record.result.truncated ||
        record.result.status !== "ok" ||
        !["search", "grep", "findReferences"].includes(record.request.tool)
      )
        return false;
      // A retained hit needs a complete source read from the same reviewer.
      // Verification may reuse its own hypothesis context collected before the search.
      const sources = record.purpose === "discovery" ? this.records.slice(index + 1) : this.records;
      return !sources.some((source) => {
        if (
          source.owner !== owner ||
          (record.purpose !== "discovery" && source.hypothesisId !== record.hypothesisId) ||
          source.result.status !== "ok" ||
          source.result.truncated ||
          source.result.fileExists === false ||
          !(
            source.request.tool === "readFile" ||
            (source.request.tool === "gitShow" && source.request.revision === "head")
          )
        )
          return false;
        const { path, startLine = 1, endLine = startLine + 59 } = source.request;
        return record.result.output.split("\n").some((searchRow) => {
          const hit = searchRow.replace(/^[a-f0-9]{40}:/, "");
          if (!hit.startsWith(`${path}:`)) return false;
          const match = /^(\d+):/.exec(hit.slice(path.length + 1));
          if (!match) return false;
          const line = Number(match[1]);
          return (
            line >= startLine &&
            line <= endLine &&
            source.result.output.split("\n").some((row) => row.startsWith(`${line}: `))
          );
        });
      });
    });
  }

  async surrounding(
    hypothesis: Hypothesis,
    file: ChangedFile,
    owner: AgentName | "judge",
    reserveMs = 0,
  ): Promise<EvidenceRecord[]> {
    const startLine = Math.max(1, (hypothesis.startLine ?? hypothesis.line) - 30);
    const endLine = hypothesis.line + 30;
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
        startLine: Math.max(1, baselineLine - 30),
        endLine: baselineLine + 30,
      },
      owner,
      "baseline",
      hypothesis.id,
      reserveMs,
    );
    return [head, baseline];
  }
}
