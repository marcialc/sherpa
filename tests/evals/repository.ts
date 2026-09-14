import type { PullRequestContext, RepositoryTools, ToolRequest, ToolResult } from "@sherpa/schemas";
import { fixtureJob } from "../fixtures/pull-request";
import type { EvalFixture } from "./fixtures";

export function fixtureContext(fixture: EvalFixture): PullRequestContext {
  return {
    job: { ...fixtureJob, reviewId: fixture.id },
    title: fixture.title,
    body: fixture.body,
    draft: false,
    state: "open",
    files: fixture.files,
    filesTruncated: false,
    baseSha: fixtureJob.baseSha,
    headSha: fixtureJob.headSha,
  };
}

/** The model sees only repository data, never the expected bug labels or explanation. */
export function fixtureTools(fixture: EvalFixture): RepositoryTools & { calls: ToolRequest[] } {
  const calls: ToolRequest[] = [];
  return {
    calls,
    execute: async (request): Promise<ToolResult> => {
      calls.push(request);
      const success = (output: string): ToolResult => ({
        tool: request.tool,
        status: "ok",
        output,
        truncated: false,
        durationMs: 0,
      });
      if (request.tool === "readFile" || request.tool === "gitShow") {
        const tree =
          request.tool === "readFile" || request.revision === "head" ? fixture.head : fixture.base;
        const source = tree[request.path];
        if (source === undefined)
          return { ...success("FILE_ABSENT_AT_REVISION"), fileExists: false };
        const start = request.startLine ?? 1;
        const end = request.endLine ?? start + 99;
        return {
          ...success(
            source
              .split("\n")
              .slice(start - 1, end)
              .map((line, i) => `${start + i}: ${line}`)
              .join("\n"),
          ),
          fileExists: true,
        };
      }
      if (
        request.tool === "search" ||
        request.tool === "grep" ||
        request.tool === "findReferences"
      ) {
        const lines = Object.entries(fixture.head).flatMap(([path, source]) =>
          source
            .split("\n")
            .flatMap((line, index) =>
              line.includes(request.query) ? [`${path}:${index + 1}: ${line}`] : [],
            ),
        );
        return success(lines.length ? lines.join("\n") : "NO_MATCHES");
      }
      if (request.tool === "gitDiff")
        return success(
          fixture.files
            .filter((file) => !request.path || file.path === request.path)
            .map((file) => `diff --git a/${file.path} b/${file.path}\n${file.patch}`)
            .join("\n"),
        );
      if (request.tool === "runSecurityScan" || request.tool === "runStaticScan") {
        return success(fixture.scannerOutput ?? "No scanner hypotheses in this recorded fixture.");
      }
      return {
        tool: request.tool,
        status: "skipped",
        output: "FIXTURE_HAS_NO_RECORDED_EXECUTION_EVIDENCE",
        truncated: false,
        durationMs: 0,
      };
    },
  };
}
