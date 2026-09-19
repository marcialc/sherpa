import { z } from "zod";
import type { ModelRef } from "@sherpa/schemas";
import { log, registerSecret } from "@sherpa/shared";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
};
export type ModelRequest = {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  outputSchema?: Record<string, unknown>;
  reasoningEffort?: "none" | "low" | "medium" | "high";
};
export type ModelResponse = { text: string; usage: TokenUsage; durationMs: number };
export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResponse>;
  maxRetries?: number;
}
export type ProviderRegistry = Partial<Record<ModelRef["provider"], ModelProvider>>;
export type CloudflareGatewayConfig = {
  accountId: string;
  gatewayId: string;
  apiToken: string;
};
export type ProviderConfig = {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  moonshotApiKey?: string;
  cloudflareGateway?: CloudflareGatewayConfig;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
};

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly retryAfterMs = 0,
    /**
     * The provider's own error identifier and the parameter it named, when the body
     * carries them. A status alone cannot separate an unknown model from a rejected
     * parameter, and the gateway is asked not to collect log payloads, so nothing else
     * keeps this. Identifiers only -- never the error prose, which can quote the
     * request. Stays off `message` so review output keeps rendering the bare code.
     */
    public readonly providerCode = "",
    public readonly param = "",
  ) {
    super(code);
    this.name = "ProviderError";
  }
}

const tokenCount = z.number().int().min(0).max(10_000_000);
const chatResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().max(131072),
          refusal: z.string().nullable().optional(),
        }),
        finish_reason: z.string(),
      }),
    )
    .min(1)
    .max(1),
  usage: z.object({
    prompt_tokens: tokenCount,
    completion_tokens: tokenCount,
    prompt_tokens_details: z.object({ cached_tokens: tokenCount.optional() }).optional(),
    cached_tokens: tokenCount.optional(),
  }),
});
/**
 * Responses API reply. The answer is one entry in `output`, which also carries reasoning
 * entries, so the text is taken from `message` items only -- reading `output[0]` blindly
 * would return a reasoning summary as the review. Token fields are named differently from
 * Chat Completions, and cost accounting reads them, so they are mapped rather than reused.
 */
const responsesResponse = z.object({
  status: z.string().optional(),
  output_text: z.string().max(131072).optional(),
  output: z
    .array(
      z.object({
        type: z.string().optional(),
        content: z
          .array(z.object({ type: z.string().optional(), text: z.string().max(131072).optional() }))
          .max(32)
          .optional(),
      }),
    )
    .max(64),
  usage: z.object({
    input_tokens: tokenCount,
    output_tokens: tokenCount,
    input_tokens_details: z.object({ cached_tokens: tokenCount.optional() }).optional(),
  }),
});
const anthropicResponse = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().max(131072).optional() })).max(32),
  stop_reason: z.string(),
  usage: z.object({
    input_tokens: tokenCount,
    output_tokens: tokenCount,
    cache_read_input_tokens: tokenCount.optional(),
    cache_creation_input_tokens: tokenCount.optional(),
  }),
});

async function boundedJson(response: Response): Promise<unknown> {
  const size = Number(response.headers.get("content-length") ?? 0);
  if (size > 262144) {
    await response.body?.cancel();
    throw new ProviderError("PROVIDER_BODY_TOO_LARGE");
  }
  if (!response.body) throw new ProviderError("PROVIDER_EMPTY_BODY");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 262144) {
        await reader.cancel();
        throw new ProviderError("PROVIDER_BODY_TOO_LARGE");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError("PROVIDER_INVALID_JSON");
    }
  } finally {
    reader.releaseLock();
  }
}

/** Fixed origins keep model and repository text out of credential routing. */
const endpoints = {
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  moonshot: "https://api.moonshot.ai/v1/chat/completions",
} as const;

export const gatewayConfigSchema = z
  .object({
    accountId: z.string().regex(/^[a-f0-9]{32}$/i),
    gatewayId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    apiToken: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict();
/**
 * Identifier-shaped: an enumerated provider error code or a request parameter name.
 * Anything else is dropped rather than truncated, so prose can never reach a log.
 */
const identifier = /^[A-Za-z0-9_.:\-[\]]{1,64}$/;
const providerFailure = z
  .object({
    error: z
      .object({ code: z.unknown().optional(), type: z.unknown().optional(), param: z.unknown() })
      .partial(),
  })
  .partial();

/**
 * Reads the provider's error body for its own error identifier and the parameter it
 * blamed. OpenAI-compatible providers answer a rejected argument with
 * `{ error: { code, param } }`, and `param` is the whole diagnosis: it names the field
 * to change. The prose in `error.message` is deliberately not read -- it can quote the
 * request back, and error bodies never enter logs.
 */
async function readProviderFailure(
  response: Response,
  key: string,
): Promise<{ providerCode: string; param: string }> {
  const empty = { providerCode: "", param: "" };
  try {
    const parsed = providerFailure.safeParse(await boundedJson(response));
    if (!parsed.success) return empty;
    const error = parsed.data.error;
    // An error body is an untrusted echo of our own request, so a value is kept only if
    // it is identifier-shaped and holds no part of the credential we just sent.
    const pick = (value: unknown) =>
      typeof value === "string" && identifier.test(value) && !value.includes(key) ? value : "";
    return { providerCode: pick(error?.code) || pick(error?.type), param: pick(error?.param) };
  } catch {
    return empty;
  }
}

/**
 * Model families served by the Responses API instead of Chat Completions. They are two
 * different endpoints with different field names, so the model name alone decides which
 * request to build: `messages` posted at a Responses model is refused by the gateway
 * before any inference runs, which is how the gpt-5.6 rollout failed with zero tokens
 * billed and a 400 that named no parameter.
 */
function responsesModel(provider: string, model: string): boolean {
  if (provider === "cloudflare")
    return (
      model.startsWith("openai/") &&
      /^gpt-5(?:\.[0-9])?(?:-(?:sol|terra|luna|mini|nano))?$/.test(model.slice(7))
    );
  return (
    provider === "openai" && /^gpt-5(?:\.[0-9])?(?:-(?:sol|terra|luna|mini|nano))?$/.test(model)
  );
}

/** Models that accept reasoning_effort. gpt-4.1 does not, and neither do most Workers AI models. */
function reasoningModel(provider: string, model: string): boolean {
  if (provider === "cloudflare" && /^@cf\/moonshotai\/kimi-k2\.6$/.test(model)) return true;
  const name =
    provider === "cloudflare" ? (model.startsWith("openai/") ? model.slice(7) : "") : model;
  return /^gpt-5(?:\.[0-9])?(?:-(?:sol|terra|luna|mini|nano))?$/.test(name);
}

const gatewayModelPattern =
  /^(?:[a-z][a-z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9._:-]*|@cf\/[a-z][a-z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9._:-]*)$/;

export function createProviderRegistry(config: ProviderConfig): ProviderRegistry {
  const registry: ProviderRegistry = {};
  const send = config.fetch ?? globalThis.fetch;
  const gateway = config.cloudflareGateway;
  if (gateway && !gatewayConfigSchema.safeParse(gateway).success)
    throw new ProviderError("INVALID_CLOUDFLARE_GATEWAY_CONFIG");
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? 45000, 1), 60000);
  for (const name of ["openai", "anthropic", "moonshot", "cloudflare"] as const) {
    const key = name === "cloudflare" ? gateway?.apiToken : config[`${name}ApiKey`];
    if (!key) continue;
    registerSecret(key);
    // The path depends on the model, not just the provider: a Responses model and a Chat
    // Completions model on the same account are two different URLs.
    const endpointFor = (model: string) =>
      name === "cloudflare"
        ? `https://api.cloudflare.com/client/v4/accounts/${gateway!.accountId}/ai/v1/${
            responsesModel(name, model) ? "responses" : "chat/completions"
          }`
        : name === "openai" && responsesModel(name, model)
          ? "https://api.openai.com/v1/responses"
          : endpoints[name];
    registry[name] = {
      maxRetries: Math.max(0, Math.min(config.maxRetries ?? 2, 2)),
      async complete(request) {
        if (
          request.model.length < 1 ||
          request.model.length > 200 ||
          (name === "cloudflare" &&
            (!gatewayModelPattern.test(request.model) || request.model.startsWith("dynamic/"))) ||
          !Number.isInteger(request.maxOutputTokens) ||
          request.maxOutputTokens < 1 ||
          request.maxOutputTokens > 8192
        )
          throw new ProviderError("INVALID_MODEL_REQUEST");
        const useResponses = responsesModel(name, request.model);
        const messages = [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ];
        const body = JSON.stringify(
          name === "anthropic"
            ? {
                model: request.model,
                system: request.system,
                messages: [messages[1]],
                max_tokens: request.maxOutputTokens,
              }
            : useResponses
              ? {
                  model: request.model,
                  instructions: request.system,
                  input: request.user,
                  max_output_tokens: request.maxOutputTokens,
                  text: {
                    format: request.outputSchema
                      ? {
                          type: "json_schema",
                          name: "sherpa_review",
                          strict: true,
                          schema: request.outputSchema,
                        }
                      : { type: "json_object" },
                  },
                  // `reasoning.effort` is deliberately absent. Its accepted values on this
                  // endpoint are unverified, and an unverified value is what broke the last
                  // rollout. Defaulting costs output budget rather than failing the request,
                  // which is the safer of the two until one live call settles the set.
                  store: false,
                  stream: false,
                }
              : {
                  model: request.model,
                  messages,
                  response_format: request.outputSchema
                    ? {
                        type: "json_schema",
                        json_schema: {
                          name: "sherpa_review",
                          strict: true,
                          schema: request.outputSchema,
                        },
                      }
                    : { type: "json_object" },
                  ...(name === "openai" ||
                  (name === "cloudflare" &&
                    (request.model.startsWith("openai/") || request.model.startsWith("@cf/")))
                    ? { max_completion_tokens: request.maxOutputTokens, store: false }
                    : { max_tokens: request.maxOutputTokens }),
                  // Reasoning tokens are drawn from the same completion budget as the answer,
                  // and that budget is capped at 8192. Send an explicit effort so a reasoning
                  // model cannot spend the judge's output allowance before it starts writing.
                  ...(reasoningModel(name, request.model) && request.reasoningEffort
                    ? { reasoning_effort: request.reasoningEffort }
                    : {}),
                  ...(name === "cloudflare" ? { stream: false } : {}),
                },
        );
        if (new TextEncoder().encode(body).byteLength > 131072)
          throw new ProviderError("MODEL_REQUEST_TOO_LARGE");
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (request.signal.aborted) abort();
        request.signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, timeoutMs);
        const started = Date.now();
        try {
          const response = await send(endpointFor(request.model), {
            method: "POST",
            redirect: "manual",
            signal: controller.signal,
            headers:
              name === "cloudflare"
                ? {
                    "content-type": "application/json",
                    authorization: `Bearer ${key}`,
                    "cf-aig-gateway-id": gateway!.gatewayId,
                    "cf-aig-collect-log": "false",
                    "cf-aig-collect-log-payload": "false",
                    "cf-aig-skip-cache": "true",
                    // One gateway attempt; Sherpa reserves and charges every retry.
                    "cf-aig-max-attempts": "1",
                    "cf-aig-request-timeout": String(timeoutMs),
                  }
                : name === "anthropic"
                  ? {
                      "content-type": "application/json",
                      "x-api-key": key,
                      "anthropic-version": "2023-06-01",
                    }
                  : { "content-type": "application/json", authorization: `Bearer ${key}` },
            body,
          });
          if (!response.ok) {
            const retry = response.headers.get("retry-after");
            const retryMs =
              retry && /^\d+(\.\d+)?$/.test(retry)
                ? Number(retry) * 1000
                : retry
                  ? Date.parse(retry) - Date.now()
                  : 0;
            const failure = await readProviderFailure(response, key);
            log("provider_error", {
              code: `PROVIDER_HTTP_${response.status}`,
              model: request.model,
              providerCode: failure.providerCode,
              param: failure.param,
            });
            throw new ProviderError(
              `PROVIDER_HTTP_${response.status}`,
              response.status === 429 || response.status >= 500,
              Number.isFinite(retryMs) ? Math.max(0, retryMs) : 0,
              failure.providerCode,
              failure.param,
            );
          }
          const data = await boundedJson(response);
          if (useResponses) {
            const parsed = responsesResponse.safeParse(data);
            if (!parsed.success) throw new ProviderError("PROVIDER_INVALID_RESPONSE");
            const value = parsed.data;
            if (value.status && value.status !== "completed")
              throw new ProviderError("PROVIDER_INCOMPLETE_RESPONSE", true);
            const text =
              value.output_text ??
              value.output
                .filter((item) => item.type === "message")
                .flatMap((item) => item.content ?? [])
                .map((part) => part.text ?? "")
                .join("");
            if (!text) throw new ProviderError("PROVIDER_INCOMPLETE_RESPONSE", true);
            const cachedTokens = value.usage.input_tokens_details?.cached_tokens ?? 0;
            if (cachedTokens > value.usage.input_tokens)
              throw new ProviderError("PROVIDER_INVALID_USAGE");
            return {
              text,
              usage: {
                inputTokens: value.usage.input_tokens,
                outputTokens: value.usage.output_tokens,
                cachedTokens,
              },
              durationMs: Date.now() - started,
            };
          }
          if (name === "anthropic") {
            const parsed = anthropicResponse.safeParse(data);
            if (!parsed.success) throw new ProviderError("PROVIDER_INVALID_RESPONSE");
            const value = parsed.data;
            if (
              value.stop_reason !== "end_turn" ||
              value.content.some((part) => part.type !== "text" || !part.text)
            )
              throw new ProviderError("PROVIDER_INCOMPLETE_RESPONSE", true);
            const cachedTokens = value.usage.cache_read_input_tokens ?? 0;
            const cacheWriteTokens = value.usage.cache_creation_input_tokens ?? 0;
            return {
              text: value.content.map((part) => part.text).join("\n"),
              usage: {
                inputTokens: value.usage.input_tokens + cachedTokens + cacheWriteTokens,
                outputTokens: value.usage.output_tokens,
                cachedTokens,
                cacheWriteTokens,
              },
              durationMs: Date.now() - started,
            };
          }
          const parsed = chatResponse.safeParse(data);
          if (!parsed.success) throw new ProviderError("PROVIDER_INVALID_RESPONSE");
          const value = parsed.data;
          const choice = value.choices[0]!;
          if (choice.finish_reason !== "stop" || choice.message.refusal)
            throw new ProviderError("PROVIDER_INCOMPLETE_RESPONSE", true);
          const cachedTokens =
            value.usage.prompt_tokens_details?.cached_tokens ?? value.usage.cached_tokens ?? 0;
          if (cachedTokens > value.usage.prompt_tokens)
            throw new ProviderError("PROVIDER_INVALID_USAGE");
          return {
            text: choice.message.content,
            usage: {
              inputTokens: value.usage.prompt_tokens,
              outputTokens: value.usage.completion_tokens,
              cachedTokens,
            },
            durationMs: Date.now() - started,
          };
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          // Provider errors can contain request bodies and credentials. Never expose them.
          throw new ProviderError(
            controller.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_TRANSPORT_FAILED",
          );
        } finally {
          clearTimeout(timer);
          request.signal.removeEventListener("abort", abort);
        }
      },
    };
  }
  return registry;
}
