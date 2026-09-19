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

/**
 * Model families asked to enforce the schema by constrained decoding, which is what keeps
 * `constrainNativeEvidence` able to enumerate evidence ids instead of trusting free text.
 * Other gateway providers (anthropic/*, grok/*, @cf/*) are reachable but their
 * response_format handling is unverified here, so they fall back to prompt-instructed JSON.
 *
 * gpt-4.1 is verified: it has served strict schemas through the Chat Completions transport
 * in production. gpt-5 is NOT verified -- it is served by the Responses API, where the
 * schema travels as `text.format` and no live call has yet confirmed that strict is
 * accepted. If it is refused, the failure names `text.format` in the review note and this
 * pattern is the single line to narrow.
 */
const openAiStrict =
  /^gpt-4\.1(?:-mini|-nano)?(?:-2025-04-14)?$|^gpt-5(?:\.[0-9])?(?:-(?:sol|terra|luna|mini|nano))?$/;
/**
 * Workers AI models whose own model card documents response_format, unlike the general
 * JSON-mode model list. Enumerated one at a time: a sibling release does not inherit this.
 */
const workersAiStrict = /^@cf\/moonshotai\/kimi-k2\.6$/;

export function supportsStructuredOutput(ref: ModelRef): boolean {
  if (ref.provider === "cloudflare" && workersAiStrict.test(ref.model)) return true;
  const model = ref.provider === "cloudflare" ? ref.model.replace(/^openai\//, "") : ref.model;
  return (
    (ref.provider === "openai" ||
      (ref.provider === "cloudflare" && ref.model.startsWith("openai/"))) &&
    openAiStrict.test(model)
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
