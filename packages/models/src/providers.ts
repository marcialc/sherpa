import { z } from "zod";
import type { ModelRef } from "@sherpa/schemas";

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
    const endpoint =
      name === "cloudflare"
        ? `https://api.cloudflare.com/client/v4/accounts/${gateway!.accountId}/ai/v1/chat/completions`
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
            : {
                model: request.model,
                messages,
                response_format: { type: "json_object" },
                ...(name === "openai" ||
                (name === "cloudflare" &&
                  (request.model.startsWith("openai/") || request.model.startsWith("@cf/")))
                  ? { max_completion_tokens: request.maxOutputTokens, store: false }
                  : { max_tokens: request.maxOutputTokens }),
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
          const response = await send(endpoint, {
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
            await response.body?.cancel();
            throw new ProviderError(
              `PROVIDER_HTTP_${response.status}`,
              response.status === 429 || response.status >= 500,
              Number.isFinite(retryMs) ? Math.max(0, retryMs) : 0,
            );
          }
          const data = await boundedJson(response);
          if (name === "anthropic") {
            const parsed = anthropicResponse.safeParse(data);
            if (!parsed.success) throw new ProviderError("PROVIDER_INVALID_RESPONSE");
            const value = parsed.data;
            if (
              value.stop_reason !== "end_turn" ||
              value.content.some((part) => part.type !== "text" || !part.text)
            )
              throw new ProviderError("PROVIDER_INCOMPLETE_RESPONSE");
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
            throw new ProviderError("PROVIDER_INCOMPLETE_RESPONSE");
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
