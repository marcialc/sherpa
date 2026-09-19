import { describe, expect, it, vi } from "vitest";
import { ReviewBudget } from "@sherpa/models";
import { repoConfigSchema, type RepositoryTools, type ToolRequest } from "@sherpa/schemas";
import { EvidenceStore } from "./evidence";
import { maxToolLineSpan } from "./investigation";
import { specialistPrompt } from "./prompts";
import type { ReviewDiagnostic } from "./diagnostics";

describe("investigation diagnostics", () => {
  it.each([
    {
      name: "source truncation",
      status: "ok",
      truncated: true,
      output: "private source",
      code: "TOOL_OUTPUT_TRUNCATED",
      sourceTruncated: true,
      contextTruncated: false,
    },
    {
      name: "context limit",
      status: "ok",
      truncated: false,
      output: "secret".repeat(1100),
      code: "TOOL_OUTPUT_TRUNCATED",
      sourceTruncated: false,
      contextTruncated: true,
    },
    {
      name: "missing file",
      status: "failed",
      truncated: false,
      output: "NOT_A_REGULAR_REPOSITORY_FILE",
      code: "NOT_A_REGULAR_REPOSITORY_FILE",
      sourceTruncated: false,
      contextTruncated: false,
    },
    {
      name: "arbitrary command failure",
      status: "failed",
      truncated: false,
      output: "secret-token source code",
      code: "TOOL_FAILED",
      sourceTruncated: false,
      contextTruncated: false,
    },
  ] as const)("identifies $name without logging tool output", async (test) => {
    const tools: RepositoryTools = {
      execute: async (request) => ({
        tool: request.tool,
        status: test.status,
        output: test.output,
        truncated: test.truncated,
        durationMs: 1,
      }),
    };
    const incomplete = vi.fn();
    const events: ReviewDiagnostic[] = [];
    const store = new EvidenceStore(
      tools,
      new ReviewBudget({ maxUsd: 1, maxCalls: 8, deadline: Date.now() + 5000 }, {}),
      repoConfigSchema.parse({}),
      incomplete,
      (event) => events.push(event),
    );
    const record = await store.capture(
      { tool: "readFile", path: "private-module.ts", startLine: 1, endLine: 20 },
      "testing",
      "investigation",
      "testing-0",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "review.tool_completed",
      evidenceId: record.id,
      hypothesisId: "testing-0",
      agent: "testing",
      tool: "readFile",
      code: test.code,
      sourceTruncated: test.sourceTruncated,
      contextTruncated: test.contextTruncated,
      outputBytes: new TextEncoder().encode(test.output).byteLength,
      startLine: 1,
      endLine: 20,
    });
    expect(JSON.stringify(events)).not.toMatch(/secret|private-module|private source/);
    expect(incomplete).toHaveBeenCalledWith("INVESTIGATION_CONTEXT_INCOMPLETE");
  });
  it("distinguishes disabled validation from execution failure and ignores broken log sinks", async () => {
    const tools: RepositoryTools = {
      execute: vi.fn(async () => {
        throw new Error("secret exception");
      }),
    };
    const onDiagnostic = vi.fn();
    const store = new EvidenceStore(
      tools,
      new ReviewBudget({ maxUsd: 1, maxCalls: 8, deadline: Date.now() + 5000 }, {}),
      repoConfigSchema.parse({}),
      vi.fn(),
      onDiagnostic,
    );
    await store.capture({ tool: "runTests" }, "testing", "investigation", "testing-0");
    expect(tools.execute).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped", code: "VALIDATION_DISABLED" }),
    );
    const request: ToolRequest = { tool: "search", query: "secret query" };
    await store.capture(request, "testing", "investigation", "testing-0");
    expect(onDiagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed", code: "TOOL_FAILED" }),
    );
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("secret");
    onDiagnostic.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    await expect(
      store.capture({ tool: "runTests" }, "testing", "investigation", "testing-0"),
    ).resolves.toMatchObject({ result: { status: "skipped" } });
  });

  it("accepts a range at the documented span and refuses one line past it", async () => {
    const tools: RepositoryTools = {
      execute: async (request) => ({
        tool: request.tool,
        status: "ok" as const,
        output: "source",
        truncated: false,
        durationMs: 1,
      }),
    };
    const store = () =>
      new EvidenceStore(
        tools,
        new ReviewBudget({ maxUsd: 1, maxCalls: 8, deadline: Date.now() + 5000 }, {}),
        repoConfigSchema.parse({}),
        vi.fn(),
      );
    const read = (endLine: number) =>
      store().capture(
        { tool: "readFile", path: "a.ts", startLine: 1, endLine },
        "correctness",
        "investigation",
        "correctness-0",
      );
    // The prompt quotes maxToolLineSpan, so the boundary it names has to be the real one:
    // gpt-5.6 lost three reviewers to spans of 105 and 179 against an undocumented limit.
    await expect(read(1 + maxToolLineSpan)).resolves.toMatchObject({ owner: "correctness" });
    await expect(read(2 + maxToolLineSpan)).rejects.toThrow("UNSCOPED_TOOL_REQUEST");
  });

  it.each(["ANALYZE", "VERIFY"] as const)("tells %s the span it must stay within", (phase) => {
    expect(specialistPrompt("correctness", phase)).toContain(`at most ${maxToolLineSpan}`);
  });
});
