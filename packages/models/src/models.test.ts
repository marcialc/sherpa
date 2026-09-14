import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createProviderRegistry,
  ProviderError,
  ReviewBudget,
  estimateUsageUsd,
  type ModelProvider,
  type ModelResponse,
  type PricingTable,
} from "./index";

const response = (text = '{"ok":true}'): ModelResponse => ({
  text,
  usage: { inputTokens: 100, outputTokens: 10 },
  durationMs: 1,
});
const ref = { provider: "openai", model: "test-model" } as const;
const pricing: PricingTable = {
  "openai/test-model": {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.1,
  },
};
const args = {
  ref,
  agent: "test",
  system: "Return JSON.",
  user: "Untrusted data.",
  outputTokens: 100,
  schema: z.object({ ok: z.boolean() }).strict(),
};
const request = {
  model: "test-model",
  system: "Return JSON.",
  user: "data",
  maxOutputTokens: 100,
  signal: new AbortController().signal,
};
function chat(content = '{"ok":true}') {
  return {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 40 },
    },
  };
}

describe("provider trust and protocol boundaries", () => {
  it("uses a fixed OpenAI origin, preserves role separation and accounts cached usage", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(chat()));
    const providers = createProviderRegistry({ openaiApiKey: "secret-key", fetch: send });
    const result = await providers.openai!.complete(request);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 10, cachedTokens: 40 });
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      store: false,
      max_completion_tokens: 100,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: "data" },
      ],
    });
  });
  it("adds Anthropic cache reads and writes to total input usage", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        content: [{ type: "text", text: '{"ok":true}' }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 20,
          output_tokens: 4,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 30,
        },
      }),
    );
    const provider = createProviderRegistry({ anthropicApiKey: "secret", fetch: send }).anthropic!;
    expect((await provider.complete(request)).usage).toEqual({
      inputTokens: 100,
      outputTokens: 4,
      cachedTokens: 50,
      cacheWriteTokens: 30,
    });
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toMatchObject({
      system: request.system,
      messages: [{ role: "user" }],
      max_tokens: 100,
    });
  });
  it("supports Moonshot JSON mode and its output bound", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(chat()));
    await createProviderRegistry({ moonshotApiKey: "secret", fetch: send }).moonshot!.complete(
      request,
    );
    expect(send.mock.calls[0]![0]).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toMatchObject({
      max_tokens: 100,
      response_format: { type: "json_object" },
    });
  });
  it("never exposes raw provider error bodies or retries authentication failures", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret-key private repository source", { status: 401 }));
    const provider = createProviderRegistry({ openaiApiKey: "secret-key", fetch: send }).openai!;
    await expect(provider.complete(request)).rejects.toMatchObject({
      message: "PROVIDER_HTTP_401",
      retryable: false,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      payload: { ...chat(), usage: { prompt_tokens: -1, completion_tokens: 10 } },
      error: "PROVIDER_INVALID_RESPONSE",
    },
    {
      payload: { ...chat(), choices: [{ message: { content: "{}" }, finish_reason: "length" }] },
      error: "PROVIDER_INCOMPLETE_RESPONSE",
    },
    {
      payload: { ...chat(), usage: { prompt_tokens: 1, completion_tokens: 10, cached_tokens: 2 } },
      error: "PROVIDER_INVALID_USAGE",
    },
  ])("rejects malformed or incomplete external data ($error)", async ({ payload, error }) => {
    const provider = createProviderRegistry({
      openaiApiKey: "secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)),
    }).openai!;
    await expect(provider.complete(request)).rejects.toThrow(error);
  });
  it("caps bodies even when content-length is omitted", async () => {
    const provider = createProviderRegistry({
      openaiApiKey: "secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(270000))),
    }).openai!;
    await expect(provider.complete(request)).rejects.toThrow("PROVIDER_BODY_TOO_LARGE");
  });
});

describe("shared budget reservations", () => {
  it("charges cached and cache-write tokens with configured prices", () => {
    expect(
      estimateUsageUsd(
        { inputTokens: 1000, outputTokens: 100, cachedTokens: 400, cacheWriteTokens: 100 },
        {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 4,
          cachedInputUsdPerMillion: 0.1,
          cacheWriteInputUsdPerMillion: 1.25,
        },
      ),
    ).toBeCloseTo(0.001065);
    expect(() =>
      estimateUsageUsd(
        { inputTokens: 10, outputTokens: 1, cacheWriteTokens: 1 },
        pricing["openai/test-model"]!,
      ),
    ).toThrow("MISSING_CACHE_WRITE_PRICE");
  });
  it("blocks unpriced models before making a request", async () => {
    const provider = { complete: vi.fn().mockResolvedValue(response()) };
    const budget = new ReviewBudget({ maxUsd: 1, maxCalls: 4, deadline: Date.now() + 1000 }, {});
    await expect(budget.invoke({ ...args, provider })).rejects.toThrow("MODEL_PRICE_UNKNOWN");
    expect(provider.complete).not.toHaveBeenCalled();
  });
  it("reserves concurrent cost and protects the final judge call", async () => {
    let release!: (response: ModelResponse) => void;
    const provider = {
      complete: vi.fn().mockReturnValue(
        new Promise<ModelResponse>((resolve) => {
          release = resolve;
        }),
      ),
    };
    const budget = new ReviewBudget(
      { maxUsd: 0.002, maxCalls: 5, deadline: Date.now() + 10000 },
      pricing,
    );
    const running = budget.invoke({ ...args, provider });
    await expect(budget.invoke({ ...args, provider })).rejects.toThrow("MODEL_COST_LIMIT");
    release(response());
    await running;
    const callBudget = new ReviewBudget(
      { maxUsd: 1, maxCalls: 1, deadline: Date.now() + 1000 },
      pricing,
    );
    await expect(
      callBudget.invoke({ ...args, provider, preserve: { calls: 1, usd: 0 } }),
    ).rejects.toThrow("MODEL_CALL_LIMIT");
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });
  it("counts and conservatively charges each rate-limit retry", async () => {
    const provider: ModelProvider = {
      maxRetries: 2,
      complete: vi
        .fn()
        .mockRejectedValueOnce(new ProviderError("PROVIDER_HTTP_429", true))
        .mockResolvedValue(response()),
    };
    const budget = new ReviewBudget(
      { maxUsd: 1, maxCalls: 3, deadline: Date.now() + 5000 },
      pricing,
    );
    expect(await budget.invoke({ ...args, provider })).toEqual({ ok: true });
    expect(budget.cost().calls).toHaveLength(2);
    expect(budget.cost().calls[0]!.failed).toBe(true);
    expect(budget.cost().totalEstimatedUsd).toBeGreaterThan(0.001);
  });
  it("does not retry a transport failure with ambiguous consumption", async () => {
    const provider: ModelProvider = {
      maxRetries: 2,
      complete: vi.fn().mockRejectedValue(new ProviderError("PROVIDER_TRANSPORT_FAILED")),
    };
    const budget = new ReviewBudget(
      { maxUsd: 1, maxCalls: 3, deadline: Date.now() + 5000 },
      pricing,
    );
    await expect(budget.invoke({ ...args, provider })).rejects.toThrow("PROVIDER_TRANSPORT_FAILED");
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(budget.cost().totalEstimatedUsd).toBeGreaterThan(0);
  });
  it("rejects malformed model JSON without losing billed usage", async () => {
    const provider = { complete: vi.fn().mockResolvedValue(response("{bad}")) };
    const budget = new ReviewBudget(
      { maxUsd: 1, maxCalls: 3, deadline: Date.now() + 1000 },
      pricing,
    );
    await expect(budget.invoke({ ...args, provider })).rejects.toThrow("MODEL_INVALID_JSON");
    expect(budget.cost().calls).toHaveLength(1);
    expect(budget.cost().calls[0]!.inputTokens).toBe(100);
  });
  it("enforces deadlines even when an adapter ignores the abort signal", async () => {
    const provider = { complete: vi.fn().mockReturnValue(new Promise(() => {})) };
    const budget = new ReviewBudget({ maxUsd: 1, maxCalls: 3, deadline: Date.now() + 20 }, pricing);
    await expect(budget.invoke({ ...args, provider })).rejects.toThrow("PROVIDER_TIMEOUT");
    expect(budget.cost().calls[0]!.failed).toBe(true);
  });
  it("closes spending if billed usage exceeds its conservative reservation", async () => {
    const provider = {
      complete: vi
        .fn()
        .mockResolvedValue({ ...response(), usage: { inputTokens: 100000, outputTokens: 1 } }),
    };
    const budget = new ReviewBudget(
      { maxUsd: 1, maxCalls: 3, deadline: Date.now() + 1000 },
      pricing,
    );
    await expect(budget.invoke({ ...args, provider })).rejects.toThrow(
      "BUDGET_ACCOUNTING_UNCERTAIN",
    );
    await expect(budget.invoke({ ...args, provider })).rejects.toThrow(
      "BUDGET_ACCOUNTING_UNCERTAIN",
    );
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });
  it("protects judge execution time and rejects invalid reservation bounds", async () => {
    const provider = { complete: vi.fn().mockResolvedValue(response()) };
    const budget = new ReviewBudget(
      { maxUsd: 1, maxCalls: 3, deadline: Date.now() + 100 },
      pricing,
    );
    await expect(
      budget.invoke({ ...args, provider, preserve: { usd: 0, calls: 0, ms: 200 } }),
    ).rejects.toThrow("MODEL_TIME_RESERVE");
    await expect(budget.invoke({ ...args, provider, outputTokens: -1 })).rejects.toThrow(
      "INVALID_TOKEN_BOUND",
    );
    await expect(
      budget.invoke({ ...args, provider, preserve: { usd: -1, calls: 0 } }),
    ).rejects.toThrow("INVALID_BUDGET_RESERVE");
    expect(provider.complete).not.toHaveBeenCalled();
  });
});
