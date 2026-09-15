import { describe, expect, it } from "vitest";
import { z } from "zod";
import { structuredOutput, supportsStructuredOutput } from "./structured-output";

describe("strict structured output", () => {
  it("requires all wire fields and restores only optional nulls before local validation", () => {
    const local = z
      .object({
        required: z.string().min(8),
        optional: z.string().min(8).optional(),
        nested: z.array(
          z.object({ required: z.string(), optional: z.number().optional() }).strict(),
        ),
      })
      .strict();
    const output = structuredOutput(z.toJSONSchema(local));
    expect(output.schema.required).toEqual(["required", "optional", "nested"]);
    expect(
      output.normalize({
        required: "required value",
        optional: null,
        nested: [{ required: "item", optional: null }],
      }),
    ).toEqual({ required: "required value", nested: [{ required: "item" }] });
    expect(
      local.safeParse(output.normalize({ required: null, optional: null, nested: [] })).success,
    ).toBe(false);
    expect(
      local.safeParse(
        output.normalize({ required: "required value", optional: "short", nested: [] }),
      ).success,
    ).toBe(false);
    expect(
      local.safeParse(output.normalize({ required: "required value", nested: [], unknown: null }))
        .success,
    ).toBe(false);
  });

  it("normalizes optional arguments in discriminated tool variants and shared references", () => {
    const request = z.discriminatedUnion("tool", [
      z
        .object({ tool: z.literal("readFile"), path: z.string(), startLine: z.number().optional() })
        .strict(),
      z
        .object({ tool: z.literal("search"), query: z.string(), limit: z.number().optional() })
        .strict(),
    ]);
    const local = z.object({ requests: z.array(request), repeated: request });
    const output = structuredOutput(z.toJSONSchema(local, { reused: "ref" }));
    const value = {
      requests: [{ tool: "readFile", path: "file.ts", startLine: null }],
      repeated: { tool: "search", query: "symbol", limit: null },
    };
    expect(local.parse(output.normalize(value))).toEqual({
      requests: [{ tool: "readFile", path: "file.ts" }],
      repeated: { tool: "search", query: "symbol" },
    });
  });

  it("still rejects a confirmation without mandatory decision evidence", () => {
    const local = z
      .object({
        decision: z.enum(["confirmed", "rejected"]),
        evidence: z.string().min(8).optional(),
      })
      .strict()
      .refine((value) => value.decision !== "confirmed" || Boolean(value.evidence));
    const output = structuredOutput(z.toJSONSchema(local));
    expect(
      local.safeParse(output.normalize({ decision: "confirmed", evidence: null })).success,
    ).toBe(false);
    expect(
      local.safeParse(output.normalize({ decision: "rejected", evidence: null })).success,
    ).toBe(true);
  });

  it("does not enable strict mode for unverified providers or models", () => {
    expect(supportsStructuredOutput({ provider: "cloudflare", model: "openai/gpt-4.1-mini" })).toBe(
      true,
    );
    expect(supportsStructuredOutput({ provider: "openai", model: "gpt-4.1-mini-2025-04-14" })).toBe(
      true,
    );
    expect(
      supportsStructuredOutput({ provider: "cloudflare", model: "anthropic/gpt-4.1-mini" }),
    ).toBe(false);
    expect(supportsStructuredOutput({ provider: "openai", model: "gpt-3.5-turbo" })).toBe(false);
    expect(supportsStructuredOutput({ provider: "cloudflare", model: "openai/gpt-4.1" })).toBe(
      true,
    );
  });
});
