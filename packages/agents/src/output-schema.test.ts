import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  analysisResponseSchema,
  judgeInvestigationSchema,
  judgeResponseSchema,
  strictToolRequestSchema,
  verificationResponseSchema,
} from "./investigation";
import { outputSchemaInstruction } from "./output-schema";

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
  it("supplies the required reason and all seven named checks for the production VERIFY failure", () => {
    const root = generated(verificationResponseSchema);
    const assessments = resolve(root, root.properties!.assessments!);
    const assessment = resolve(root, assessments.items!);
    expect(assessment.required).toEqual(["hypothesisId", "decision", "reason"]);
    expect(resolve(root, assessment.properties!.reason!)).toMatchObject({
      type: "string",
      minLength: 8,
      maxLength: 500,
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
    analysisResponseSchema,
    verificationResponseSchema,
    judgeInvestigationSchema,
    judgeResponseSchema,
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
});
