import { describe, expect, it, vi } from "vitest";
import { hashText } from "@sherpa/shared";
import { SqliteIndexDatabase } from "./testing/sqlite";
import { D1RepositoryIndexStore } from "./store";
import { RepositoryIndexer } from "./indexer";
import { RepositoryRetriever } from "./retriever";
import { indexConfigSchema, indexVersion } from "./config";
import { parseSource } from "./parser";
import { deterministicSummary } from "./summary";
import type { IndexedFile, RepositoryIndexJob, RepositorySource, SourceFile } from "./types";

const sha = (value: string) => value.repeat(40);
const scope = { installationId: 1, repositoryId: 2 };
const config = indexConfigSchema.parse({ summaryLimit: 0 });
const job: RepositoryIndexJob = {
  ...scope,
  owner: "owner",
  repo: "repo",
  commitSha: sha("a"),
  trigger: "push",
  deliveryId: "regression-delivery",
  indexId: "a".repeat(64),
};
function record(summary = "Stable metadata", concepts = ["stableword"]): IndexedFile {
  const file = { path: "src/module.ts", blobSha: sha("c"), size: 0 };
  return { ...file, ...parseSource(file, ""), summary, concepts, summaryKind: "model" };
}

class SnapshotSource implements RepositorySource {
  constructor(private readonly contents: Record<string, string>) {}
  async listFiles(): Promise<SourceFile[]> {
    return Promise.all(
      Object.entries(this.contents).map(async ([path, text]) => ({
        path,
        blobSha: (await hashText(text)).slice(0, 40),
        size: new TextEncoder().encode(text).length,
      })),
    );
  }
  async readFile(_revision: string, path: string): Promise<string> {
    return this.contents[path]!;
  }
  async isCurrentDefaultRevision(): Promise<boolean> {
    return true;
  }
}

describe("repository index publication regressions", () => {
  it("supersedes bootstrap when a newer push publishes between its active read and lease claim", async () => {
    const store = new D1RepositoryIndexStore(new SqliteIndexDatabase());
    const source = new SnapshotSource({ "src/old.ts": "export const old = 1;" });
    const listFiles = vi.spyOn(source, "listFiles");
    const begin = store.begin.bind(store);
    vi.spyOn(store, "begin").mockImplementationOnce(
      async (requestedScope, revision, version, duration) => {
        const newer = (await begin(requestedScope, sha("b"), version, duration))!;
        expect(await store.publish(newer, 0)).toBe(true);
        return begin(requestedScope, revision, version, duration);
      },
    );
    expect(
      await new RepositoryIndexer(store, source, { config }).build({
        ...job,
        trigger: "bootstrap",
      }),
    ).toMatchObject({ status: "superseded" });
    expect((await store.active(scope))?.commitSha).toBe(sha("b"));
    expect(listFiles).not.toHaveBeenCalled();
  });
  it("keeps immutable metadata and postings consistent when a later attempt proposes a different summary", async () => {
    const db = new SqliteIndexDatabase();
    const store = new D1RepositoryIndexStore(db);
    const version = await indexVersion(config);
    const first = (await store.begin(scope, sha("a"), version, 60000))!;
    const original = record();
    await store.put(first, original);
    expect(await store.publish(first, 1)).toBe(true);
    const second = (await store.begin(scope, sha("b"), version, 60000))!;
    await store.put(second, record("Unrelated metadata", ["phantomword"]));
    expect(await store.publish(second, 1)).toBe(true);
    const revision = (await store.active(scope))!;
    expect(await store.cached(scope, original, version)).toEqual(original);
    expect(await store.candidates(revision, ["phantomword"])).toEqual([]);
    expect(await store.candidates(revision, ["stableword"])).toEqual([original]);
    expect(db.sql.prepare("SELECT COUNT(*) AS count FROM index_files").get()?.count).toBe(1);
  });

  it.each([false, true])(
    "fences all expired writes, including cache and postings (new owner: %s)",
    async (takeover) => {
      const db = new SqliteIndexDatabase();
      let now = 1000;
      const store = new D1RepositoryIndexStore(db, () => now);
      const version = await indexVersion(config);
      const stale = (await store.begin(scope, sha("a"), version, 10))!;
      now = 1011;
      const current = takeover ? await store.begin(scope, sha("b"), version, 1000) : null;
      await store.put(stale, record());
      expect(await store.cached(scope, record(), version)).toBeNull();
      expect(db.sql.prepare("SELECT COUNT(*) AS count FROM index_terms").get()?.count).toBe(0);
      expect(db.sql.prepare("SELECT COUNT(*) AS count FROM index_members").get()?.count).toBe(0);
      expect(await store.publish(stale, 1)).toBe(false);
      if (current) {
        await store.put(current, record("Current summary", ["currentword"]));
        expect(await store.publish(current, 1)).toBe(true);
        expect((await store.active(scope))?.commitSha).toBe(sha("b"));
      }
    },
  );

  it("protects cached progress during cleanup until the live build attaches it", async () => {
    const db = new SqliteIndexDatabase();
    let now = 1000;
    const store = new D1RepositoryIndexStore(db, () => now);
    const version = await indexVersion(config);
    const old = (await store.begin(scope, sha("a"), version, 100))!;
    await store.put(old, record());
    await store.finish(old, "failed");
    now = 9 * 86400000;
    const live = (await store.begin(scope, sha("b"), version, 60000))!;
    expect(await store.cached(scope, record(), version)).not.toBeNull();
    await store.prune(scope);
    expect(
      db.sql.prepare("SELECT COUNT(*) AS count FROM index_revisions WHERE id=?").get(old.id)?.count,
    ).toBe(0);
    expect(await store.cached(scope, record(), version)).not.toBeNull();
    await store.reuse(live, [record()]);
    expect(await store.publish(live, 1)).toBe(true);
    expect((await store.active(scope))?.fileCount).toBe(1);
  });

  it("rejects a cross-tenant write even when the caller copies a valid lease ID", async () => {
    const db = new SqliteIndexDatabase();
    const store = new D1RepositoryIndexStore(db);
    const version = await indexVersion(config);
    const lease = (await store.begin(scope, sha("a"), version, 60000))!;
    const wrong = { ...lease, installationId: 999 };
    await store.put(wrong, record());
    expect(await store.cached(wrong, record(), version)).toBeNull();
    expect(db.sql.prepare("SELECT COUNT(*) AS count FROM index_files").get()?.count).toBe(0);
  });
});

describe("repository context regressions", () => {
  it.each(["index.ts", "src/index.ts"])(
    "retrieves exact path %s when every path component is a stop word",
    async (path) => {
      const store = new D1RepositoryIndexStore(new SqliteIndexDatabase());
      const source = new SnapshotSource({
        [path]: "",
        "src/other.ts": "export const unrelated = 1;",
      });
      await new RepositoryIndexer(store, source, { config }).build(job);
      const context = await new RepositoryRetriever(store, config).retrieve({
        ...scope,
        headSha: sha("a"),
        baseSha: sha("a"),
        query: path,
        changedPaths: [],
      });
      expect(context.status).toBe("exact");
      expect(context.results).toHaveLength(1);
      expect(context.results[0]).toMatchObject({
        path,
        signals: ["exact-path"],
        commitSha: sha("a"),
      });
    },
  );

  it("upgrades the active immutable SHA on model-version change rather than rebuilding the older bootstrap PR base", async () => {
    const store = new D1RepositoryIndexStore(new SqliteIndexDatabase());
    const source = new SnapshotSource({ "src/auth.ts": "export function checkPermission() {}" });
    const listFiles = vi.spyOn(source, "listFiles");
    await new RepositoryIndexer(store, source, { config }).build({ ...job, commitSha: sha("b") });
    const nextConfig = {
      ...config,
      model: { provider: "cloudflare" as const, model: "anthropic/claude-haiku-4-5" },
    };
    const retriever = new RepositoryRetriever(store, nextConfig);
    expect(
      await retriever.retrieve({
        ...scope,
        headSha: sha("b"),
        baseSha: sha("b"),
        query: "checkPermission",
        changedPaths: [],
      }),
    ).toMatchObject({ status: "version-mismatch", results: [] });
    listFiles.mockClear();
    expect(
      await new RepositoryIndexer(store, source, { config: nextConfig }).build({
        ...job,
        trigger: "bootstrap",
      }),
    ).toMatchObject({ status: "ready", filesParsed: 1, filesReused: 0 });
    expect(listFiles).toHaveBeenCalledExactlyOnceWith(sha("b"));
    expect(await store.active(scope)).toMatchObject({
      commitSha: sha("b"),
      version: await indexVersion(nextConfig),
    });
    expect(
      await retriever.retrieve({
        ...scope,
        headSha: sha("b"),
        baseSha: sha("a"),
        query: "checkPermission",
        changedPaths: [],
      }),
    ).toMatchObject({ status: "exact", indexedSha: sha("b") });
    const older = await retriever.retrieve({
      ...scope,
      headSha: sha("a"),
      baseSha: sha("a"),
      query: "checkPermission",
      changedPaths: [],
    });
    expect(older).toMatchObject({ status: "stale", requestedSha: sha("a"), indexedSha: sha("b") });
    expect(older.results[0]?.commitSha).toBe(sha("b"));
  });

  it("does not overwrite a concurrent newer push during bootstrap version upgrade", async () => {
    const store = new D1RepositoryIndexStore(new SqliteIndexDatabase());
    const source = new SnapshotSource({ "src/auth.ts": "export function checkPermission() {}" });
    await new RepositoryIndexer(store, source, { config }).build({ ...job, commitSha: sha("b") });
    const nextConfig = {
      ...config,
      model: { provider: "cloudflare" as const, model: "anthropic/claude-haiku-4-5" },
    };
    const begin = store.begin.bind(store);
    const listFiles = vi.spyOn(source, "listFiles");
    vi.spyOn(store, "begin").mockImplementationOnce(
      async (requestedScope, revision, version, duration) => {
        const newer = (await begin(requestedScope, sha("c"), version, duration))!;
        expect(await store.publish(newer, 0)).toBe(true);
        return begin(requestedScope, revision, version, duration);
      },
    );
    expect(
      await new RepositoryIndexer(store, source, { config: nextConfig }).build({
        ...job,
        trigger: "bootstrap",
      }),
    ).toMatchObject({ status: "superseded" });
    expect(await store.active(scope)).toMatchObject({
      commitSha: sha("c"),
      version: await indexVersion(nextConfig),
    });
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("lets a nested gitignore negate an inherited file pattern", async () => {
    const store = new D1RepositoryIndexStore(new SqliteIndexDatabase());
    const source = new SnapshotSource({
      ".gitignore": "*.ts\n",
      "src/.gitignore": "!keep.ts\n",
      "src/keep.ts": "export const allowed = 1;",
      "src/hidden.ts": "export const hidden = 1;",
      "outside.ts": "export const outside = 1;",
    });
    expect(await new RepositoryIndexer(store, source, { config }).build(job)).toMatchObject({
      status: "ready",
      filesParsed: 1,
    });
    const revision = (await store.active(scope))!;
    expect((await store.candidates(revision, ["allowed"])).map((file) => file.path)).toEqual([
      "src/keep.ts",
    ]);
  });

  it("does not let child gitignore rules reinclude files beneath an ignored parent directory", async () => {
    const store = new D1RepositoryIndexStore(new SqliteIndexDatabase());
    const source = new SnapshotSource({
      ".gitignore": "private/\n",
      "private/.gitignore": "!keep.ts\n",
      "private/keep.ts": "export const hidden = 1;",
      "public.ts": "export const allowed = 1;",
    });
    expect(await new RepositoryIndexer(store, source, { config }).build(job)).toMatchObject({
      status: "ready",
      filesParsed: 1,
    });
    const revision = (await store.active(scope))!;
    expect(await store.candidates(revision, ["hidden"])).toEqual([]);
  });

  it("returns the matching symbol and its actual parsed range beyond the first six symbols", async () => {
    const store = new D1RepositoryIndexStore(new SqliteIndexDatabase());
    const source = new SnapshotSource({
      "src/module.ts": [
        ...Array.from({ length: 8 }, (_, index) => `export const filler${index} = 1;`),
        "export function uniqueTarget() { return true; }",
      ].join("\n"),
    });
    await new RepositoryIndexer(store, source, { config }).build(job);
    const context = await new RepositoryRetriever(store, config).retrieve({
      ...scope,
      headSha: sha("a"),
      baseSha: sha("a"),
      query: "uniqueTarget",
      changedPaths: [],
    });
    expect(context.results[0]?.symbols[0]).toMatchObject({
      name: "uniqueTarget",
      startLine: 9,
      endLine: 9,
    });
    expect(context.results[0]?.symbols.length).toBeLessThanOrEqual(6);
    expect(context.results[0]?.signals).toContain("exact-symbol");
  });

  it("keeps cache identity separate across indexing versions", async () => {
    const store = new D1RepositoryIndexStore(new SqliteIndexDatabase());
    const file = record();
    const firstVersion = await indexVersion(config);
    const nextVersion = await indexVersion({
      ...config,
      model: { provider: "cloudflare", model: "anthropic/claude-haiku-4-5" },
    });
    const lease = (await store.begin(scope, sha("a"), firstVersion, 60000))!;
    const parsed = parseSource(file, "");
    await store.put(lease, { ...file, ...deterministicSummary(file, parsed) });
    expect(await store.cached(scope, file, nextVersion)).toBeNull();
    expect(await store.cachedMany(scope, [file], nextVersion)).toEqual(new Map());
  });
});
