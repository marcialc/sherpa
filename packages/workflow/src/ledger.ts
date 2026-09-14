import type { Finding, ReviewCost, ReviewJob, ReviewOutcome } from "@sherpa/schemas";

export type ReviewStatus =
  "running" | "publishing" | "published" | "failed" | "skipped" | "uncertain";
export type PublicationData = {
  findings: Finding[];
  /** Fingerprints correspond to findings at the same array index. */
  fingerprints: string[];
  outcome: ReviewOutcome;
  cost: ReviewCost;
};
export type JobRecord = {
  reviewId: string;
  headSha: string;
  token: string;
  status: ReviewStatus;
  leaseUntil: number;
  updatedAt: number;
  githubReviewId?: number;
  outcome?: ReviewOutcome;
  cost?: ReviewCost;
  analysisStarted?: boolean;
  pending?: PublicationData;
};
export type Baseline = {
  headSha?: string;
  baseSha?: string;
  findings: Finding[];
  fingerprints: string[];
};
export interface LedgerStore {
  readJob(reviewId: string): JobRecord | undefined;
  writeJob(job: JobRecord): void;
  readActive(): string | undefined;
  writeActive(reviewId?: string): void;
  readBaseline(): Baseline;
  writeBaseline(baseline: Baseline): void;
}
export type Claim =
  { status: "acquired"; token: string; baseline: Baseline } | { status: "busy" | "done" };

const MAX_BASELINE_BYTES = 128 * 1024;
const MAX_FINDING_BYTES = 96 * 1024;
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Retain complete recent findings while keeping claim checkpoints below platform limits. */
function boundedBaseline(input: Baseline): Baseline {
  const result: Baseline = {
    ...(input.headSha ? { headSha: input.headSha } : {}),
    ...(input.baseSha ? { baseSha: input.baseSha } : {}),
    findings: [],
    fingerprints: [],
  };
  let totalBytes = byteLength(result);
  let findingBytes = 0;
  for (const finding of input.findings.slice(-200).reverse()) {
    const size = byteLength(finding) + (result.findings.length ? 1 : 0);
    if (findingBytes + size > MAX_FINDING_BYTES) continue;
    result.findings.push(finding);
    findingBytes += size;
    totalBytes += size;
  }
  result.findings.reverse();
  const fingerprints = [
    ...new Set(input.fingerprints.filter((value) => /^[a-f0-9]{64}$/.test(value))),
  ]
    .slice(-2000)
    .reverse();
  for (const fingerprint of fingerprints) {
    const size = byteLength(fingerprint) + (result.fingerprints.length ? 1 : 0);
    if (totalBytes + size > MAX_BASELINE_BYTES) break;
    result.fingerprints.push(fingerprint);
    totalBytes += size;
  }
  result.fingerprints.reverse();
  return result;
}

function boundedCost(cost: ReviewCost): ReviewCost {
  const result: ReviewCost = {
    totalEstimatedUsd: cost.totalEstimatedUsd,
    unpricedCalls: cost.unpricedCalls,
    calls: [],
  };
  let bytes = byteLength(result);
  for (const call of cost.calls.slice(0, 100)) {
    const size = byteLength(call) + (result.calls.length ? 1 : 0);
    if (bytes + size > 24 * 1024) break;
    result.calls.push(call);
    bytes += size;
  }
  return result;
}

/** Keep pairs intact so recovery only restores findings confirmed by GitHub's manifest. */
function boundedPublication(data: PublicationData): PublicationData {
  const result: PublicationData = {
    findings: [],
    fingerprints: [],
    outcome: data.outcome,
    cost: boundedCost(data.cost),
  };
  let bytes = byteLength(result);
  for (let index = 0; index < Math.min(data.findings.length, 30); index++) {
    const finding = data.findings[index]!;
    const fingerprint = data.fingerprints[index];
    if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) continue;
    const size = byteLength(finding) + byteLength(fingerprint) + (result.findings.length ? 2 : 0);
    if (bytes + size > MAX_BASELINE_BYTES) continue;
    result.findings.push(finding);
    result.fingerprints.push(fingerprint);
    bytes += size;
  }
  return result;
}

/** All transitions are synchronous so a DO cannot interleave a second claimant. */
export class Ledger {
  constructor(private readonly store: LedgerStore) {}
  claim(job: ReviewJob, now: number, leaseMs: number, token: string): Claim {
    const existing = this.store.readJob(job.reviewId);
    if (existing && existing.headSha !== job.headSha) throw new Error("REVIEW_ID_MISMATCH");
    if (
      existing?.status === "running" &&
      existing.token === token &&
      existing.leaseUntil > now &&
      this.store.readActive() === job.reviewId
    ) {
      return { status: "acquired", token, baseline: boundedBaseline(this.store.readBaseline()) };
    }
    if (existing && ["published", "skipped", "uncertain", "publishing"].includes(existing.status))
      return { status: "done" };
    const activeId = this.store.readActive();
    const active = activeId ? this.store.readJob(activeId) : undefined;
    if (active && active.leaseUntil > now && ["running", "publishing"].includes(active.status))
      return { status: "busy" };
    this.store.writeJob({
      reviewId: job.reviewId,
      headSha: job.headSha,
      token,
      status: "running",
      leaseUntil: now + leaseMs,
      updatedAt: now,
      ...(existing?.analysisStarted ? { analysisStarted: true } : {}),
    });
    this.store.writeActive(job.reviewId);
    return { status: "acquired", token, baseline: boundedBaseline(this.store.readBaseline()) };
  }
  private owned(reviewId: string, token: string, now: number): JobRecord {
    const record = this.store.readJob(reviewId);
    if (
      !record ||
      record.token !== token ||
      record.leaseUntil <= now ||
      this.store.readActive() !== reviewId
    )
      throw new Error("REVIEW_LEASE_LOST");
    return record;
  }
  renew(reviewId: string, token: string, now: number, leaseMs: number): void {
    const record = this.owned(reviewId, token, now);
    this.store.writeJob({ ...record, leaseUntil: now + leaseMs, updatedAt: now });
  }
  reserveAnalysis(reviewId: string, token: string, now: number): boolean {
    const record = this.owned(reviewId, token, now);
    if (record.status !== "running") throw new Error("INVALID_REVIEW_TRANSITION");
    if (record.analysisStarted) return false;
    this.store.writeJob({ ...record, analysisStarted: true, updatedAt: now });
    return true;
  }
  reservePublication(
    reviewId: string,
    token: string,
    now: number,
    data?: PublicationData,
  ): "send" | "reconcile" {
    const record = this.owned(reviewId, token, now);
    if (
      record.status === "publishing" ||
      record.status === "uncertain" ||
      record.status === "published"
    )
      return "reconcile";
    if (record.status !== "running") throw new Error("INVALID_REVIEW_TRANSITION");
    this.store.writeJob({
      ...record,
      status: "publishing",
      updatedAt: now,
      ...(data ? { pending: boundedPublication(data) } : {}),
    });
    return "send";
  }
  getRecoverable(reviewId: string, now: number): JobRecord | undefined {
    const record = this.store.readJob(reviewId);
    return record &&
      (record.status === "uncertain" ||
        (record.status === "publishing" && record.leaseUntil <= now))
      ? record
      : undefined;
  }
  publicationState(
    reviewId: string,
  ):
    | { status: ReviewStatus; leaseUntil: number; githubReviewId?: number; outcome?: ReviewOutcome }
    | undefined {
    const record = this.store.readJob(reviewId);
    return record
      ? {
          status: record.status,
          leaseUntil: record.leaseUntil,
          ...(record.githubReviewId ? { githubReviewId: record.githubReviewId } : {}),
          ...(record.outcome ? { outcome: record.outcome } : {}),
        }
      : undefined;
  }
  recoverPublication(
    job: ReviewJob,
    now: number,
    published: { id: number; postedFingerprints: string[] },
  ): boolean {
    const record = this.getRecoverable(job.reviewId, now);
    if (
      !record ||
      record.headSha !== job.headSha ||
      !Number.isSafeInteger(published.id) ||
      published.id <= 0
    )
      return false;
    const confirmed = new Set(
      published.postedFingerprints.filter((value) => /^[a-f0-9]{64}$/.test(value)).slice(0, 30),
    );
    const findings =
      record.pending?.findings.filter((_, index) =>
        confirmed.has(record.pending!.fingerprints[index]!),
      ) ?? [];
    const previous = this.store.readBaseline();
    // A newer review may already have advanced the baseline. Recovery merges dedupe data only.
    this.store.writeBaseline(
      boundedBaseline({
        ...previous,
        findings: [...previous.findings, ...findings],
        fingerprints: [...previous.fingerprints, ...confirmed],
      }),
    );
    this.store.writeJob({
      ...record,
      pending: undefined,
      status: "published",
      githubReviewId: published.id,
      outcome: record.pending?.outcome ?? record.outcome,
      cost: record.pending?.cost ?? record.cost,
      updatedAt: now,
      leaseUntil: 0,
    });
    if (this.store.readActive() === job.reviewId) this.store.writeActive(undefined);
    return true;
  }
  complete(
    job: ReviewJob,
    token: string,
    now: number,
    data: {
      githubReviewId: number;
      findings: Finding[];
      fingerprints: string[];
      outcome: ReviewOutcome;
      cost: ReviewCost;
      coverageComplete: boolean;
    },
  ): void {
    const record = this.store.readJob(job.reviewId);
    if (record?.status === "published" && record.githubReviewId === data.githubReviewId) return;
    const owned = this.owned(job.reviewId, token, now);
    if (!["running", "publishing", "uncertain"].includes(owned.status))
      throw new Error("INVALID_REVIEW_TRANSITION");
    const previous = this.store.readBaseline();
    const baseline = boundedBaseline({
      ...previous,
      ...(data.coverageComplete ? { headSha: job.headSha, baseSha: job.baseSha } : {}),
      findings: [...previous.findings, ...data.findings].slice(-200),
      fingerprints: [...new Set([...previous.fingerprints, ...data.fingerprints])].slice(-2000),
    });
    this.store.writeBaseline(baseline);
    this.store.writeJob({
      ...owned,
      status: "published",
      githubReviewId: data.githubReviewId,
      outcome: data.outcome,
      cost: data.cost,
      pending: undefined,
      updatedAt: now,
      leaseUntil: 0,
    });
    this.store.writeActive(undefined);
  }
  finish(
    reviewId: string,
    token: string,
    now: number,
    status: "failed" | "skipped" | "uncertain",
  ): void {
    const record = this.store.readJob(reviewId);
    if (!record || record.token !== token || record.status === "published") return;
    // A crash during publish must never turn an uncertain write into a retryable analysis.
    const finalStatus =
      record.status === "publishing" || record.status === "uncertain" ? "uncertain" : status;
    this.store.writeJob({ ...record, status: finalStatus, updatedAt: now, leaseUntil: 0 });
    if (this.store.readActive() === reviewId) this.store.writeActive(undefined);
  }
}
