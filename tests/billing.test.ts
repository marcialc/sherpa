import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "@sherpa/models";
import { publicGatewayStatus, unconfiguredBillingResult } from "../apps/worker/src/billing";
import { fixtureJob } from "./fixtures/pull-request";

const gateway = {
  accountId: "b".repeat(32),
  gatewayId: "customer-gateway",
  apiToken: "customer-token",
};
const risk = { score: 40, reasons: ["code"], agents: ["correctness" as const], skip: false };

describe("per-installation billing", () => {
  it("fails closed with no model cost when a Gateway is missing", () => {
    const result = unconfiguredBillingResult(fixtureJob, risk);
    expect(result).toMatchObject({
      outcome: "REVIEW_FAILED",
      findings: [],
      coverageComplete: false,
      warnings: ["BILLING_NOT_CONFIGURED"],
      cost: { totalEstimatedUsd: 0, calls: [], unpricedCalls: 0 },
    });
  });

  it("omits the token from public status", () => {
    expect(publicGatewayStatus(null)).toEqual({ configured: false });
    expect(publicGatewayStatus(gateway, 42)).toEqual({
      configured: true,
      accountId: gateway.accountId,
      gatewayId: gateway.gatewayId,
      updatedAt: 42,
    });
    expect(JSON.stringify(publicGatewayStatus(gateway, 42))).not.toContain(gateway.apiToken);
  });

  it("builds the provider from the installation Gateway, not an operator token", () => {
    const registry = createProviderRegistry({ cloudflareGateway: gateway });
    expect(Object.keys(registry)).toEqual(["cloudflare"]);
  });
});
