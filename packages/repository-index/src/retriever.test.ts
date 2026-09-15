import { describe, it, expect, vi } from "vitest";
import { SqliteIndexDatabase } from "./testing/sqlite";
import { D1RepositoryIndexStore } from "./store";
import { RepositoryRetriever } from "./retriever";
import { indexConfigSchema, indexVersion, getIndexConfig } from "./config";
import { parseSource } from "./parser";
import { deterministicSummary } from "./summary";
import type { IndexQuery } from "./types";
const scope = { installationId: 1, repositoryId: 2 },
  sha = (value: string) => value.repeat(40),
  config = indexConfigSchema.parse({});
const query = (text: string, extra: Partial<IndexQuery> = {}): IndexQuery => ({
  ...scope,
  headSha: sha("a"),
  baseSha: sha("a"),
  query: text,
  changedPaths: [],
  ...extra,
});
async function setup() {
  const db = new SqliteIndexDatabase(),
    store = new D1RepositoryIndexStore(db),
    version = await indexVersion(config);
  const lease = (await store.begin(scope, sha("a"), version, 60000))!;
  const sources = {
    "src/auth.ts": "export function checkPermission() {return false}",
    "src/invoice.ts": "export function retryInvoice() {}",
    "src/consumer.ts":
      "import {retryInvoice} from './invoice'; export const send = () => retryInvoice();",
    "tests/invoice.test.ts":
      "import {retryInvoice} from '../src/invoice'; export function testRetries() {}",
    "src/constants.ts": Array.from({ length: 10 }, (_, i) => `export const VALUE_${i} = 1;`).join(
      "\n",
    ),
  };
  for (const [path, source] of Object.entries(sources)) {
    const file = { path, blobSha: sha("b"), size: source.length },
      parsed = parseSource(file, source),
      summary =
        path === "src/auth.ts"
          ? {
              summary: "Authentication middleware checks user permissions and access rights.",
              concepts: ["authentication", "authorization", "permission"],
            }
          : deterministicSummary(file, parsed);
    await store.put(lease, { ...file, ...parsed, ...summary, summaryKind: "deterministic" });
  }
  expect(await store.publish(lease, 5)).toBe(true);
  return { db, store, retriever: new RepositoryRetriever(store, config) };
}
describe("ranked discovery retrieval", () => {
  it("ranks exact symbols and preserves the matching source range", async () => {
    const { retriever } = await setup();
    const found = await retriever.retrieve(query("checkPermission"));
    expect(found.status).toBe("exact");
    expect(found.results[0]).toMatchObject({
      path: "src/auth.ts",
      commitSha: sha("a"),
      signals: expect.arrayContaining(["exact-symbol"]),
    });
    const later = await retriever.retrieve(query("VALUE_9"));
    expect(later.results[0]?.symbols[0]).toMatchObject({ name: "VALUE_9", startLine: 10 });
  });
  it("ranks exact path above import consumers", async () => {
    const { retriever } = await setup();
    const found = await retriever.retrieve(query("src/invoice.ts"));
    expect(found.results[0]?.path).toBe("src/invoice.ts");
    expect(found.results[0]?.signals).toContain("exact-path");
  });
  it("retrieves semantic concepts from persisted summaries", async () => {
    const { retriever } = await setup();
    expect((await retriever.retrieve(query("authentication middleware"))).results[0]?.path).toBe(
      "src/auth.ts",
    );
  });
  it("returns no irrelevant hits", async () => {
    const { retriever } = await setup();
    expect((await retriever.retrieve(query("platypus submarine quantum"))).results).toEqual([]);
  });
  it("finds consumers and related tests using changed module imports", async () => {
    const { retriever } = await setup();
    const found = await retriever.retrieve(
      query("invoice retries", { changedPaths: ["src/invoice.ts"] }),
    );
    expect(found.results.map((hit) => hit.path)).toEqual(
      expect.arrayContaining(["src/consumer.ts", "tests/invoice.test.ts"]),
    );
    expect(found.results.find((hit) => hit.path === "src/consumer.ts")?.signals).toContain(
      "imports-changed-module",
    );
  });
  it("bounds results and ranks deterministically", async () => {
    const { retriever } = await setup();
    const q = query("invoice", { limit: 2 });
    const a = await retriever.retrieve(q);
    expect(a.results).toHaveLength(2);
    expect((await retriever.retrieve(q)).results).toEqual(a.results);
  });
  it("labels base context and excludes changed files at a newer HEAD", async () => {
    const { retriever } = await setup();
    const found = await retriever.retrieve(
      query("invoice", { headSha: sha("c"), changedPaths: ["src/invoice.ts"] }),
    );
    expect(found).toMatchObject({ status: "base", requestedSha: sha("c"), indexedSha: sha("a") });
    expect(found.results.map((hit) => hit.path)).not.toContain("src/invoice.ts");
  });
  it("labels unrelated or lagging ready context stale without claiming ancestry", async () => {
    const { retriever } = await setup();
    expect(
      await retriever.retrieve(query("checkPermission", { headSha: sha("c"), baseSha: sha("d") })),
    ).toMatchObject({ status: "stale", indexedSha: sha("a") });
  });
  it("never uses stale-schema context", async () => {
    const { db, retriever } = await setup();
    db.sql.prepare("UPDATE index_revisions SET version='old'").run();
    expect(await retriever.retrieve(query("checkPermission"))).toMatchObject({
      status: "version-mismatch",
      results: [],
    });
  });
  it("labels missing, building and failed revisions, none visible to search", async () => {
    const db = new SqliteIndexDatabase(),
      store = new D1RepositoryIndexStore(db),
      retriever = new RepositoryRetriever(store, config);
    expect((await retriever.retrieve(query("x"))).status).toBe("missing");
    const lease = (await store.begin(scope, sha("a"), await indexVersion(config), 60000))!;
    expect(await retriever.retrieve(query("x"))).toMatchObject({ status: "building", results: [] });
    await store.finish(lease, "failed");
    expect((await retriever.retrieve(query("x"))).status).toBe("failed");
  });
  it("fails open without source or secret text in telemetry", async () => {
    const { store } = await setup(),
      telemetry = vi.fn();
    vi.spyOn(store, "findReady").mockRejectedValue(new Error("TOKEN-SECRET-SOURCE"));
    const retriever = new RepositoryRetriever(store, config, telemetry);
    expect(await retriever.retrieve(query("secret-query"))).toMatchObject({
      status: "unavailable",
      results: [],
    });
    expect(JSON.stringify(telemetry.mock.calls)).not.toMatch(/TOKEN|SECRET|secret-query/);
  });
  it("validates external lookup scope and caps", async () => {
    const { retriever } = await setup();
    expect((await retriever.retrieve(query("foo", { installationId: -1 }))).status).toBe(
      "unavailable",
    );
    expect((await retriever.retrieve(query("foo", { limit: 99 }))).results).toEqual([]);
  });
});
describe("versioned configuration", () => {
  it("has bounded defaults and separate qualified indexing model", () => {
    expect(getIndexConfig({ INDEX_MODEL: "anthropic/claude-haiku" })).toMatchObject({
      enabled: true,
      model: { provider: "cloudflare", model: "anthropic/claude-haiku" },
      concurrency: 4,
      retrievalLimit: 6,
    });
    expect(() => getIndexConfig({ INDEX_CONFIG_JSON: '{"concurrency":99}' })).toThrow();
    expect(() => getIndexConfig({ INDEX_CONFIG_JSON: '{"semanticEmbeddings":true}' })).toThrow();
  });
  it("changes representation identity only for material settings", async () => {
    const a = await indexVersion(config);
    expect(await indexVersion({ ...config, concurrency: 2, retrievalLimit: 1 })).toBe(a);
    expect(
      await indexVersion({
        ...config,
        model: { provider: "cloudflare", model: "anthropic/claude-haiku" },
      }),
    ).not.toBe(a);
  });
});
