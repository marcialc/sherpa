import { describe, expect, it, vi } from "vitest";
import type { IndexContext, IndexQuery } from "@sherpa/repository-index";
import { retrieveDiscoveryContext } from "./repository-context";

const headSha = "b".repeat(40);
const baseSha = "a".repeat(40);
const query: IndexQuery = {
  installationId: 1,
  repositoryId: 2,
  headSha,
  baseSha,
  query: "auth",
  changedPaths: ["src/auth.ts"],
  limit: 6,
};
const context = (): IndexContext => ({
  authority: "discovery-only",
  status: "exact",
  requestedSha: headSha,
  indexedSha: headSha,
  results: [
    {
      installationId: 1,
      repositoryId: 2,
      commitSha: headSha,
      path: "src/routes.ts",
      summary: "Registers protected authenticated routes.",
      symbols: [],
      score: 8,
      signals: ["symbol"],
    },
  ],
});

describe("bounded repository discovery context", () => {
  it("keeps exact metadata and bounded hints", async () => {
    const result = await retrieveDiscoveryContext(async () => context(), query);
    expect(result).toEqual(context());
  });
  it.each(["installationId", "repositoryId"] as const)("rejects cross-tenant %s", async (field) => {
    const raw = context();
    raw.results[0]![field] = 99;
    expect(await retrieveDiscoveryContext(async () => raw, query)).toBeUndefined();
  });
  it.each(["requestedSha", "indexedSha"] as const)(
    "rejects false exact revision via %s",
    async (field) => {
      const raw = context();
      raw[field] = baseSha;
      expect(await retrieveDiscoveryContext(async () => raw, query)).toBeUndefined();
    },
  );
  it("rejects a hit masquerading as the advertised revision", async () => {
    const raw = context();
    raw.results[0]!.commitSha = baseSha;
    expect(await retrieveDiscoveryContext(async () => raw, query)).toBeUndefined();
  });
  it("omits changed-file hints from a nonexact revision and records stale usage", async () => {
    const raw = context();
    raw.status = "base";
    raw.indexedSha = baseSha;
    raw.results[0]!.commitSha = baseSha;
    raw.results.push({ ...raw.results[0]!, path: "src/auth.ts" });
    const diagnostic = vi.fn();
    const result = await retrieveDiscoveryContext(async () => raw, query, diagnostic);
    expect(result?.results.map((hit) => hit.path)).toEqual(["src/routes.ts"]);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "review.index_stale_used" }),
    );
  });
  it.each(["missing", "building", "failed", "version-mismatch", "unavailable"] as const)(
    "does not expose %s records",
    async (status) => {
      const raw = { ...context(), status };
      expect((await retrieveDiscoveryContext(async () => raw, query))?.results).toEqual([]);
    },
  );
  it("bounds the complete envelope in UTF-8 bytes", async () => {
    const raw = context();
    raw.results = Array.from({ length: 20 }, (_, index) => ({
      ...raw.results[0]!,
      path: `src/route${index}.ts`,
      summary: "界".repeat(700),
    }));
    const result = await retrieveDiscoveryContext(async () => raw, query);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(3072);
    expect(result!.results.length).toBeGreaterThan(0);
  });
  it("times out a hung retrieval and never logs repository text or exception secrets", async () => {
    const diagnostic = vi.fn();
    expect(
      await retrieveDiscoveryContext(() => new Promise(() => {}), query, diagnostic, 5),
    ).toBeUndefined();
    expect(
      await retrieveDiscoveryContext(
        async () => {
          throw new Error("SECRET_TOKEN proprietary_source");
        },
        query,
        diagnostic,
      ),
    ).toBeUndefined();
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/SECRET_TOKEN|proprietary_source/);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "review.index_retrieval_failed" }),
    );
  });
});
