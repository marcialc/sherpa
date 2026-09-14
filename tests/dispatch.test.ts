import { describe, expect, it, vi } from "vitest";
import { dispatchReview, type WorkflowLauncher } from "../apps/worker/src/dispatch";
import { fixtureJob } from "./fixtures/pull-request";

describe("durable Workflow dispatch", () => {
  it("propagates a start failure when existence cannot be established", async () => {
    const workflows: WorkflowLauncher = {
      create: () => Promise.reject(new Error("UNAVAILABLE")),
      get: () => Promise.reject(new Error("NOT_FOUND")),
    };
    await expect(dispatchReview(workflows, fixtureJob)).rejects.toThrow("UNAVAILABLE");
  });
  it("confirms a successful create after its response was lost", async () => {
    const create = vi.fn(() => Promise.reject(new Error("LOST_RESPONSE")));
    const workflows: WorkflowLauncher = {
      create,
      get: () =>
        Promise.resolve({
          status: () => Promise.resolve({ status: "running" }),
          restart: () => Promise.resolve(),
        }),
    };
    expect(await dispatchReview(workflows, fixtureJob)).toBe("duplicate");
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("dispatches only read-only recovery for an errored original review", async () => {
    const create = vi
      .fn<WorkflowLauncher["create"]>()
      .mockRejectedValueOnce(new Error("EXISTS"))
      .mockResolvedValueOnce({});
    const workflows: WorkflowLauncher = {
      create,
      get: () =>
        Promise.resolve({
          status: () => Promise.resolve({ status: "errored" }),
          restart: () => Promise.resolve(),
        }),
    };
    expect(await dispatchReview(workflows, fixtureJob)).toBe("duplicate");
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      id: `${fixtureJob.reviewId}-recovery`,
      params: { recoveryOnly: true },
    });
  });
  it("restarts only the recovery instance on later redelivery", async () => {
    const restartOriginal = vi.fn(() => Promise.resolve());
    const restartRecovery = vi.fn(() => Promise.resolve());
    const workflows: WorkflowLauncher = {
      create: () => Promise.reject(new Error("EXISTS")),
      get: (id) =>
        Promise.resolve({
          status: () => Promise.resolve({ status: "errored" }),
          restart: id.endsWith("-recovery") ? restartRecovery : restartOriginal,
        }),
    };
    expect(await dispatchReview(workflows, fixtureJob)).toBe("duplicate");
    expect(restartOriginal).not.toHaveBeenCalled();
    expect(restartRecovery).toHaveBeenCalledOnce();
  });
});
