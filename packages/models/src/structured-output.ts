import type { ModelRef } from "@sherpa/schemas";

type JsonSchema = {
  type?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  const?: unknown;
  enum?: unknown[];
  [key: string]: unknown;
};

/** Enable only the model family verified through our Cloudflare transport. */
export function supportsStructuredOutput(ref: ModelRef): boolean {
  const model = ref.provider === "cloudflare" ? ref.model.replace(/^openai\//, "") : ref.model;
  return (
    (ref.provider === "openai" ||
      (ref.provider === "cloudflare" && ref.model.startsWith("openai/"))) &&
    /^gpt-4\.1-mini(?:-2025-04-14)?$/.test(model)
  );
}

/** Optional wire fields use null; the original local validator remains authoritative. */
export function structuredOutput(source: Record<string, unknown>): {
  schema: Record<string, unknown>;
  normalize: (value: unknown) => unknown;
} {
  const original = source as JsonSchema;
  const convert = (node: JsonSchema): JsonSchema => {
    if (!node || typeof node !== "object" || Array.isArray(node))
      throw new Error("Unsupported output schema node");
    const result = { ...node };
    delete result.$schema;
    delete result.oneOf;
    if (node.$defs)
      result.$defs = Object.fromEntries(
        Object.entries(node.$defs).map(([key, value]) => [key, convert(value)]),
      );
    if (node.anyOf || node.oneOf) result.anyOf = (node.anyOf ?? node.oneOf)!.map(convert);
    if (node.items) result.items = convert(node.items);
    if (node.properties) {
      result.properties = Object.fromEntries(
        Object.entries(node.properties).map(([key, value]) => [
          key,
          node.required?.includes(key)
            ? convert(value)
            : { anyOf: [convert(value), { type: "null" }] },
        ]),
      );
      result.required = Object.keys(node.properties);
      result.additionalProperties = false;
    }
    return result;
  };
  const resolve = (node: JsonSchema): JsonSchema => {
    if (!node.$ref) return node;
    if (!node.$ref.startsWith("#/$defs/")) throw new Error("Unsupported output schema reference");
    const key = node.$ref.slice(8).replace(/~1/g, "/").replace(/~0/g, "~");
    const definition = original.$defs?.[key];
    if (!definition) throw new Error("Missing output schema definition");
    return resolve(definition);
  };
  const matches = (node: JsonSchema, value: unknown): boolean => {
    node = resolve(node);
    if (node.const !== undefined && node.const !== value) return false;
    if (node.enum && !node.enum.includes(value)) return false;
    if (node.type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      return Object.entries(node.properties ?? {}).every(([key, property]) => {
        const resolved = resolve(property);
        return (
          !node.required?.includes(key) ||
          (resolved.const === undefined && !resolved.enum) ||
          matches(resolved, Reflect.get(value, key))
        );
      });
    }
    return true;
  };
  const normalize = (value: unknown, node: JsonSchema): unknown => {
    node = resolve(node);
    if (node.anyOf || node.oneOf) {
      const variant = (node.anyOf ?? node.oneOf)!.find((variant) => matches(variant, value));
      return variant ? normalize(value, variant) : value;
    }
    if (Array.isArray(value) && node.items)
      return value.map((item) => normalize(item, node.items!));
    if (value && typeof value === "object" && !Array.isArray(value) && node.properties) {
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, child]) => {
          const property = node.properties![key];
          // Never discard an unknown field, required null, or invalid non-null value.
          if (property && child === null && !node.required?.includes(key)) return [];
          return [[key, property ? normalize(child, property) : child]];
        }),
      );
    }
    return value;
  };
  return { schema: convert(original), normalize: (value) => normalize(value, original) };
}
