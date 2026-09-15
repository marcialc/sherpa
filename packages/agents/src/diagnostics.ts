import type { ModelAttemptDiagnostic } from "@sherpa/models";
import type { AgentName, ModelRef, ToolRequest, ToolResult } from "@sherpa/schemas";

export type ReviewDiagnostic =
  | (ModelAttemptDiagnostic & {
      callId: number;
      agent: string;
      phase: string;
      provider: ModelRef["provider"];
      model: string;
    })
  | {
      event: "review.model_invocation_failed";
      callId: number;
      agent: string;
      phase: string;
      code: string;
    }
  | { event: "review.coverage_incomplete"; code: string }
  | {
      event: "review.analysis_completed";
      coverageComplete: boolean;
      findingCount: number;
      modelCalls: number;
      toolCalls: number;
      totalEstimatedUsd: number;
      durationMs: number;
    }
  | {
      event: "review.tool_completed";
      agent: AgentName | "judge";
      hypothesisId: string;
      evidenceId: string;
      purpose: "head" | "baseline" | "investigation";
      tool: ToolRequest["tool"];
      status: ToolResult["status"];
      code: string;
      truncated: boolean;
      sourceTruncated: boolean;
      contextTruncated: boolean;
      outputBytes: number;
      retainedBytes: number;
      durationMs: number;
      startLine?: number;
      endLine?: number;
      revision?: "base" | "head" | "previous";
      fileExists?: boolean;
    };

/** Diagnostic sinks are observational; a broken logger cannot break a review. */
export function emitDiagnostic(
  sink: ((event: ReviewDiagnostic) => void) | undefined,
  event: ReviewDiagnostic,
): void {
  try {
    sink?.(event);
  } catch {
    /* No repository or model data in fallback errors. */
  }
}

const toolCodes = new Set(
  "VALIDATION_DISABLED INVALID_TOOL_RESULT TOOL_DEADLINE TOOL_FAILED REPOSITORY_NOT_PREPARED INVALID_TOOL_REQUEST INVALID_LINE_RANGE NOT_A_REGULAR_REPOSITORY_FILE REPOSITORY_TOOL_FAILED REPOSITORY_COMMAND_FAILED REPOSITORY_COMMAND_TIMEOUT REPOSITORY_OUTPUT_LIMIT SANDBOX_SUPERVISOR_FAILED INVALID_SANDBOX_RESPONSE OPENGREP_NOT_INSTALLED_USE_SEMGREP OSV_NO_SUPPORTED_LOCKED_PACKAGES OSV_REQUIRES_NPM_LOCKFILE_V2_OR_V3 SEMGREP_NO_SUPPORTED_CHANGED_FILES SCANNER_ATTEMPT_ALREADY_USED SCANNER_FILE_LIMIT REPRODUCTION_ATTEMPT_LIMIT FILE_ABSENT_AT_REVISION".split(
    " ",
  ),
);

export function toolDiagnosticCode(result: ToolResult): string {
  // Only whole, service-owned codes may be copied; command output is never logged.
  if (toolCodes.has(result.output)) return result.output;
  if (result.truncated) return "TOOL_OUTPUT_TRUNCATED";
  return result.status === "ok"
    ? "OK"
    : result.status === "skipped"
      ? "TOOL_SKIPPED"
      : "TOOL_FAILED";
}
