import { z } from "zod";
import { modelRefSchema } from "@sherpa/schemas";

const priceSchema = z.object({
  inputUsdPerMillion: z.number().nonnegative(),
  outputUsdPerMillion: z.number().nonnegative(),
  cachedInputUsdPerMillion: z.number().nonnegative().optional(),
  cacheWriteInputUsdPerMillion: z.number().nonnegative().optional(),
});
export type RuntimeEnv = Env;
export function getSettings(env: RuntimeEnv) {
  const model = (provider: string, name: string) => modelRefSchema.parse({ provider, model: name });
  return {
    models: {
      router: model(env.ROUTER_PROVIDER, env.ROUTER_MODEL),
      specialist: model(env.SPECIALIST_PROVIDER, env.SPECIALIST_MODEL),
      judge: model(env.JUDGE_PROVIDER, env.JUDGE_MODEL),
    },
    pricing: z.record(z.string(), priceSchema).parse(JSON.parse(env.MODEL_PRICING_JSON)),
    limits: {
      maxUsd: z.coerce.number().positive().max(100).parse(env.MAX_REVIEW_COST_USD),
      maxAgentCalls: z.coerce.number().int().min(2).max(100).parse(env.MAX_AGENT_CALLS),
      maxDurationMs: z.coerce
        .number()
        .int()
        .min(1000)
        .max(1800000)
        .parse(env.MAX_REVIEW_DURATION_MS),
      allowValidation: env.ALLOW_REPOSITORY_VALIDATION === "true",
      allowedModels: z.array(modelRefSchema).max(30).parse(JSON.parse(env.ALLOWED_MODELS_JSON)),
    },
  };
}
