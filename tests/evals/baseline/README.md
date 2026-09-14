# Frozen pre-rewrite baseline

These modules preserve the prompt and orchestration behavior before the hypothesis-driven rewrite. They are evaluation artifacts, never imported by the production Worker. Run both versions against the same fixtures and model configuration with `pnpm eval:live`.

Captured before editing, when the existing suite passed 162 tests:

- `prompts.ts` SHA-256: `20a694c5ab1091f8e56805d6514d43ed3608cef489928c79c959211d5d7c25bb`
- `review.ts` SHA-256: `dfc00f252ff0dcc8a21647a9c4cff52a9f5ab8cc4e3ce5174c61f3ee3e8ac34b`

The baseline uses the shared provider, budget, and final finding schemas so gateway transport, accounting, and presentation stay constant. Its prompts, orchestration, grounding and routing modules are frozen here. Future protocol changes should update the current reviewer, not this baseline.
