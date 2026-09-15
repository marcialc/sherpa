import { z } from "zod";
import type { ModelRef, ModelUsage, ReviewCost } from "@sherpa/schemas";
import {
  ProviderError,
  type ModelProvider,
  type ModelResponse,
  type TokenUsage,
} from "./providers";
import {
  outputRepairInstruction,
  schemaDiagnostic,
  type OutputDiagnostic,
  type ModelAttemptDiagnostic,
} from "./output";

export type ModelPrice = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  cacheWriteInputUsdPerMillion?: number;
};
export type PricingTable = Record<string, ModelPrice>;
export type BudgetLimits = { maxUsd: number; maxCalls: number; deadline: number };
export type BudgetReserve = { usd: number; calls: number; ms?: number };
type Ticket = {
  ref: ModelRef;
  agent: string;
  usd: number;
  inputBound: number;
  outputBound: number;
  started: number;
};

export class BudgetError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "BudgetError";
  }
}
const rateSchema = z
  .object({
    inputUsdPerMillion: z.number().finite().nonnegative(),
    outputUsdPerMillion: z.number().finite().nonnegative(),
    cachedInputUsdPerMillion: z.number().finite().nonnegative().optional(),
    cacheWriteInputUsdPerMillion: z.number().finite().nonnegative().optional(),
  })
  .strict();
export const pricingTableSchema = z.record(z.string().min(1).max(220), rateSchema);

export function estimateUsageUsd(usage: TokenUsage, rate: ModelPrice): number {
  const cached = usage.cachedTokens ?? 0;
  const writes = usage.cacheWriteTokens ?? 0;
  if (
    ![usage.inputTokens, usage.outputTokens, cached, writes].every(
      (v) => Number.isSafeInteger(v) && v >= 0,
    ) ||
    cached + writes > usage.inputTokens
  )
    throw new BudgetError("INVALID_TOKEN_USAGE");
  if (writes && rate.cacheWriteInputUsdPerMillion === undefined)
    throw new BudgetError("MISSING_CACHE_WRITE_PRICE");
  return (
    ((usage.inputTokens - cached - writes) * rate.inputUsdPerMillion +
      cached * (rate.cachedInputUsdPerMillion ?? rate.inputUsdPerMillion) +
      writes * (rate.cacheWriteInputUsdPerMillion ?? rate.inputUsdPerMillion) +
      usage.outputTokens * rate.outputUsdPerMillion) /
    1_000_000
  );
}

/** Reservations are synchronous: concurrent agents cannot spend the same balance. */
export class ReviewBudget {
  private reservedUsd = 0;
  private attemptedCalls = 0;
  private spentUsd = 0;
  private uncertainCalls = 0;
  private closed = false;
  private readonly records: ModelUsage[] = [];
  readonly pricing: PricingTable;
  constructor(
    readonly limits: BudgetLimits,
    pricing: PricingTable,
    private readonly now = Date.now,
  ) {
    if (
      !Number.isFinite(limits.maxUsd) ||
      limits.maxUsd <= 0 ||
      !Number.isInteger(limits.maxCalls) ||
      limits.maxCalls < 1 ||
      !Number.isFinite(limits.deadline)
    )
      throw new BudgetError("INVALID_BUDGET");
    this.pricing = pricingTableSchema.parse(pricing);
  }
  remainingMs(): number {
    return Math.max(0, this.limits.deadline - this.now());
  }
  assertTime(): void {
    if (!this.remainingMs()) throw new BudgetError("REVIEW_DEADLINE");
  }
  maximumCost(ref: ModelRef, inputBound: number, outputBound: number): number {
    if (![inputBound, outputBound].every((value) => Number.isSafeInteger(value) && value >= 0))
      throw new BudgetError("INVALID_TOKEN_BOUND");
    const rate = this.pricing[`${ref.provider}/${ref.model}`];
    if (!rate) throw new BudgetError("MODEL_PRICE_UNKNOWN");
    const inputRate = Math.max(
      rate.inputUsdPerMillion,
      rate.cachedInputUsdPerMillion ?? 0,
      rate.cacheWriteInputUsdPerMillion ?? 0,
    );
    return (inputBound * inputRate + outputBound * rate.outputUsdPerMillion) / 1_000_000;
  }
  private reserve(
    ref: ModelRef,
    agent: string,
    inputBound: number,
    outputBound: number,
    preserve: BudgetReserve,
  ): Ticket {
    this.assertTime();
    if (
      !Number.isFinite(preserve.usd) ||
      preserve.usd < 0 ||
      !Number.isSafeInteger(preserve.calls) ||
      preserve.calls < 0 ||
      !Number.isFinite(preserve.ms ?? 0) ||
      (preserve.ms ?? 0) < 0
    )
      throw new BudgetError("INVALID_BUDGET_RESERVE");
    if (this.remainingMs() <= (preserve.ms ?? 0)) throw new BudgetError("MODEL_TIME_RESERVE");
    if (this.closed) throw new BudgetError("BUDGET_ACCOUNTING_UNCERTAIN");
    const usd = this.maximumCost(ref, inputBound, outputBound);
    if (this.attemptedCalls + 1 + preserve.calls > this.limits.maxCalls)
      throw new BudgetError("MODEL_CALL_LIMIT");
    if (this.spentUsd + this.reservedUsd + usd + preserve.usd > this.limits.maxUsd + 1e-12)
      throw new BudgetError("MODEL_COST_LIMIT");
    this.reservedUsd += usd;
    this.attemptedCalls++;
    return { ref, agent, usd, inputBound, outputBound, started: this.now() };
  }
  private settle(ticket: Ticket, result?: ModelResponse): void {
    this.reservedUsd = Math.max(0, this.reservedUsd - ticket.usd);
    let usd = ticket.usd;
    let accountingFailure = false;
    if (result) {
      try {
        usd = estimateUsageUsd(
          result.usage,
          this.pricing[`${ticket.ref.provider}/${ticket.ref.model}`]!,
        );
        if (
          result.usage.inputTokens > ticket.inputBound ||
          result.usage.outputTokens > ticket.outputBound ||
          usd > ticket.usd + 1e-12
        )
          accountingFailure = true;
      } catch {
        accountingFailure = true;
      }
    }
    // Failed requests may have consumed tokens. Charge the full reservation.
    if (!result || accountingFailure) this.uncertainCalls++;
    if (accountingFailure) this.closed = true;
    this.spentUsd += usd;
    this.records.push({
      ...ticket.ref,
      agent: ticket.agent,
      ...(result?.usage ?? {}),
      estimatedUsd: usd,
      durationMs: this.now() - ticket.started,
      failed: !result || accountingFailure,
    });
    if (accountingFailure) throw new BudgetError("BUDGET_ACCOUNTING_UNCERTAIN");
  }
  cost(): ReviewCost {
    return {
      totalEstimatedUsd: this.spentUsd,
      calls: [...this.records],
      unpricedCalls: this.uncertainCalls,
    };
  }
  async invoke<T>(args: {
    provider: ModelProvider;
    ref: ModelRef;
    agent: string;
    system: string;
    user: string;
    outputTokens: number;
    schema: z.ZodType<T>;
    preserve?: BudgetReserve;
    repairInvalidOutput?: boolean;
    onInvalidOutput?: (diagnostic: OutputDiagnostic) => void;
    onAttempt?: (diagnostic: ModelAttemptDiagnostic) => void;
  }): Promise<T> {
    if (
      !Number.isSafeInteger(args.outputTokens) ||
      args.outputTokens < 1 ||
      args.outputTokens > 8192
    )
      throw new BudgetError("INVALID_TOKEN_BOUND");
    const preserve = args.preserve ?? { usd: 0, calls: 0 };
    let system = args.system;
    let user = args.user;
    let repaired = false;
    for (let attempt = 0; ; attempt++) {
      // Reserve the complete correction prompt too; repairs cannot consume the judge reserve.
      const inputBound = new TextEncoder().encode(system + user).byteLength + 1024;
      if (inputBound > 65000) throw new BudgetError("MODEL_INPUT_LIMIT");
      const ticket = this.reserve(args.ref, args.agent, inputBound, args.outputTokens, preserve);
      const attemptDiagnostic = (
        event: ModelAttemptDiagnostic["event"],
        extra: Partial<ModelAttemptDiagnostic> = {},
      ) => {
        // Observability must never change review execution or budget accounting.
        try {
          args.onAttempt?.({
            event,
            attempt: attempt + 1,
            correction: repaired,
            durationMs: this.now() - ticket.started,
            remainingMs: this.remainingMs(),
            inputBytes: inputBound - 1024,
            maxOutputTokens: args.outputTokens,
            ...extra,
          });
        } catch {
          /* Ignore an unavailable diagnostic sink. */
        }
      };
      attemptDiagnostic("review.model_started");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(new ProviderError("PROVIDER_TIMEOUT"));
          },
          Math.min(45000, this.remainingMs() - (preserve.ms ?? 0)),
        );
      });
      let result: ModelResponse;
      try {
        result = await Promise.race([
          args.provider.complete({
            model: args.ref.model,
            system,
            user,
            maxOutputTokens: args.outputTokens,
            signal: controller.signal,
          }),
          timeout,
        ]);
      } catch (error) {
        this.settle(ticket);
        attemptDiagnostic("review.model_failed", {
          code:
            error instanceof ProviderError &&
            /^(PROVIDER_(HTTP_[1-5][0-9]{2}|TIMEOUT|TRANSPORT_FAILED|BODY_TOO_LARGE|EMPTY_BODY|INVALID_JSON|INCOMPLETE_RESPONSE|INVALID_RESPONSE|INVALID_USAGE)|INVALID_MODEL_REQUEST|MODEL_REQUEST_TOO_LARGE|INVALID_CLOUDFLARE_GATEWAY_CONFIG)$/.test(
              error.code,
            )
              ? error.code
              : "MODEL_REQUEST_FAILED",
        });
        if (
          !(error instanceof ProviderError) ||
          !error.retryable ||
          attempt >= Math.min(args.provider.maxRetries ?? 0, 2)
        )
          throw error;
        const delay = Math.max(250 * 2 ** attempt, error.retryAfterMs);
        if (delay > 5000 || delay >= this.remainingMs() - (preserve.ms ?? 0))
          throw new BudgetError("RETRY_EXCEEDS_DEADLINE");
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      } finally {
        clearTimeout(timer);
      }
      this.settle(ticket, result);
      this.assertTime();
      let parsed: unknown;
      let diagnostic: OutputDiagnostic | undefined;
      try {
        parsed = JSON.parse(result.text);
      } catch {
        diagnostic = { code: "MODEL_INVALID_JSON", issues: ["$:invalid_json"] };
      }
      if (!diagnostic) {
        const validated = args.schema.safeParse(parsed);
        if (validated.success) {
          attemptDiagnostic("review.model_completed", {
            outputBytes: new TextEncoder().encode(result.text).byteLength,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          });
          return validated.data;
        }
        diagnostic = schemaDiagnostic(validated.error, parsed);
      }
      attemptDiagnostic("review.model_invalid_output", {
        code: diagnostic.code,
        validation: diagnostic,
        outputBytes: new TextEncoder().encode(result.text).byteLength,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      args.onInvalidOutput?.(diagnostic);
      if (!args.repairInvalidOutput || repaired) throw new ProviderError(diagnostic.code);
      repaired = true;
      system = `${args.system}\n${outputRepairInstruction}`;
      user = JSON.stringify({
        originalTask: args.user,
        untrustedPreviousResponse: result.text,
        validationIssues: diagnostic.issues,
      });
    }
  }
}
