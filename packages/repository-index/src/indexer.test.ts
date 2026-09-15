import { describe, it, expect, vi } from "vitest";
import { hashText } from "@sherpa/shared";
import { SqliteIndexDatabase } from "./testing/sqlite";
import { D1RepositoryIndexStore } from "./store";
import { RepositoryIndexer } from "./indexer";
import { RepositoryRetriever } from "./retriever";
import { indexConfigSchema, indexVersion } from "./config";
import { parseSource } from "./parser";
import { deterministicSummary } from "./summary";
import type { RepositoryIndexJob, RepositorySource, SourceFile } from "./types";

const sha = (value: string) => value.repeat(40);
const scope = { installationId: 1, repositoryId: 2 };
const config = indexConfigSchema.parse({ summaryLimit: 0 });
function job(commitSha = sha("a"), extra: Partial<RepositoryIndexJob> = {}): RepositoryIndexJob {
  return {
    ...scope,
    owner: "owner",
    repo: "repo",
    commitSha,
    trigger: "push",
    deliveryId: "delivery",
    indexId: "a".repeat(64),
    ...extra,
  };
}
class Source implements RepositorySource {
  revisions = new Map<string, Record<string, string>>();
  current = sha("a");
  reads: string[] = [];
  failPath?: string;
  async listFiles(revision: string): Promise<SourceFile[]> {
    return Promise.all(
      Object.entries(this.revisions.get(revision) ?? {}).map(async ([path, text]) => ({
        path,
        blobSha: (await hashText(text)).slice(0, 40),
        size: new TextEncoder().encode(text).length,
      })),
    );
  }
  async readFile(revision: string, path: string): Promise<string> {
    this.reads.push(`${revision}:${path}`);
    if (path === this.failPath) throw new Error("private-source-secret-provider-error");
    return this.revisions.get(revision)![path]!;
  }
  isCurrentDefaultRevision(revision: string) {
    return Promise.resolve(revision === this.current);
  }
}
function setup() {
  const db = new SqliteIndexDatabase(),
    store = new D1RepositoryIndexStore(db),
    source = new Source();
  source.revisions.set(sha("a"), {
    "src/auth.ts": "export function checkPermission() {return true}",
    "src/invoices.ts": "export const retryInvoice = () => true;",
  });
  return { db, store, source, indexer: new RepositoryIndexer(store, source, { config }) };
}

describe("immutable repository indexing", () => {
  it("builds a ready initial revision with deterministic summaries and no source persisted", async () => {
    const { db, store, indexer } = setup();
    expect(await indexer.build(job())).toMatchObject({
      status: "ready",
      filesParsed: 2,
      filesReused: 0,
    });
    expect(await store.active(scope)).toMatchObject({
      commitSha: sha("a"),
      status: "ready",
      fileCount: 2,
    });
    const rows = db.sql.prepare("SELECT data FROM index_files").all();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("return true");
  });
  it("reuses unchanged blobs and processes additions, modifications, deletions and renames", async () => {
    const { store, source, indexer } = setup();
    await indexer.build(job());
    source.reads = [];
    source.current = sha("b");
    source.revisions.set(sha("b"), {
      "src/auth.ts": "export function checkPermission() {return true}",
      "src/retries.ts": "export const retryInvoice = () => true;",
      "src/new.ts": "export interface Invoice {}",
    });
    expect(await indexer.build(job(sha("b")))).toMatchObject({
      status: "ready",
      filesParsed: 2,
      filesReused: 1,
    });
    expect(source.reads).toHaveLength(2);
    expect(source.reads.some((path) => path.endsWith("auth.ts"))).toBe(false);
    const active = (await store.active(scope))!;
    expect(
      (await store.candidates(active, ["retry", "invoice"])).map((file) => file.path),
    ).toContain("src/retries.ts");
    expect((await store.candidates(active, ["invoice"])).map((file) => file.path)).not.toContain(
      "src/invoices.ts",
    );
    source.current = sha("c");
    source.revisions.set(sha("c"), {
      "src/auth.ts": "export function denyPermission() {return false}",
    });
    expect(await indexer.build(job(sha("c")))).toMatchObject({
      status: "ready",
      filesParsed: 1,
      filesReused: 0,
    });
    expect((await store.active(scope))?.fileCount).toBe(1);
  });
  it("is idempotent at a ready SHA and never rereads source", async () => {
    const { source, indexer } = setup();
    await indexer.build(job());
    source.reads = [];
    expect((await indexer.build(job())).status).toBe("ready");
    expect(source.reads).toEqual([]);
  });
  it("keeps prior revision ready on an interrupted update and reuses persisted progress on retry", async () => {
    const { store, source, indexer } = setup();
    await indexer.build(job());
    source.current = sha("b");
    source.revisions.set(sha("b"), {
      "src/good.ts": "export const good = 1;",
      "src/bad.ts": "export const bad = 2;",
    });
    source.failPath = "src/bad.ts";
    expect((await indexer.build(job(sha("b")))).status).toBe("failed");
    expect((await store.active(scope))?.commitSha).toBe(sha("a"));
    expect(await store.findReady(scope, sha("b"), await indexVersion(config))).toBeNull();
    source.failPath = undefined;
    expect(await indexer.build(job(sha("b")))).toMatchObject({
      status: "ready",
      filesParsed: 1,
      filesReused: 1,
    });
  });
  it("rebuilds when representation version changes", async () => {
    const { store, source, indexer } = setup();
    await indexer.build(job());
    source.reads = [];
    const next = { ...config, excludePaths: ["src/invoices.ts"] };
    expect(await new RepositoryIndexer(store, source, { config: next }).build(job())).toMatchObject(
      { status: "ready", filesParsed: 1 },
    );
    expect((await store.active(scope))?.version).toBe(await indexVersion(next));
  });
  it("prevents late pushes and bootstraps from regressing active index", async () => {
    const { store, source, indexer } = setup();
    await indexer.build(job());
    source.revisions.set(sha("b"), { "src/late.ts": "export const late=1" });
    expect((await indexer.build(job(sha("b")))).status).toBe("superseded");
    expect((await indexer.build(job(sha("b"), { trigger: "bootstrap" }))).status).toBe(
      "superseded",
    );
    expect((await store.active(scope))?.commitSha).toBe(sha("a"));
  });
  it("applies immutable root/nested gitignore, generated and unsupported exclusions", async () => {
    const { source, store, indexer } = setup();
    source.revisions.set(sha("a"), {
      ".gitignore": "ignored/\n",
      "ignored/a.ts": "export const no=1",
      "src/.gitignore": "hidden.ts\n",
      "src/hidden.ts": "export const no=1",
      "src/keep.ts": "export const yes=1",
      "src/generated.ts": "// @generated\nexport const no=1",
      "a.png": "binary",
      "node_modules/a.ts": "export const no=1",
    });
    expect(await indexer.build(job())).toMatchObject({
      status: "ready",
      filesParsed: 1,
      filesSkipped: 7,
    });
    expect((await store.active(scope))?.fileCount).toBe(1);
  });
  it("rejects duplicate or oversized trees without advertising partial readiness", async () => {
    const { source, store, indexer } = setup();
    source.listFiles = async () => [
      { path: "a.ts", blobSha: sha("a"), size: 0 },
      { path: "a.ts", blobSha: sha("a"), size: 0 },
    ];
    expect((await indexer.build(job())).status).toBe("failed");
    expect(await store.active(scope)).toBeNull();
  });
  it("does not let failed summaries block indexing or leak raw errors to telemetry", async () => {
    const { store, source } = setup(),
      telemetry = vi.fn();
    const summarize = vi.fn().mockRejectedValue(new Error("secret-source-credentials"));
    const result = await new RepositoryIndexer(store, source, {
      config: { ...config, summaryLimit: 10, concurrency: 1 },
      summarize,
      telemetry,
    }).build(job());
    expect(result.status).toBe("ready");
    expect(result.summariesGenerated).toBe(0);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain("secret-source");
  });
  it("keeps model summaries bounded and makes them searchable", async () => {
    const { store, source } = setup();
    const summary = {
      summary: "Checks authentication middleware and user access rights.",
      concepts: ["authentication", "permissions"],
    };
    await new RepositoryIndexer(store, source, {
      config: { ...config, summaryLimit: 1 },
      summarize: async () => summary,
    }).build(job());
    const context = await new RepositoryRetriever(store, { ...config, summaryLimit: 1 }).retrieve({
      ...scope,
      headSha: sha("a"),
      baseSha: sha("a"),
      query: "authentication middleware",
      changedPaths: [],
    });
    expect(context.results[0]?.path).toBe("src/auth.ts");
  });
});

describe("publication leases and isolation", () => {
  it("never publishes an incomplete revision, or a revision whose lease expired", async () => {
    const db = new SqliteIndexDatabase();
    let now = 1000;
    const store = new D1RepositoryIndexStore(db, () => now),
      version = await indexVersion(config);
    const lease = (await store.begin(scope, sha("a"), version, 10))!;
    expect(await store.publish(lease, 1)).toBe(false);
    expect(await store.active(scope)).toBeNull();
    now = 1011;
    const newer = (await store.begin(scope, sha("b"), version, 100))!;
    expect(await store.publish(lease, 0)).toBe(false);
    expect(await store.publish(newer, 0)).toBe(true);
    await store.finish(lease, "failed");
    expect((await store.active(scope))?.commitSha).toBe(sha("b"));
  });
  it("serializes live builds and fences a stale owner after a new lease", async () => {
    const { store, indexer } = setup();
    const lease = (await store.begin(scope, sha("a"), await indexVersion(config), 60000))!;
    expect((await indexer.build(job())).status).toBe("busy");
    await store.finish(lease, "failed");
    expect((await indexer.build(job())).status).toBe("ready");
  });
  it("scopes ready metadata, cached files, and retrieval by installation AND repository", async () => {
    const { source, store, indexer } = setup();
    await indexer.build(job());
    const file = (await source.listFiles(sha("a")))[0]!;
    for (const other of [
      { installationId: 2, repositoryId: 2 },
      { installationId: 1, repositoryId: 3 },
    ]) {
      expect(await store.active(other)).toBeNull();
      expect(await store.cached(other, file, await indexVersion(config))).toBeNull();
      expect(
        (
          await new RepositoryRetriever(store, config).retrieve({
            ...other,
            headSha: sha("a"),
            baseSha: sha("a"),
            query: "checkPermission",
            changedPaths: [],
          })
        ).results,
      ).toEqual([]);
    }
  });
  it("scopes malicious reused revision IDs too", async () => {
    const { store, indexer } = setup();
    await indexer.build(job());
    const rev = (await store.active(scope))!;
    expect(await store.candidates({ ...rev, installationId: 9 }, ["permission"])).toEqual([]);
    expect(await store.candidates({ ...rev, commitSha: sha("b") }, ["permission"])).toEqual([]);
  });
  it("prunes old records without deleting active repository data", async () => {
    const { db, store, indexer } = setup();
    await indexer.build(job());
    const lease = (await store.begin(scope, sha("b"), await indexVersion(config), 10000))!;
    const file = { path: "old.ts", blobSha: sha("c"), size: 0 };
    const parsed = parseSource(file, "");
    await store.put(lease, {
      ...file,
      ...parsed,
      ...deterministicSummary(file, parsed),
      summaryKind: "deterministic",
    });
    await store.finish(lease, "failed");
    db.sql.prepare("UPDATE index_revisions SET updated_at=0 WHERE id=?").run(lease.id);
    await store.prune(scope);
    expect(await store.active(scope)).not.toBeNull();
    expect(db.sql.prepare("SELECT count(*) AS count FROM index_files").get()?.count).toBe(2);
  });
});
