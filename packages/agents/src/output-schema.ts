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
