import { describe, expect, it } from "vitest";
import { z } from "zod";
import { structuredOutput } from "@sherpa/models";
import { repoConfigSchema } from "@sherpa/schemas";
import {
  analysisResponseSchema,
  analysisContextSchema,
  judgeInvestigationSchema,
  judgeResponseSchemaFor,
  strictToolRequestSchema,
  verificationResponseSchema,
} from "./investigation";
import {
  constrainEvidenceIds,
  constrainNativeEvidence,
  outputSchemaInstruction,
} from "./output-schema";

type JsonSchema = {
  $ref?: string;
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  [key: string]: unknown;
};
function generated(schema: z.ZodType): JsonSchema {
  return JSON.parse(outputSchemaInstruction(schema).split("\n").at(-1)!);
}
function resolve(root: JsonSchema, value: JsonSchema): JsonSchema {
  if (!value.$ref) return value;
  expect(value.$ref).toMatch(/^#\//);
  let resolved: unknown = root;
  for (const key of value.$ref.slice(2).split("/")) {
    expect(resolved).toBeTypeOf("object");
    resolved = Reflect.get(resolved as object, key);
  }
  expect(resolved).toBeDefined();
  return resolve(root, resolved as JsonSchema);
}

describe("model response schema instructions", () => {
  it("accepts bounded internal explanations of the lengths observed in live failures", () => {
    for (const length of [585, 605, 654, 1500]) {
      expect(
        verificationResponseSchema.safeParse({
          phase: "VERIFY",
          assessments: [
            {
              hypothesisId: "testing-0",
              decision: "rejected",
              reason: "x".repeat(length),
            },
          ],
        }).success,
      ).toBe(true);
    }
    for (const reason of [undefined, "short", "x".repeat(1501)]) {
      expect(
        verificationResponseSchema.safeParse({
          phase: "VERIFY",
          assessments: [
            {
              hypothesisId: "testing-0",
              decision: "rejected",
              reason,
            },
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      analysisResponseSchema.safeParse({
        phase: "ANALYZE",
        hypotheses: [],
        requests: [{ tool: "readFile", path: "src/auth.test.ts" }],
      }).success,
    ).toBe(true);
  });
  it("supplies the required reason and all seven named checks for the production VERIFY failure", () => {
    const root = generated(verificationResponseSchema);
    const assessments = resolve(root, root.properties!.assessments!);
    const assessment = resolve(root, assessments.items!);
    expect(assessment.required).toEqual(["hypothesisId", "decision", "reason"]);
    expect(resolve(root, assessment.properties!.reason!)).toMatchObject({
      type: "string",
      minLength: 8,
      maxLength: 1500,
    });
    const checks = resolve(root, assessment.properties!.checks!);
    expect(checks.type).toBe("object");
    expect(checks.required).toEqual([
      "trigger",
      "actualBehavior",
      "expectedBehavior",
      "impact",
      "causality",
      "disproof",
      "anchor",
    ]);
    expect(Object.keys(checks.properties!)).toEqual(checks.required);
    for (const claim of Object.values(checks.properties!)) {
      const node = resolve(root, claim);
      expect(node.required).toEqual(["statement", "citations"]);
      const citations = resolve(root, node.properties!.citations!);
      expect(citations).toMatchObject({ type: "array", minItems: 1, maxItems: 3 });
      expect(resolve(root, citations.items!).required).toEqual(["evidenceId", "quote"]);
    }
    // The structural schema does not replace decision-specific or attestation checks.
    expect(
      verificationResponseSchema.safeParse({
        phase: "VERIFY",
        assessments: [
          {
            hypothesisId: "security-0",
            decision: "confirmed",
            reason: "A concrete explanation.",
          },
        ],
      }).success,
    ).toBe(false);
  });
  it.each([
    analysisContextSchema,
    analysisResponseSchema,
    verificationResponseSchema,
    judgeInvestigationSchema,
    judgeResponseSchemaFor(["correctness-0"]),
  ])(
    "converts every review phase with bounded instructions and resolvable references",
    (schema) => {
      expect(new TextEncoder().encode(outputSchemaInstruction(schema)).byteLength).toBeLessThan(
        10000,
      );
      const root = generated(schema);
      const visit = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        if ("$ref" in value) resolve(root, value as JsonSchema);
        Object.values(value).forEach(visit);
      };
      visit(root);
      expect(root.type).toBe("object");
      expect(root.additionalProperties).toBe(false);
    },
  );
  it("describes strict tool variants while retaining local tool policy validation", () => {
    const root = generated(z.object({ request: strictToolRequestSchema }).strict());
    const request = resolve(root, root.properties!.request!);
    expect(request.anyOf).toHaveLength(8);
    const readFile = request.anyOf![0]!;
    expect(readFile).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["tool", "path"],
      properties: { tool: { const: "readFile" } },
    });
    expect(strictToolRequestSchema.safeParse({ tool: "readFile", path: "../secret" }).success).toBe(
      false,
    );
    expect(
      strictToolRequestSchema.safeParse({ tool: "readFile", path: "src/app.ts", arguments: {} })
        .success,
    ).toBe(false);
  });
  it("fails on unknown custom validators instead of publishing an unrestricted schema", () => {
    expect(() => outputSchemaInstruction(z.object({ value: z.custom() }))).toThrow();
  });

  it("describes only enabled validation tools without contaminating other policy variants", () => {
    const schema = z.object({ request: strictToolRequestSchema });
    const disabled = repoConfigSchema.parse({ validation: { enabled: false } }).validation;
    const enabled = repoConfigSchema.parse({
      validation: { enabled: true, tests: true, security: true, lint: true, typecheck: true },
    }).validation;
    const disabledText = outputSchemaInstruction(schema, disabled);
    expect(disabledText).toContain('"readFile"');
    expect(disabledText).not.toContain('"runTests"');
    expect(disabledText).not.toContain('"runReproduction"');
    expect(disabledText).not.toContain('"runStaticScan"');
    const enabledText = outputSchemaInstruction(schema, enabled);
    expect(enabledText).toContain('"runTests"');
    expect(enabledText).toContain('"runStaticScan"');
    expect(outputSchemaInstruction(schema, disabled)).toBe(disabledText);
  });

  it("restricts citation IDs without changing candidate IDs or the cached schema", () => {
    const original = generated(verificationResponseSchema);
    const constrained = constrainEvidenceIds(original, ["ev-7", "ev-8"]) as JsonSchema;
    const assessment = resolve(
      constrained,
      resolve(constrained, constrained.properties!.assessments!).items!,
    );
    const checks = resolve(constrained, assessment.properties!.checks!);
    const claim = resolve(constrained, checks.properties!.actualBehavior!);
    const citation = resolve(
      constrained,
      resolve(constrained, claim.properties!.citations!).items!,
    );
    expect(citation.properties!.evidenceId).toEqual({ type: "string", enum: ["ev-7", "ev-8"] });
    expect(resolve(constrained, assessment.properties!.hypothesisId!).enum).toBeUndefined();
    expect(JSON.stringify(original)).not.toContain("ev-7");
  });
  it("pairs exact offered quotes with their evidence IDs without altering source data", () => {
    const schema = z.object({ citation: z.object({ evidenceId: z.string(), quote: z.string() }) });
    const original = generated(schema);
    const constrained = constrainNativeEvidence(original, [
      { id: "ev-1", output: '70:         redirect: "error",\n71:         signal: timeout,' },
      { id: "ev-2", output: '70:         redirect: "manual",' },
    ]);
    const citation = (constrained.schema as JsonSchema).properties!.citation!;
    expect(citation.anyOf).toHaveLength(2);
    expect(citation.anyOf![0]!.properties!.quote!.enum).toEqual([
      "source_line_70",
      "source_line_71",
    ]);
    expect(citation.anyOf![1]!.properties!.quote!.enum).toEqual(["source_line_70"]);
    expect(citation.anyOf![1]!.properties!.evidenceId!.enum).toEqual(["ev-2"]);
    const wire = structuredOutput(constrained.schema);
    expect(
      constrained.normalize(
        wire.normalize({
          citation: { evidenceId: "ev-2", quote: "source_line_70" },
        }),
      ),
    ).toEqual({ citation: { evidenceId: "ev-2", quote: '70:         redirect: "manual",' } });
    expect(
      constrained.normalize({ citation: { evidenceId: "ev-2", quote: "source_line_71" } }),
    ).toEqual({ citation: { evidenceId: "ev-2", quote: "source_line_71" } });
    expect(
      constrained.normalize({ citation: { evidenceId: "invented", quote: "source_line_70" } }),
    ).toEqual({ citation: { evidenceId: "invented", quote: "source_line_70" } });
    expect(JSON.stringify(original)).not.toContain("ev-1");
  });

  it("bounds native quote choices and normalizes single-line hypothesis ranges", () => {
    const original = generated(analysisResponseSchema);
    const constrained = constrainNativeEvidence(original, []);
    const root = constrained.schema as JsonSchema;
    const hypothesis = resolve(root, root.properties!.hypotheses!.items!);
    expect(hypothesis.properties!.startLine).toEqual({ type: "null" });
    const wire = structuredOutput(constrained.schema);
    expect(
      wire.normalize({ phase: "ANALYZE", hypotheses: [{ line: 70, startLine: null }] }),
    ).toEqual({ phase: "ANALYZE", hypotheses: [{ line: 70 }] });
    const large = Array.from({ length: 1000 }, (_, i) => ({
      id: `ev-${i}`,
      output: `${i}: ` + "x".repeat(400),
    }));
    const citations = generated(z.object({ evidenceId: z.string(), quote: z.string() }));
    const verboseSources = Array.from({ length: 4 }, (_, i) => ({
      id: `ev-${i}`,
      output: Array.from({ length: 60 }, (_, line) => `${line + 40}: ${"x".repeat(75)}`).join("\n"),
    }));
    expect(JSON.stringify(verboseSources).length).toBeGreaterThan(16000);
    const compact = constrainNativeEvidence(citations, verboseSources).schema as JsonSchema;
    expect(compact.anyOf![0]!.properties!.quote!.enum).toHaveLength(60);
    expect(constrainNativeEvidence(citations, large).schema).toEqual(citations);
  });
  it("restricts anchor citations to the assigned changed line, not a nearby call", () => {
    const native = constrainNativeEvidence(
      generated(verificationResponseSchema),
      [
        { id: "ev-head", output: '68: response = await fetch(url, {\n70: redirect: "error",' },
        { id: "ev-base", output: '70: redirect: "manual",' },
      ],
      [{ evidenceId: "ev-head", line: 70 }],
    );
    const root = native.schema as JsonSchema;
    const assessment = resolve(root, root.properties!.assessments!.items!);
    const checks = resolve(root, assessment.properties!.checks!);
    const anchor = resolve(root, checks.properties!.anchor!);
    const items = resolve(root, anchor.properties!.citations!).items!;
    expect(items.anyOf).toHaveLength(1);
    expect(items.anyOf![0]!.properties).toEqual({
      evidenceId: { type: "string", enum: ["ev-head"] },
      quote: { type: "string", enum: ["source_line_70"] },
    });
    expect(native.normalize({ evidenceId: "ev-head", quote: "source_line_70" })).toEqual({
      evidenceId: "ev-head",
      quote: '70: redirect: "error",',
    });
    expect(anchor.required).toEqual(["statement", "citations"]);
  });

  it("keeps a one-candidate judge schema below the model input reserve", () => {
    const output = Array.from({ length: 60 }, (_, line) => `${line + 1}: ${"x".repeat(75)}`).join(
      "\n",
    );
    const native = constrainNativeEvidence(
      generated(judgeResponseSchemaFor(["correctness-0"])),
      [
        { id: "head", output, hypothesisId: "correctness-0" },
        { id: "base", output, hypothesisId: "correctness-0" },
        { id: "investigation", output, hypothesisId: "correctness-0" },
      ],
      [{ evidenceId: "head", line: 30 }],
      ["investigation"],
    );
    const wireBytes = new TextEncoder().encode(
      JSON.stringify(structuredOutput(native.schema).schema),
    ).byteLength;
    // Leave more than half of the 65 KB model input bound for prompts and evidence.
    expect(wireBytes).toBeLessThan(30000);
  });

  it("bounds judge schema growth while retaining candidate and citation choices", () => {
    const native = constrainNativeEvidence(
      generated(judgeResponseSchemaFor(["testing-0", "types-0"])),
      [
        { id: "head", output: "70: return changed;", hypothesisId: "testing-0" },
        {
          id: "investigation",
          output: "23: expect(result).toBe(original);",
          hypothesisId: "testing-0",
        },
        { id: "other-head", output: "70: return changed;", hypothesisId: "types-0" },
        { id: "other-investigation", output: "80: catch (error) {}", hypothesisId: "types-0" },
      ],
      [
        { evidenceId: "head", line: 70 },
        { evidenceId: "other-head", line: 70 },
      ],
      ["investigation", "other-investigation"],
    );
    const root = native.schema as JsonSchema;
    // The candidate id is the key, so each candidate's decision is scoped without an anyOf
    // cross-product and no candidateId field survives on the wire.
    const keyed = root.properties!.decisions!.properties!;
    expect(Object.keys(keyed)).toEqual(["testing-0", "types-0"]);
    expect(root.properties!.decisions!.required).toEqual(["testing-0", "types-0"]);
    expect(root.properties!.decisions!.additionalProperties).toBe(false);
    const decision = resolve(root, keyed["testing-0"]!);
    expect(decision.properties!.candidateId).toBeUndefined();
    expect(resolve(root, decision.properties!.verdict!).enum).toEqual([
      "accept",
      "reject",
      "merge",
      "needs-more-context",
    ]);
    const checks = resolve(root, decision.properties!.checks!);
    const disproof = resolve(root, checks.properties!.disproof!);
    expect(
      resolve(root, disproof.properties!.citations!).items!.anyOf![0]!.properties!.evidenceId!.enum,
    ).toEqual(["investigation"]);
    expect(resolve(root, disproof.properties!.citations!).items!.anyOf).toHaveLength(1);
    const actual = resolve(root, checks.properties!.actualBehavior!);
    expect(
      resolve(root, resolve(root, actual.properties!.citations!).items!).anyOf!.map(
        (citation) => citation.properties!.evidenceId!.enum,
      ),
    ).toEqual([["head"], ["investigation"]]);
    const decide = (decisions: Record<string, unknown>) =>
      structuredOutput(native.schema).normalize({ phase: "DECIDE", decisions });
    const rejection = (reason: string) => ({
      verdict: "reject",
      reason,
      checks: null,
      requests: null,
      finalPriority: null,
    });
    const schema = judgeResponseSchemaFor(["testing-0", "types-0"]);
    const both = schema.safeParse(
      decide({
        "testing-0": rejection("The existing test already accepts the new behavior."),
        "types-0": rejection("The narrowed type is still assignable at every caller."),
      }),
    );
    expect(both.success).toBe(true);
    // The key is restored as candidateId for the pipeline.
    expect(both.data!.decisions.map((decision) => decision.candidateId)).toEqual([
      "testing-0",
      "types-0",
    ]);
    // A candidate the judge skipped, and one it invented, are now schema violations.
    expect(
      schema.safeParse(decide({ "testing-0": rejection("Only one candidate answered.") })).success,
    ).toBe(false);
    expect(
      schema.safeParse(
        decide({
          "testing-0": rejection("The existing test already accepts the new behavior."),
          "types-0": rejection("The narrowed type is still assignable at every caller."),
          "ghost-9": rejection("A verdict for an identifier the executor never issued."),
        }),
      ).success,
    ).toBe(false);
  });
});
