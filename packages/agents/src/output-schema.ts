import { z } from "zod";
import { toolRequestSchema } from "@sherpa/schemas";
import { strictToolRequestSchema } from "./investigation";

const cache = new WeakMap<z.ZodType, string>();

/** Describe JSON structure from the validator; refinements/attestation still run locally. */
export function outputSchemaInstruction(schema: z.ZodType): string {
  const cached = cache.get(schema);
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
        anyOf: toolRequestSchema.options.map((option) =>
          z.toJSONSchema(option.strict(), { io: "input", metadata: z.registry() }),
        ),
      };
    },
  });
  const instruction = `OUTPUT JSON SCHEMA
The following schema defines the response structure for this call. Return an instance of it, not the schema itself. Object properties are named keys; required lists the mandatory keys. Follow $ref definitions. Omit unused optional fields. The phase-specific decision rules, tool policy and evidence requirements above also apply and are checked separately.
${JSON.stringify(jsonSchema)}`;
  cache.set(schema, instruction);
  return instruction;
}
