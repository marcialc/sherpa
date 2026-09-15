import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  gateway: vi.fn(),
  summarize: vi.fn(),
  summaryFactory: vi.fn(),
  options: [] as Array<{ summarize?: unknown }>,
}));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("@sherpa/github", () => ({
  GitHubApp: class {
    installationRepositoryToken() {
      return Promise.resolve("private-token");
    }
  },
  GitHubRepositorySource: class {},
}));
vi.mock("../apps/worker/src/settings", () => ({ getSettings: () => ({ pricing: {} }) }));
vi.mock("@sherpa/repository-index", async (original) => {
  const actual = await original<typeof import("@sherpa/repository-index")>();
  return {
    ...actual,
    RepositoryIndexer: class {
      constructor(_store: unknown, _source: unknown, options: { summarize?: unknown }) {
        mocks.options.push(options);
      }
      build = mocks.build;
    },
    D1RepositoryIndexStore: class {},
    createFileSummaryGenerator: mocks.summaryFactory,
  };
});
import { RepositoryIndexWorkflow } from "../apps/worker/src/index-workflow";
import { logIndex } from "../apps/worker/src/index-logging";
const job = {
  installationId: 17,
  repositoryId: 42,
  owner: "acme",
  repo: "example",
  commitSha: "a".repeat(40),
  trigger: "push" as const,
  deliveryId: "one",
  indexId: "b".repeat(64),
};
function workflow() {
  const workflow = Object.create(RepositoryIndexWorkflow.prototype) as RepositoryIndexWorkflow;
  Object.assign(workflow, {
    env: {
      INDEX_ENABLED: "true",
      INDEX_CONFIG_JSON: "{}",
      INDEX_MODEL: "openai/gpt-4.1-mini",
      INDEX_DB: { withSession: vi.fn(() => ({})) },
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "private-key",
      INSTALLATION_SETTINGS: { getByName: vi.fn(() => ({ getGateway: mocks.gateway })) },
    },
  });
  const step = {
    do: vi.fn(async (_name: string, _config: unknown, work: () => Promise<unknown>) => work()),
    sleep: vi.fn(async () => undefined),
  };
  const run = () =>
    workflow.run(
      { payload: job } as Parameters<typeof workflow.run>[0],
      step as unknown as Parameters<typeof workflow.run>[1],
    );
  return { run, step };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.options.length = 0;
  mocks.build.mockResolvedValue({ status: "ready" });
  mocks.gateway.mockResolvedValue(null);
  mocks.summaryFactory.mockReturnValue({
    summarize: mocks.summarize,
    cost: () => ({ calls: [], totalEstimatedUsd: 0, unpricedCalls: 0 }),
  });
});
describe("index workflow boundaries", () => {
  it("indexes deterministic context without configured Gateway credentials", async () => {
    const { run, step } = workflow();
    expect(await run()).toEqual({ status: "ready" });
    expect(mocks.summaryFactory).not.toHaveBeenCalled();
    expect(mocks.options[0]?.summarize).toBeUndefined();
    expect(step.do.mock.calls[0]?.[1]).toMatchObject({
      retries: { limit: 0 },
      sensitive: "output",
    });
  });
  it("continues deterministic indexing when the Gateway settings service fails", async () => {
    mocks.gateway.mockRejectedValue(new Error("private-key"));
    const logging = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await workflow().run()).toEqual({ status: "ready" });
    expect(mocks.summaryFactory).not.toHaveBeenCalled();
    expect(JSON.stringify(logging.mock.calls)).not.toContain("private-key");
    logging.mockRestore();
  });
  it("waits only for busy builds, while paid failed attempts are not retried", async () => {
    mocks.build
      .mockResolvedValueOnce({ status: "busy" })
      .mockResolvedValueOnce({ status: "ready" });
    const first = workflow();
    expect(await first.run()).toEqual({ status: "ready" });
    expect(first.step.sleep).toHaveBeenCalledOnce();
    mocks.build.mockRejectedValue(new Error("private-source"));
    const second = workflow();
    const logging = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await second.run()).toEqual({ status: "failed" });
    expect(second.step.do).toHaveBeenCalledOnce();
    expect(second.step.sleep).not.toHaveBeenCalled();
    expect(JSON.stringify(logging.mock.calls)).not.toContain("private-source");
    logging.mockRestore();
  });
  it("uses the installation Gateway with a dedicated summary budget", async () => {
    const gateway = {
      accountId: "installation-account",
      gatewayId: "private",
      token: "installation-token",
    };
    mocks.gateway.mockResolvedValue(gateway);
    const logging = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await workflow().run();
    expect(mocks.summaryFactory).toHaveBeenCalledWith(
      expect.objectContaining({ gateway, maxUsd: 0.25, maxCalls: 20 }),
    );
    expect(mocks.options[0]?.summarize).toBe(mocks.summarize);
    expect(JSON.stringify(logging.mock.calls)).not.toContain("installation-token");
    logging.mockRestore();
  });
  it("logs only operational metrics and drops source, secrets and malformed codes", () => {
    const logging = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logIndex("index.failed", {
      installationId: 17,
      source: "proprietary",
      token: "secret",
      code: "source contents",
      filesParsed: 4,
    });
    expect(JSON.parse(String(logging.mock.calls[0]?.[0]))).toEqual({
      event: "index.failed",
      installationId: 17,
      filesParsed: 4,
    });
    logging.mockRestore();
  });
});
