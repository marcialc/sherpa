import type { CloudflareGatewayConfig } from "@sherpa/models";
import type { ReviewJob, ReviewResult } from "@sherpa/schemas";

export type GatewayStatus = {
  configured: boolean;
  accountId?: string;
  gatewayId?: string;
  updatedAt?: number;
};

export function publicGatewayStatus(
  stored: CloudflareGatewayConfig | null,
  updatedAt?: number,
): GatewayStatus {
  if (!stored) return { configured: false };
  return {
    configured: true,
    accountId: stored.accountId,
    gatewayId: stored.gatewayId,
    updatedAt,
  };
}

export function unconfiguredBillingResult(
  job: ReviewJob,
  risk: ReviewResult["risk"],
): ReviewResult {
  return {
    outcome: "REVIEW_FAILED",
    findings: [],
    cost: { totalEstimatedUsd: 0, calls: [], unpricedCalls: 0 },
    risk,
    warnings: ["BILLING_NOT_CONFIGURED"],
    reviewedHeadSha: job.headSha,
    incrementalBaseSha: job.baseSha,
    coverageComplete: false,
  };
}
