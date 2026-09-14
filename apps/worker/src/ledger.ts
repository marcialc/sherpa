import { DurableObject } from "cloudflare:workers";
import {
  Ledger,
  type Baseline,
  type JobRecord,
  type LedgerStore,
  type PublicationData,
} from "@sherpa/workflow";
import { reviewJobSchema, type ReviewJob } from "@sherpa/schemas";
import { GitHubApp, GitHubClient } from "@sherpa/github";

export class ReviewLedger extends DurableObject<Env> {
  private readonly ledger: Ledger;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
    const read = <T>(key: string): T | undefined => {
      const row = sql
        .exec<{ data: string }>("SELECT data FROM metadata WHERE key = ?", key)
        .toArray()[0];
      return row ? (JSON.parse(row.data) as T) : undefined;
    };
    const write = (key: string, data: unknown) => {
      sql.exec(
        "INSERT INTO metadata(key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        key,
        JSON.stringify(data),
      );
    };
    const store: LedgerStore = {
      readJob: (id) => {
        const row = sql
          .exec<{ data: string }>("SELECT data FROM reviews WHERE id = ?", id)
          .toArray()[0];
        return row ? (JSON.parse(row.data) as JobRecord) : undefined;
      },
      writeJob: (job) => {
        sql.exec(
          "INSERT INTO reviews(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
          job.reviewId,
          JSON.stringify(job),
        );
      },
      readActive: () => read<string | null>("active") ?? undefined,
      writeActive: (id) => write("active", id ?? null),
      readBaseline: () => read<Baseline>("baseline") ?? { findings: [], fingerprints: [] },
      writeBaseline: (baseline) => write("baseline", baseline),
    };
    this.ledger = new Ledger(store);
  }
  claim(job: ReviewJob, leaseMs: number, acquisitionToken: string) {
    if (typeof acquisitionToken !== "string" || !acquisitionToken || acquisitionToken.length > 100)
      throw new Error("INVALID_ACQUISITION_TOKEN");
    return this.ctx.storage.transactionSync(() =>
      this.ledger.claim(job, Date.now(), leaseMs, acquisitionToken),
    );
  }
  renew(reviewId: string, token: string, leaseMs: number) {
    this.ctx.storage.transactionSync(() => this.ledger.renew(reviewId, token, Date.now(), leaseMs));
  }
  reserveAnalysis(reviewId: string, token: string) {
    return this.ctx.storage.transactionSync(() =>
      this.ledger.reserveAnalysis(reviewId, token, Date.now()),
    );
  }
  reservePublication(reviewId: string, token: string, data?: PublicationData) {
    return this.ctx.storage.transactionSync(() =>
      this.ledger.reservePublication(reviewId, token, Date.now(), data),
    );
  }
  complete(job: ReviewJob, token: string, data: Parameters<Ledger["complete"]>[3]) {
    this.ctx.storage.transactionSync(() => this.ledger.complete(job, token, Date.now(), data));
  }
  finish(reviewId: string, token: string, status: "failed" | "skipped" | "uncertain") {
    this.ctx.storage.transactionSync(() => this.ledger.finish(reviewId, token, Date.now(), status));
  }
  async reconcilePublication(input: ReviewJob): Promise<{
    status: "recovered" | "unresolved" | "none" | "waiting";
    githubReviewId?: number;
    retryAfterMs?: number;
  }> {
    const parsed = reviewJobSchema.safeParse(input);
    if (!parsed.success) return { status: "none" };
    const job = parsed.data;
    const now = Date.now();
    const state = this.ledger.publicationState(job.reviewId);
    if (state?.status === "published" && state.githubReviewId)
      return { status: "recovered", githubReviewId: state.githubReviewId };
    if (state?.status === "publishing" && state.leaseUntil > now)
      return { status: "waiting", retryAfterMs: Math.min(state.leaseUntil - now, 60000) };
    const candidate = this.ledger.getRecoverable(job.reviewId, now);
    if (!candidate || candidate.headSha !== job.headSha) return { status: "none" };
    try {
      const app = new GitHubApp({
        appId: this.env.GITHUB_APP_ID,
        privateKey: this.env.GITHUB_PRIVATE_KEY,
      });
      const github = new GitHubClient(
        await app.installationToken(job, "read"),
        undefined,
        await app.getIdentity(),
      );
      const found = await github.findReview(job);
      if (!found) return { status: "unresolved" };
      // Network I/O happens outside the transaction; check eligibility again at commit time.
      const recovered = this.ctx.storage.transactionSync(() =>
        this.ledger.recoverPublication(job, Date.now(), found),
      );
      return recovered ? { status: "recovered", githubReviewId: found.id } : { status: "none" };
    } catch {
      return { status: "unresolved" };
    }
  }
}
