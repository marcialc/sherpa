import { z } from "zod";
import { hashText } from "@sherpa/shared";
import { shaSchema } from "@sherpa/schemas";
import {
  indexedFileSchema,
  repositoryScopeSchema,
  type IndexedFile,
  type IndexRevision,
  type RepositoryScope,
  type SourceFile,
} from "./types";
import { fileTerms } from "./terms";

// Structural subset keeps the actual SQL testable against SQLite, without emulating queries.
export interface IndexStatement {
  bind(...values: (string | number | null)[]): IndexStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface IndexDatabase {
  prepare(sql: string): IndexStatement;
  batch(statements: IndexStatement[]): Promise<unknown[]>;
}
const revisionRowSchema = z.object({
  installation_id: z.number(),
  repository_id: z.number(),
  id: z.string(),
  commit_sha: shaSchema,
  version: z.string(),
  status: z.enum(["building", "ready", "failed", "superseded"]),
  created_at: z.number(),
  updated_at: z.number(),
  file_count: z.number(),
});
function revision(row: unknown): IndexRevision {
  const value = revisionRowSchema.parse(row);
  return {
    installationId: value.installation_id,
    repositoryId: value.repository_id,
    id: value.id,
    commitSha: value.commit_sha,
    version: value.version,
    status: value.status,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    fileCount: value.file_count,
  };
}
export type BuildLease = RepositoryScope & {
  id: string;
  commitSha: string;
  version: string;
  previousId: string | null;
  expiresAt: number;
};
export class D1RepositoryIndexStore {
  constructor(
    private readonly db: IndexDatabase,
    private readonly now = Date.now,
  ) {}
  private scope(scope: RepositoryScope): [number, number] {
    const parsed = repositoryScopeSchema.parse(scope);
    return [parsed.installationId, parsed.repositoryId];
  }
  async active(scope: RepositoryScope): Promise<IndexRevision | null> {
    const row = await this.db
      .prepare(
        `SELECT v.* FROM index_repositories r JOIN index_revisions v
      ON v.installation_id=r.installation_id AND v.repository_id=r.repository_id AND v.id=r.active_revision
      WHERE r.installation_id=? AND r.repository_id=? AND v.status='ready'`,
      )
      .bind(...this.scope(scope))
      .first();
    return row ? revision(row) : null;
  }
  async findReady(
    scope: RepositoryScope,
    sha: string,
    version: string,
  ): Promise<IndexRevision | null> {
    shaSchema.parse(sha);
    const row = await this.db
      .prepare(
        `SELECT * FROM index_revisions WHERE installation_id=? AND repository_id=? AND commit_sha=? AND version=? AND status='ready' ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(...this.scope(scope), sha, version)
      .first();
    return row ? revision(row) : null;
  }
  async latest(scope: RepositoryScope): Promise<IndexRevision | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM index_revisions WHERE installation_id=? AND repository_id=? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(...this.scope(scope))
      .first();
    return row ? revision(row) : null;
  }
  async begin(
    scope: RepositoryScope,
    sha: string,
    version: string,
    durationMs: number,
  ): Promise<BuildLease | null> {
    shaSchema.parse(sha);
    const keys = this.scope(scope),
      id = crypto.randomUUID(),
      now = this.now();
    const expiresAt = now + durationMs;
    // A unique attempt token fences old workers after their lease expires.
    const claimed = await this.db
      .prepare(
        `INSERT INTO index_repositories(installation_id,repository_id,build_id,lease_until)
      VALUES(?,?,?,?) ON CONFLICT(installation_id,repository_id) DO UPDATE SET build_id=excluded.build_id,lease_until=excluded.lease_until
      WHERE index_repositories.lease_until<=?`,
      )
      .bind(...keys, id, expiresAt, now)
      .run();
    if (claimed.meta.changes !== 1) return null;
    const row = await this.db
      .prepare(
        `SELECT active_revision FROM index_repositories WHERE installation_id=? AND repository_id=? AND build_id=?`,
      )
      .bind(...keys, id)
      .first<{ active_revision: string | null }>();
    if (!row) return null;
    await this.db
      .prepare(
        `INSERT INTO index_revisions(installation_id,repository_id,id,commit_sha,version,status,created_at,updated_at) VALUES(?,?,?,?,?,'building',?,?)`,
      )
      .bind(...keys, id, sha, version, now, now)
      .run();
    return { ...scope, id, commitSha: sha, version, previousId: row.active_revision, expiresAt };
  }
  async fileId(file: SourceFile, version: string): Promise<string> {
    return hashText(JSON.stringify([version, file.path, file.blobSha, file.size]));
  }
  async cached(
    scope: RepositoryScope,
    file: SourceFile,
    version: string,
  ): Promise<IndexedFile | null> {
    const row = await this.db
      .prepare(`SELECT data FROM index_files WHERE installation_id=? AND repository_id=? AND id=?`)
      .bind(...this.scope(scope), await this.fileId(file, version))
      .first<{ data: string }>();
    if (!row) return null;
    const parsed = indexedFileSchema.parse(JSON.parse(row.data));
    if (parsed.path !== file.path || parsed.blobSha !== file.blobSha || parsed.size !== file.size)
      throw new Error("INDEX_RECORD_MISMATCH");
    return parsed;
  }
  async cachedMany(
    scope: RepositoryScope,
    files: SourceFile[],
    version: string,
  ): Promise<Map<string, IndexedFile>> {
    const ids = await Promise.all(files.map((file) => this.fileId(file, version)));
    const rows = await this.db
      .prepare(
        `SELECT data FROM index_files WHERE installation_id=? AND repository_id=? AND id IN (SELECT value FROM json_each(?))`,
      )
      .bind(...this.scope(scope), JSON.stringify(ids))
      .all<{ data: string }>();
    const records = new Map<string, IndexedFile>();
    for (const row of rows.results) {
      const file = indexedFileSchema.parse(JSON.parse(row.data));
      records.set(file.path, file);
    }
    return records;
  }
  async put(lease: BuildLease, input: IndexedFile): Promise<void> {
    const file = indexedFileSchema.parse(input),
      keys = this.scope(lease),
      id = await this.fileId(file, lease.version);
    const terms = fileTerms(file);
    // A single batch makes immutable metadata and its postings appear together.
    const writes = [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO index_files(installation_id,repository_id,id,path,blob_sha,version,data) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM index_repositories WHERE installation_id=? AND repository_id=? AND build_id=? AND lease_until>?)`,
        )
        .bind(
          ...keys,
          id,
          file.path,
          file.blobSha,
          lease.version,
          JSON.stringify(file),
          ...keys,
          lease.id,
          this.now(),
        ),
    ];
    // json_each keeps binding counts independent of symbol count.
    writes.push(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO index_terms(installation_id,repository_id,term,file_id,weight)
      SELECT ?,?,json_extract(value,'$.term'),?,json_extract(value,'$.weight') FROM json_each(?) WHERE EXISTS(SELECT 1 FROM index_files WHERE installation_id=? AND repository_id=? AND id=? AND data=?) AND EXISTS(SELECT 1 FROM index_repositories WHERE installation_id=? AND repository_id=? AND build_id=? AND lease_until>?)`,
        )
        .bind(
          ...keys,
          id,
          JSON.stringify(terms),
          ...keys,
          id,
          JSON.stringify(file),
          ...keys,
          lease.id,
          this.now(),
        ),
    );
    writes.push(this.memberStatement(lease, file, id));
    await this.db.batch(writes);
  }
  private memberStatement(lease: BuildLease, file: SourceFile, id: string): IndexStatement {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO index_members(installation_id,repository_id,revision_id,path,file_id)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM index_repositories WHERE installation_id=? AND repository_id=? AND build_id=? AND lease_until>?)
      AND EXISTS(SELECT 1 FROM index_revisions WHERE installation_id=? AND repository_id=? AND id=? AND status='building')`,
      )
      .bind(
        ...this.scope(lease),
        lease.id,
        file.path,
        id,
        ...this.scope(lease),
        lease.id,
        this.now(),
        ...this.scope(lease),
        lease.id,
      );
  }
  async reuse(lease: BuildLease, files: SourceFile[]): Promise<void> {
    if (!files.length) return;
    const writes = await Promise.all(
      files.map(async (file) =>
        this.memberStatement(lease, file, await this.fileId(file, lease.version)),
      ),
    );
    await this.db.batch(writes);
  }
  async publish(lease: BuildLease, expectedFiles: number): Promise<boolean> {
    const keys = this.scope(lease),
      now = this.now();
    // Both statements are transactional in D1 batch. Count and fencing are checked in SQL.
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE index_revisions SET status='ready',file_count=?,updated_at=? WHERE installation_id=? AND repository_id=? AND id=? AND status='building'
        AND (SELECT COUNT(*) FROM index_members WHERE installation_id=? AND repository_id=? AND revision_id=?)=?
        AND EXISTS(SELECT 1 FROM index_repositories WHERE installation_id=? AND repository_id=? AND build_id=? AND lease_until>? AND active_revision IS ?)`,
        )
        .bind(
          expectedFiles,
          now,
          ...keys,
          lease.id,
          ...keys,
          lease.id,
          expectedFiles,
          ...keys,
          lease.id,
          now,
          lease.previousId,
        ),
      this.db
        .prepare(
          `UPDATE index_repositories SET active_revision=?,build_id=NULL,lease_until=0 WHERE installation_id=? AND repository_id=? AND build_id=? AND lease_until>? AND active_revision IS ?
        AND EXISTS(SELECT 1 FROM index_revisions WHERE installation_id=? AND repository_id=? AND id=? AND status='ready')`,
        )
        .bind(lease.id, ...keys, lease.id, now, lease.previousId, ...keys, lease.id),
    ]);
    return (await this.active(lease))?.id === lease.id;
  }
  async finish(lease: BuildLease, status: "failed" | "superseded"): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE index_revisions SET status=?,updated_at=? WHERE installation_id=? AND repository_id=? AND id=? AND status='building'`,
        )
        .bind(status, this.now(), ...this.scope(lease), lease.id),
      this.db
        .prepare(
          `UPDATE index_repositories SET build_id=NULL,lease_until=0 WHERE installation_id=? AND repository_id=? AND build_id=?`,
        )
        .bind(...this.scope(lease), lease.id),
    ]);
  }
  async candidates(rev: IndexRevision, terms: string[], limit = 120): Promise<IndexedFile[]> {
    if (!terms.length) return [];
    const result = await this.db
      .prepare(
        `SELECT f.data,SUM(t.weight) AS lexical_score FROM index_terms t
      JOIN index_members m ON m.installation_id=t.installation_id AND m.repository_id=t.repository_id AND m.file_id=t.file_id
      JOIN index_files f ON f.installation_id=m.installation_id AND f.repository_id=m.repository_id AND f.id=m.file_id
      JOIN index_revisions v ON v.installation_id=m.installation_id AND v.repository_id=m.repository_id AND v.id=m.revision_id
      WHERE t.installation_id=? AND t.repository_id=? AND m.revision_id=? AND v.status='ready' AND v.commit_sha=? AND v.version=?
      AND t.term IN (SELECT value FROM json_each(?)) GROUP BY f.id ORDER BY lexical_score DESC,f.path ASC LIMIT ?`,
      )
      .bind(
        ...this.scope(rev),
        rev.id,
        rev.commitSha,
        rev.version,
        JSON.stringify(terms.slice(0, 40)),
        Math.min(limit, 200),
      )
      .all<{ data: string }>();
    return result.results.map((row) => indexedFileSchema.parse(JSON.parse(row.data)));
  }
  /** Keep recent revisions for in-flight reviews; bounded cleanup never deletes a live build. */
  async prune(scope: RepositoryScope, retentionMs = 7 * 86400000): Promise<void> {
    const keys = this.scope(scope),
      cutoff = this.now() - retentionMs;
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM index_revisions WHERE installation_id=? AND repository_id=? AND updated_at<? AND id NOT IN
        (SELECT active_revision FROM index_repositories WHERE installation_id=? AND repository_id=? AND active_revision IS NOT NULL)
        AND id NOT IN (SELECT build_id FROM index_repositories WHERE installation_id=? AND repository_id=? AND build_id IS NOT NULL AND lease_until>?)
        AND id IN (SELECT id FROM index_revisions WHERE installation_id=? AND repository_id=? AND updated_at<? LIMIT 20)`,
        )
        .bind(...keys, cutoff, ...keys, ...keys, this.now(), ...keys, cutoff),
      this.db
        .prepare(
          `DELETE FROM index_files WHERE installation_id=? AND repository_id=? AND id IN
        (SELECT f.id FROM index_files f WHERE f.installation_id=? AND f.repository_id=? AND NOT EXISTS
          (SELECT 1 FROM index_members m WHERE m.installation_id=f.installation_id AND m.repository_id=f.repository_id AND m.file_id=f.id) LIMIT 500)
        AND NOT EXISTS (SELECT 1 FROM index_repositories WHERE installation_id=? AND repository_id=? AND build_id IS NOT NULL AND lease_until>?)`,
        )
        .bind(...keys, ...keys, ...keys, this.now()),
    ]);
  }
}
