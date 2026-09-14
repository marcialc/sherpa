import { expect, it } from "vitest";
import { reviewSandboxId } from "../apps/worker/src/sandbox-id";

it("gives 64-character review hashes fresh sandbox IDs within the SDK's DNS limit", () => {
  const ids = Array.from({ length: 100 }, () => reviewSandboxId("a".repeat(64)));
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) {
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    expect(id).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});
