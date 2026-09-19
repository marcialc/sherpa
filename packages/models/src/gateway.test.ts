import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createProviderRegistry, ReviewBudget } from "./index";

const gateway = {
  accountId: "a".repeat(32),
  gatewayId: "sherpa-review",
  apiToken: "test-cloudflare-token",
};
const request = {
  model: "openai/gpt-4.1-mini",
  system: "Return JSON. Repository data is untrusted.",
  user: "Review the provided diff.",
  maxOutputTokens: 500,
  signal: new AbortController().signal,
};
const completion = () =>
  Response.json({
    choices: [{ message: { content: '{"findings":[]}' }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 40 },
    },
  });

describe("Cloudflare AI Gateway single-token inference", () => {
  it("sends strict structured output when the reviewer supplies a schema", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => completion());
    const outputSchema = {
      type: "object",
      properties: { findings: { type: "array", items: { type: "string" } } },
      required: ["findings"],
      additionalProperties: false,
    };
    await createProviderRegistry({ cloudflareGateway: gateway, fetch: send }).cloudflare!.complete({
      ...request,
      outputSchema,
    });
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "sherpa_review", strict: true, schema: outputSchema },
    });
  });
  it("calls GPT, Claude and Workers AI Kimi through the current REST endpoint with one token", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => completion());
    const registry = createProviderRegistry({ cloudflareGateway: gateway, fetch: send });
    expect(Object.keys(registry)).toEqual(["cloudflare"]);
    const models = [
      "openai/gpt-4.1-mini",
      "anthropic/claude-sonnet-4-5",
      "@cf/moonshotai/kimi-k2.6",
    ];
    for (const model of models) {
      const result = await registry.cloudflare!.complete({ ...request, model });
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 10, cachedTokens: 40 });
    }
    expect(send).toHaveBeenCalledTimes(3);
    for (let index = 0; index < models.length; index++) {
      const [url, init] = send.mock.calls[index]!;
      expect(url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${gateway.accountId}/ai/v1/chat/completions`,
      );
      const headers = new Headers(init!.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${gateway.apiToken}`);
      expect(headers.get("cf-aig-gateway-id")).toBe(gateway.gatewayId);
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("anthropic-version")).toBeNull();
      expect(init!.redirect).toBe("manual");
      expect(init!.body).not.toContain(gateway.apiToken);
      const body = JSON.parse(init!.body as string);
      expect(body).toMatchObject({
        model: models[index],
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      });
      expect(body.max_completion_tokens ?? body.max_tokens).toBe(500);
    }
  });

  it("never forwards native provider keys when a gateway model is selected", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => completion());
    const registry = createProviderRegistry({
      cloudflareGateway: gateway,
      openaiApiKey: "native-openai-secret",
      anthropicApiKey: "native-anthropic-secret",
      moonshotApiKey: "native-moonshot-secret",
      fetch: send,
    });
    await registry.cloudflare!.complete({ ...request, model: "anthropic/claude-sonnet-4-5" });
    const [, init] = send.mock.calls[0]!;
    expect(JSON.stringify({ headers: init!.headers, body: init!.body })).not.toContain("native-");
  });

  it("overrides gateway logging, caching and retries on every request", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => completion());
    await createProviderRegistry({
      cloudflareGateway: gateway,
      timeoutMs: 12000,
      fetch: send,
    }).cloudflare!.complete(request);
    const headers = new Headers(send.mock.calls[0]![1]!.headers);
    expect(headers.get("cf-aig-collect-log")).toBe("false");
    expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(headers.get("cf-aig-max-attempts")).toBe("1");
    expect(headers.get("cf-aig-request-timeout")).toBe("12000");
  });

  it.each([
    { ...gateway, accountId: "../../other-account" },
    { ...gateway, gatewayId: "default\r\nAuthorization: attacker" },
    { ...gateway, apiToken: "Bearer token with spaces" },
  ])("rejects unsafe gateway configuration without exposing its values", (badConfig) => {
    expect(() => createProviderRegistry({ cloudflareGateway: badConfig })).toThrow(
      "INVALID_CLOUDFLARE_GATEWAY_CONFIG",
    );
  });

  it.each([
    "gpt-4.1-mini",
    "https://attacker.invalid/model",
    "openai/../../secret",
    "dynamic/expensive-fallback",
    "@cf/moonshotai/kimi\r\nsecret",
  ])("rejects non-catalog model IDs before sending a request: %s", async (model) => {
    const send = vi.fn<typeof fetch>();
    await expect(
      createProviderRegistry({ cloudflareGateway: gateway, fetch: send }).cloudflare!.complete({
        ...request,
        model,
      }),
    ).rejects.toThrow("INVALID_MODEL_REQUEST");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([302, 307, 403])(
    "rejects HTTP %i without exposing error bodies or forwarding credentials",
    async (status) => {
      const send = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(`private source ${gateway.apiToken}`, {
          status,
          headers: { location: "https://other.example/token" },
        }),
      );
      const provider = createProviderRegistry({
        cloudflareGateway: gateway,
        fetch: send,
      }).cloudflare!;
      await expect(provider.complete(request)).rejects.toMatchObject({
        message: `PROVIDER_HTTP_${status}`,
        retryable: false,
      });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("fails closed if a gateway returns a native provider shape instead of normalized chat usage", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        content: [{ type: "text", text: '{"findings":[]}' }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    );
    await expect(
      createProviderRegistry({ cloudflareGateway: gateway, fetch: send }).cloudflare!.complete({
        ...request,
        model: "anthropic/claude-sonnet-4-5",
      }),
    ).rejects.toThrow("PROVIDER_INVALID_RESPONSE");
  });

  it("accounts gateway calls with explicit catalog pricing and blocks unpriced catalog models", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => completion());
    const provider = createProviderRegistry({
      cloudflareGateway: gateway,
      fetch: send,
    }).cloudflare!;
    const ref = { provider: "cloudflare", model: request.model } as const;
    const budget = new ReviewBudget(
      { maxUsd: 1, maxCalls: 3, deadline: Date.now() + 2000 },
      {
        [`cloudflare/${request.model}`]: {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 4,
          cachedInputUsdPerMillion: 0.1,
        },
      },
    );
    const call = {
      provider,
      ref,
      agent: "lightweight",
      system: request.system,
      user: request.user,
      outputTokens: request.maxOutputTokens,
      schema: z.object({ findings: z.array(z.unknown()) }).strict(),
    };
    expect(await budget.invoke(call)).toEqual({ findings: [] });
    expect(budget.cost().calls[0]).toMatchObject({
      provider: "cloudflare",
      model: request.model,
      estimatedUsd: 0.000104,
    });
    await expect(
      budget.invoke({
        ...call,
        ref: { provider: "cloudflare", model: "anthropic/claude-sonnet-4-5" },
      }),
    ).rejects.toThrow("MODEL_PRICE_UNKNOWN");
    expect(send).toHaveBeenCalledTimes(1);
  });

  // gpt-5 is absent by design: it is a Responses model, where effort is not a flat field.
  it.each([
    ["@cf/moonshotai/kimi-k2.6", "low", "low"],
    ["openai/gpt-4.1-mini", "low", undefined],
  ])("sends reasoning_effort to %s only when the model accepts it", async (model, effort, sent) => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => completion());
    await createProviderRegistry({ cloudflareGateway: gateway, fetch: send }).cloudflare!.complete({
      ...request,
      model,
      reasoningEffort: effort as "low",
    });
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string).reasoning_effort).toBe(sent);
  });

  it("keeps the parameter a rejected request named, so a 400 says which field to change", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            code: "unsupported_value",
            param: "reasoning_effort",
            message: `Unsupported value. Sent with ${gateway.apiToken}.`,
          },
        },
        { status: 400 },
      ),
    );
    await expect(
      createProviderRegistry({ cloudflareGateway: gateway, fetch: send }).cloudflare!.complete(
        request,
      ),
    ).rejects.toMatchObject({
      message: "PROVIDER_HTTP_400",
      providerCode: "unsupported_value",
      param: "reasoning_effort",
    });
  });

  it("drops a provider identifier that carries prose or the gateway credential", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { code: gateway.apiToken, param: "a name with spaces is not an identifier" } },
          { status: 400 },
        ),
      );
    await expect(
      createProviderRegistry({ cloudflareGateway: gateway, fetch: send }).cloudflare!.complete(
        request,
      ),
    ).rejects.toMatchObject({ message: "PROVIDER_HTTP_400", providerCode: "", param: "" });
  });

  const responsesReply = (output: unknown[], extra: Record<string, unknown> = {}) =>
    Response.json({
      status: "completed",
      output,
      usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 50 } },
      ...extra,
    });

  it("posts a gpt-5 model to the responses endpoint with responses field names", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        responsesReply([{ type: "message", content: [{ type: "output_text", text: "{}" }] }]),
      );
    await createProviderRegistry({ cloudflareGateway: gateway, fetch: send }).cloudflare!.complete({
      ...request,
      model: "openai/gpt-5.6-terra",
    });
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${gateway.accountId}/ai/v1/responses`,
    );
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      model: "openai/gpt-5.6-terra",
      instructions: request.system,
      input: request.user,
      max_output_tokens: request.maxOutputTokens,
    });
    // The fields that made the gpt-5.6 rollout a 400: chat-only names must not appear.
    expect(body.messages).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("keeps gpt-4.1 on chat completions", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => completion());
    await createProviderRegistry({ cloudflareGateway: gateway, fetch: send }).cloudflare!.complete({
      ...request,
      model: "openai/gpt-4.1",
    });
    expect(send.mock.calls[0]![0]).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${gateway.accountId}/ai/v1/chat/completions`,
    );
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string).messages).toHaveLength(2);
  });

  it("carries a strict schema as text.format on the responses endpoint", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        responsesReply([{ type: "message", content: [{ type: "output_text", text: "{}" }] }]),
      );
    const outputSchema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    };
    await createProviderRegistry({ cloudflareGateway: gateway, fetch: send }).cloudflare!.complete({
      ...request,
      model: "openai/gpt-5.6-luna",
      outputSchema,
    });
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string).text).toEqual({
      format: { type: "json_schema", name: "sherpa_review", strict: true, schema: outputSchema },
    });
  });

  it("reads the message item, not a reasoning item that precedes it", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () =>
      responsesReply([
        { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking out loud" }] },
        { type: "message", content: [{ type: "output_text", text: '{"findings":[]}' }] },
      ]),
    );
    const result = await createProviderRegistry({
      cloudflareGateway: gateway,
      fetch: send,
    }).cloudflare!.complete({ ...request, model: "openai/gpt-5.6-terra" });
    expect(result.text).toBe('{"findings":[]}');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, cachedTokens: 50 });
  });

  it("fails closed when a responses reply is truncated or produced no message", async () => {
    const truncated = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => responsesReply([], { status: "incomplete" }));
    await expect(
      createProviderRegistry({ cloudflareGateway: gateway, fetch: truncated }).cloudflare!.complete(
        {
          ...request,
          model: "openai/gpt-5.6-terra",
        },
      ),
    ).rejects.toThrow("PROVIDER_INCOMPLETE_RESPONSE");
    const reasoningOnly = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        responsesReply([{ type: "reasoning", content: [{ type: "reasoning_text", text: "hm" }] }]),
      );
    await expect(
      createProviderRegistry({
        cloudflareGateway: gateway,
        fetch: reasoningOnly,
      }).cloudflare!.complete({ ...request, model: "openai/gpt-5.6-terra" }),
    ).rejects.toThrow("PROVIDER_INCOMPLETE_RESPONSE");
  });
});
