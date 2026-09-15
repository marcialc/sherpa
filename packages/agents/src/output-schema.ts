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
  records: { id: string; output: string; hypothesisId?: string }[],
  anchors: { evidenceId: string; line: number }[] = [],
  investigationIds: string[] = [],
): { schema: Record<string, unknown>; normalize: (value: unknown) => unknown } {
  const choices = records
    .map((record) => ({
      id: record.id,
      hypothesisId: record.hypothesisId,
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
    choices.length > 0 &&
    new TextEncoder().encode(
      JSON.stringify(
        choices.map(({ id, quotes }) => ({
          id,
          references: quotes.map(({ reference }) => reference),
        })),
      ),
    ).length <= 16000;
  const constrained = structuredClone(schema);
  const anchorChoices = anchors.filter((anchor) =>
    choices.some(
      (record) =>
        record.id === anchor.evidenceId &&
        record.quotes.some((quote) => quote.reference === `source_line_${anchor.line}`),
    ),
  );
  const resolve = (value: Record<string, unknown>): Record<string, unknown> => {
    if (typeof value.$ref !== "string") return value;
    const key = value.$ref.replace(/^#\/\$defs\//, "");
    const definitions = schema.$defs as Record<string, Record<string, unknown>> | undefined;
    if (!definitions?.[key]) throw new Error("Unsupported anchor schema reference");
    return resolve(definitions[key]);
  };
  const scopedRefs = new Map<string, string>();
  const scopedDefinitions: Record<string, Record<string, unknown>> = {};
  const visit = (node: unknown, hypothesisId?: string) => {
    if (!node || typeof node !== "object") return;
    if (hypothesisId && "$ref" in node) {
      const key = `${hypothesisId}:${node.$ref}`;
      const existing = scopedRefs.get(key);
      if (existing) {
        node.$ref = existing;
        return;
      }
      const resolved = structuredClone(resolve(node as Record<string, unknown>));
      const name = `evidence_scope_${scopedRefs.size}`;
      const reference = `#/$defs/${name}`;
      scopedRefs.set(key, reference);
      node.$ref = reference;
      scopedDefinitions[name] = resolved;
      visit(resolved, hypothesisId);
      return;
    }
    const scopedChoices = choices.filter(
      (record) => !hypothesisId || record.hypothesisId === hypothesisId,
    );
    const scopedAnchors = anchorChoices.filter((anchor) =>
      scopedChoices.some((record) => record.id === anchor.evidenceId),
    );
    if ("properties" in node && node.properties && typeof node.properties === "object") {
      const properties = node.properties as Record<string, unknown>;
      if (
        ("decision" in properties && "hypothesisId" in properties) ||
        ("verdict" in properties && "candidateId" in properties)
      ) {
        const judge = "verdict" in properties;
        const original = structuredClone(node) as Record<string, unknown>;
        const ids = [
          ...new Set(
            anchorChoices
              .map(
                (anchor) => choices.find((record) => record.id === anchor.evidenceId)?.hypothesisId,
              )
              .filter((id): id is string => !!id),
          ),
        ];
        const decisions = judge
          ? ["reject", "accept", "merge", "needs-more-context"]
          : ["rejected", "confirmed", "needs-more-context"];
        const variants = (ids.length ? ids : [undefined]).flatMap((id) =>
          decisions.map((decision) => {
            const variant = structuredClone(original);
            const fields = variant.properties as Record<string, unknown>;
            if (id) fields[judge ? "candidateId" : "hypothesisId"] = { type: "string", const: id };
            fields[judge ? "verdict" : "decision"] = { type: "string", const: decision };
            const positive = ["accept", "merge", "confirmed"].includes(decision);
            const required = new Set(variant.required as string[]);
            if (positive)
              for (const key of judge
                ? ["checks", "usefulness", "confidence", "finalSeverity", "finalPriority"]
                : ["checks"])
                required.add(key);
            else
              for (const key of [
                "checks",
                "suggestedFix",
                "usefulness",
                "confidence",
                "finalSeverity",
                "finalPriority",
                "suggestedFixSafe",
                "mergedWith",
              ])
                if (key in fields) fields[key] = { type: "null" };
            if (decision === "needs-more-context") required.add("requests");
            else fields.requests = { type: "null" };
            if (judge && decision === "accept") fields.mergedWith = { type: "null" };
            if (decision === "merge") required.add("mergedWith");
            variant.required = [...required];
            Object.values(fields).forEach((field) => visit(field, id));
            // Establish the explanation before choosing the decision in native decoding.
            variant.properties = { reason: fields.reason, ...fields };
            return variant;
          }),
        );
        const target = node as Record<string, unknown>;
        for (const key of Object.keys(target)) delete target[key];
        target.anyOf = variants;
        return;
      }
      if (
        (scopedAnchors.length || (bounded && investigationIds.length)) &&
        "anchor" in properties &&
        "disproof" in properties
      ) {
        for (const [key, child] of Object.entries(properties))
          if (key !== "anchor" && key !== "disproof") visit(child, hypothesisId);
        const restrict = (name: string, variants: Record<string, unknown>[]) => {
          if (!variants.length) {
            visit(properties[name], hypothesisId);
            return;
          }
          const claim = structuredClone(resolve(properties[name] as Record<string, unknown>));
          const claimProperties = claim.properties as Record<string, Record<string, unknown>>;
          const citations = structuredClone(resolve(claimProperties.citations!));
          citations.items = { anyOf: variants };
          claimProperties.citations = citations;
          properties[name] = claim;
        };
        const citation = (id: string, references: string[]) => ({
          type: "object",
          properties: {
            evidenceId: { type: "string", enum: [id] },
            quote: references.length
              ? { type: "string", enum: references }
              : { type: "string", minLength: 4, maxLength: 500 },
          },
          required: ["evidenceId", "quote"],
          additionalProperties: false,
        });
        restrict(
          "anchor",
          scopedAnchors.map(({ evidenceId, line }) =>
            citation(evidenceId, [`source_line_${line}`]),
          ),
        );
        restrict(
          "disproof",
          scopedChoices
            .filter((record) => investigationIds.includes(record.id))
            .map((record) =>
              citation(record.id, bounded ? record.quotes.map((quote) => quote.reference) : []),
            ),
        );
        return;
      }
      // A finding can always use its primary line; optional wide ranges add no evidence.
      if ("verificationRequests" in properties && "startLine" in properties)
        properties.startLine = { type: "null" };
      if (bounded && "evidenceId" in properties && "quote" in properties) {
        const target = node as Record<string, unknown>;
        for (const key of Object.keys(target)) delete target[key];
        target.anyOf = scopedChoices.map(({ id, quotes }) => ({
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
    Object.values(node).forEach((child) => visit(child, hypothesisId));
  };
  visit(constrained);
  if (Object.keys(scopedDefinitions).length)
    constrained.$defs = { ...(constrained.$defs as Record<string, unknown>), ...scopedDefinitions };
  const normalize = (value: unknown): unknown => {
    if ((!bounded && !anchorChoices.length) || !value || typeof value !== "object") return value;
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
