import { describe, expect, it } from "vitest";
import { Ledger, type Baseline, type JobRecord, type LedgerStore } from "./ledger";
import type { Finding, ReviewJob } from "@sherpa/schemas";

export const job: ReviewJob = {
  reviewId: "review-a",
  deliveryId: "delivery-a",
  installationId: 1,
  repositoryId: 2,
  owner: "acme",
  repo: "api",
  number: 3,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  action: "opened",
};
export function memoryLedger() {
  const jobs = new Map<string, JobRecord>();
  let active: string | undefined;
  let baseline: Baseline = { findings: [], fingerprints: [] };
  const store: LedgerStore = {
    readJob: (id) => jobs.get(id),
    writeJob: (job) => {
      jobs.set(job.reviewId, job);
    },
    readActive: () => active,
    writeActive: (id) => {
      active = id;
    },
    readBaseline: () => baseline,
    writeBaseline: (value) => {
      baseline = value;
    },
  };
  return { ledger: new Ledger(store), store };
}
const complete = {
  githubReviewId: 123,
  findings: [],
  fingerprints: [],
  outcome: "PASS" as const,
  cost: { totalEstimatedUsd: 0, calls: [], unpricedCalls: 0 },
  coverageComplete: true,
};
describe("durable review state transitions", () => {
  it("returns the same live acquisition after a lost claim response without extending its lease", () => {
    const { ledger, store } = memoryLedger();
    const first = ledger.claim(job, 0, 100, "acquisition-id");
    expect(ledger.claim(job, 1, 100, "acquisition-id")).toEqual(first);
    expect(store.readJob(job.reviewId)?.leaseUntil).toBe(100);
    expect(ledger.claim(job, 2, 100, "different-workflow").status).toBe("busy");
  });

  it("never spends a second analysis budget after callback replay or expired-lease reclaim", () => {
    const { ledger, store } = memoryLedger();
    ledger.claim(job, 0, 100, "first");
    expect(ledger.reserveAnalysis(job.reviewId, "first", 1)).toBe(true);
    expect(ledger.reserveAnalysis(job.reviewId, "first", 2)).toBe(false);
    const afterEviction = new Ledger(store);
    expect(afterEviction.claim(job, 101, 100, "second").status).toBe("acquired");
    expect(afterEviction.reserveAnalysis(job.reviewId, "second", 102)).toBe(false);
    afterEviction.finish(job.reviewId, "second", 103, "failed");
    expect(afterEviction.claim(job, 104, 100, "third").status).toBe("acquired");
    expect(afterEviction.reserveAnalysis(job.reviewId, "third", 105)).toBe(false);
  });

  it("recovers a confirmed crashed publication without advancing or rewinding a newer baseline", () => {
    const { ledger, store } = memoryLedger();
    const finding: Finding = {
      id: "confirmed",
      title: "Authorization missing",
      description: "The session is deleted before ownership is verified.",
      path: "src/auth.ts",
      line: 2,
      severity: "high",
      priority: "must_fix",
      category: "security",
      confidence: 0.95,
      evidence: ["deleteSession(id);"],
      originatingAgent: "security",
    };
    const confirmed = "a".repeat(64);
    const omitted = "b".repeat(64);
    ledger.claim(job, 0, 100, "old-token");
    const pending = {
      findings: [finding, { ...finding, id: "unconfirmed", title: "A different finding" }],
      fingerprints: [confirmed, omitted],
      outcome: "NEEDS_ATTENTION" as const,
      cost: { ...complete.cost, totalEstimatedUsd: 0.25 },
    };
    expect(ledger.reservePublication(job.reviewId, "old-token", 1, pending)).toBe("send");
    expect(ledger.publicationState(job.reviewId)).toEqual({
      status: "publishing",
      leaseUntil: 100,
    });
    expect(ledger.getRecoverable(job.reviewId, 99)).toBeUndefined();
    expect(ledger.recoverPublication(job, 99, { id: 123, postedFingerprints: [confirmed] })).toBe(
      false,
    );
    const afterCrash = new Ledger(store);
    expect(afterCrash.getRecoverable(job.reviewId, 100)?.pending).toEqual(pending);
    const newerJob = { ...job, reviewId: "newer", headSha: "c".repeat(40) };
    afterCrash.claim(newerJob, 101, 100, "new-token");
    afterCrash.complete(newerJob, "new-token", 102, { ...complete, githubReviewId: 456 });
    expect(
      afterCrash.recoverPublication(job, 103, {
        id: 123,
        postedFingerprints: [confirmed, "invalid"],
      }),
    ).toBe(true);
    expect(store.readBaseline().headSha).toBe(newerJob.headSha);
    expect(store.readBaseline().findings).toEqual([finding]);
    expect(store.readBaseline().fingerprints).toEqual([confirmed]);
    expect(store.readJob(job.reviewId)).toMatchObject({
      status: "published",
      githubReviewId: 123,
      outcome: "NEEDS_ATTENTION",
      cost: pending.cost,
      pending: undefined,
    });
    expect(afterCrash.getRecoverable(job.reviewId, 104)).toBeUndefined();
    expect(afterCrash.publicationState(job.reviewId)).toEqual({
      status: "published",
      leaseUntil: 0,
      githubReviewId: 123,
    });
    expect(
      afterCrash.recoverPublication(job, 104, { id: 123, postedFingerprints: [confirmed] }),
    ).toBe(false);
    expect(afterCrash.claim(job, 105, 100, "retry").status).toBe("done");
  });

  it("recovers uncertain publications read-only while preserving another active owner's lease", () => {
    const { ledger, store } = memoryLedger();
    ledger.claim(job, 0, 100, "old-token");
    ledger.reservePublication(job.reviewId, "old-token", 1, complete);
    ledger.finish(job.reviewId, "old-token", 2, "failed");
    const newerJob = { ...job, reviewId: "newer", headSha: "c".repeat(40) };
    ledger.claim(newerJob, 3, 100, "new-token");
    expect(ledger.getRecoverable(job.reviewId, 4)?.status).toBe("uncertain");
    expect(
      ledger.recoverPublication({ ...job, headSha: newerJob.headSha }, 4, {
        id: 123,
        postedFingerprints: [],
      }),
    ).toBe(false);
    expect(ledger.recoverPublication(job, 4, { id: 123, postedFingerprints: [] })).toBe(true);
    expect(store.readActive()).toBe(newerJob.reviewId);
    expect(store.readBaseline().headSha).toBeUndefined();
    expect(ledger.reserveAnalysis(newerJob.reviewId, "new-token", 5)).toBe(true);
  });

  it("bounds the durable publication journal and keeps finding/fingerprint pairs aligned", () => {
    const { ledger, store } = memoryLedger();
    ledger.claim(job, 0, 100, "token");
    const findings: Finding[] = Array.from({ length: 30 }, (_, index) => ({
      id: String(index),
      title: `Issue ${index}`,
      description: "字".repeat(2000),
      path: "src/auth.ts",
      line: 2,
      severity: "high",
      priority: "must_fix",
      category: "security",
      confidence: 0.95,
      evidence: ["字".repeat(1500), "字".repeat(1500)],
      originatingAgent: "security",
    }));
    const fingerprints = findings.map((_, index) => index.toString(16).padStart(64, "0"));
    ledger.reservePublication(job.reviewId, "token", 1, { ...complete, findings, fingerprints });
    const pending = store.readJob(job.reviewId)!.pending!;
    expect(new TextEncoder().encode(JSON.stringify(pending)).byteLength).toBeLessThanOrEqual(
      128 * 1024,
    );
    expect(pending.findings.length).toBeLessThan(30);
    expect(pending.findings.length).toBe(pending.fingerprints.length);
    expect(
      pending.findings.every(
        (finding, index) => fingerprints[Number(finding.id)] === pending.fingerprints[index],
      ),
    ).toBe(true);
  });
  it("bounds serialized baseline bytes across Unicode findings, fingerprints and legacy oversized history", () => {
    const { ledger, store } = memoryLedger();
    const recent: Finding = {
      id: "recent",
      title: "Recent issue",
      description: "字".repeat(1000),
      path: "src/auth.ts",
      line: 2,
      severity: "high",
      priority: "must_fix",
      category: "security",
      confidence: 0.95,
      evidence: ["字".repeat(1500)],
      originatingAgent: "security",
    };
    store.writeBaseline({
      headSha: job.baseSha,
      baseSha: job.baseSha,
      findings: Array.from({ length: 200 }, (_, index) => ({
        ...recent,
        id: String(index),
        title: `Issue ${index}`,
      })),
      fingerprints: Array.from({ length: 2000 }, (_, index) =>
        index.toString(16).padStart(64, "0"),
      ),
    });
    expect(
      new TextEncoder().encode(JSON.stringify(store.readBaseline())).byteLength,
    ).toBeGreaterThan(1024 * 1024);
    const claim = ledger.claim(job, 0, 100, "token");
    expect(claim.status).toBe("acquired");
    if (claim.status !== "acquired") throw new Error("Expected acquired claim");
    expect(new TextEncoder().encode(JSON.stringify(claim.baseline)).byteLength).toBeLessThanOrEqual(
      128 * 1024,
    );
    expect(claim.baseline.findings.at(-1)?.title).toBe("Issue 199");
    ledger.complete(job, "token", 1, {
      ...complete,
      findings: [recent],
      fingerprints: ["f".repeat(64), "invalid"],
    });
    const persisted = store.readBaseline();
    expect(new TextEncoder().encode(JSON.stringify(persisted)).byteLength).toBeLessThanOrEqual(
      128 * 1024,
    );
    expect(persisted.findings.at(-1)).toEqual(recent);
    expect(persisted.fingerprints.at(-1)).toBe("f".repeat(64));
    expect(persisted.fingerprints).not.toContain("invalid");
    expect(persisted.headSha).toBe(job.headSha);
  });
  it("serializes reviews, checkpoints the completed SHA, and rejects duplicate completion", () => {
    const { ledger, store } = memoryLedger();
    expect(ledger.claim(job, 0, 100, "token").status).toBe("acquired");
    expect(ledger.claim({ ...job, reviewId: "review-b" }, 1, 100, "other").status).toBe("busy");
    expect(ledger.reservePublication(job.reviewId, "token", 2)).toBe("send");
    expect(ledger.reservePublication(job.reviewId, "token", 3)).toBe("reconcile");
    ledger.complete(job, "token", 4, complete);
    expect(store.readBaseline().headSha).toBe(job.headSha);
    expect(ledger.claim(job, 5, 100, "other").status).toBe("done");
    ledger.complete(job, "token", 6, complete);
    expect(store.readJob(job.reviewId)?.githubReviewId).toBe(123);
  });
  it("does not advance the incremental baseline after partial review", () => {
    const { ledger, store } = memoryLedger();
    ledger.claim(job, 0, 100, "token");
    ledger.complete(job, "token", 4, { ...complete, coverageComplete: false });
    expect(store.readBaseline().headSha).toBeUndefined();
  });
  it("never permits an expired lease to publish after another job acquires", () => {
    const { ledger } = memoryLedger();
    ledger.claim(job, 0, 100, "old");
    ledger.claim({ ...job, reviewId: "new" }, 101, 100, "new");
    expect(() => ledger.reservePublication(job.reviewId, "old", 102)).toThrow("REVIEW_LEASE_LOST");
    ledger.finish(job.reviewId, "old", 103, "failed");
    expect(ledger.reservePublication("new", "new", 104)).toBe("send");
  });
  it("preserves an uncertain publish after a failure and refuses automatic retries", () => {
    const { ledger, store } = memoryLedger();
    ledger.claim(job, 0, 100, "token");
    ledger.reservePublication(job.reviewId, "token", 1);
    ledger.finish(job.reviewId, "token", 2, "failed");
    expect(store.readJob(job.reviewId)?.status).toBe("uncertain");
    ledger.finish(job.reviewId, "token", 3, "failed");
    expect(store.readJob(job.reviewId)?.status).toBe("uncertain");
    expect(ledger.claim(job, 101, 100, "other").status).toBe("done");
  });
});
