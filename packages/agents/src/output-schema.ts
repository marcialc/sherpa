import { z } from "zod";
import { toolRequestSchema, type RepoConfig } from "@sherpa/schemas";
import { strictToolRequestSchema } from "./investigation";

const cache = new WeakMap<z.ZodType, Map<string, string>>();

/** Citation choices may only name successful evidence collected by this reviewer. */
export function constrainEvidenceIds(
  schema: Record<string, unknown>,
  ids: string[],
): Record<string, unknown> {
  const constrained = structuredClone(schema);
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (
      "properties" in node &&
      node.properties &&
      typeof node.properties === "object" &&
      "evidenceId" in node.properties &&
      "quote" in node.properties
    )
      node.properties.evidenceId = { type: "string", enum: ids };
    Object.values(node).forEach(visit);
  };
  visit(constrained);
  return constrained;
}

export function disabledValidationTools(policy?: RepoConfig["validation"]): Set<string> {
  if (!policy) return new Set();
  return new Set(
    Object.entries({
      runTests: "tests",
      runReproduction: "tests",
      runTypecheck: "typecheck",
      runLint: "lint",
      runSecurityScan: "security",
      runStaticScan: "security",
    })
      .filter(
        ([, key]) => !policy.enabled || !policy[key as "tests" | "typecheck" | "lint" | "security"],
      )
      .map(([tool]) => tool),
  );
}

/** Describe JSON structure from the validator; refinements/attestation still run locally. */
export function outputSchemaInstruction(
  schema: z.ZodType,
  policy?: RepoConfig["validation"],
): string {
  const disabled = disabledValidationTools(policy);
  const key = [...disabled].join(",");
  const variants = cache.get(schema) ?? new Map<string, string>();
  const cached = variants.get(key);
  if (cached) return cached;
  const jsonSchema = z.toJSONSchema(schema, {
    io: "input",
    reused: "ref",
    metadata: z.registry(),
    unrepresentable: ({ zodSchema }) => {
      // This custom validator accepts exactly the strict variants of the shared tool union.
      // Never replace an unknown custom validator with an unrestricted schema.
      if (zodSchema !== strictToolRequestSchema.in) return "throw";
      return {
        anyOf: toolRequestSchema.options.flatMap((option) => {
          const variant = z.toJSONSchema(option.strict(), { io: "input", metadata: z.registry() });
          const tool = variant.properties!.tool!;
          if (typeof tool !== "object") throw new Error("Tool discriminator must be an object");
          if (typeof tool.const === "string" && disabled.has(tool.const)) return [];
          if (tool.enum) {
            tool.enum = tool.enum.filter((name) => typeof name === "string" && !disabled.has(name));
            if (!tool.enum.length) return [];
          }
          return [variant];
        }),
      };
    },
  });
  const instruction = `OUTPUT JSON SCHEMA
The following schema defines the response structure for this call. Return an instance of it, not the schema itself. Object properties are named keys; required lists the mandatory keys. Follow $ref definitions. Omit unused optional fields. The phase-specific decision rules, tool policy and evidence requirements above also apply and are checked separately.
${JSON.stringify(jsonSchema)}`;
  variants.set(key, instruction);
  cache.set(schema, variants);
  return instruction;
}

/** Models select line references; only the executor turns them into exact quotes. */
export function constrainNativeEvidence(
  schema: Record<string, unknown>,
  records: { id: string; output: string }[],
): { schema: Record<string, unknown>; normalize: (value: unknown) => unknown } {
  const choices = records
    .map((record) => ({
      id: record.id,
      quotes: record.output
        .split("\n")
        .map((line, index) => ({
          reference: /^\d+: /.test(line)
            ? `source_line_${line.slice(0, line.indexOf(":"))}`
            : `output_row_${index + 1}`,
          text: line.trim(),
        }))
        .filter(({ text }) => text.length >= 4 && text.length <= 500),
    }))
    .filter((record) => record.quotes.length);
  // Bound native schema size; other outputs retain ID constraints and exact validation.
  const bounded =
    choices.length > 0 && new TextEncoder().encode(JSON.stringify(choices)).length <= 16000;
  const constrained = structuredClone(schema);
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if ("properties" in node && node.properties && typeof node.properties === "object") {
      const properties = node.properties as Record<string, unknown>;
      // A finding can always use its primary line; optional wide ranges add no evidence.
      if ("verificationRequests" in properties && "startLine" in properties)
        properties.startLine = { type: "null" };
      if (bounded && "evidenceId" in properties && "quote" in properties) {
        const target = node as Record<string, unknown>;
        for (const key of Object.keys(target)) delete target[key];
        target.anyOf = choices.map(({ id, quotes }) => ({
          type: "object",
          properties: {
            evidenceId: { type: "string", enum: [id] },
            quote: { type: "string", enum: quotes.map(({ reference }) => reference) },
          },
          required: ["evidenceId", "quote"],
          additionalProperties: false,
        }));
        return;
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(constrained);
  const normalize = (value: unknown): unknown => {
    if (!bounded || !value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(normalize);
    if ("evidenceId" in value && "quote" in value) {
      const record = choices.find((record) => record.id === value.evidenceId);
      const quote = record?.quotes.find((quote) => quote.reference === value.quote);
      // Unknown IDs/references remain untouched so local validation can reject them.
      if (quote) return { ...value, quote: quote.text };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
  };
  return { schema: constrained, normalize };
}
