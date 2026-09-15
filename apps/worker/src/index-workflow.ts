import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { GitHubApp, GitHubRepositorySource } from "@sherpa/github";
import {
  RepositoryIndexer,
  D1RepositoryIndexStore,
  getIndexConfig,
  indexJobSchema,
  createFileSummaryGenerator,
  type RepositoryIndexJob,
} from "@sherpa/repository-index";
import { logIndex as log } from "./index-logging";
import { getSettings, type RuntimeEnv } from "./settings";

/** Discovery work has independent checkpoints, budget and failure behavior from review. */
export class RepositoryIndexWorkflow extends WorkflowEntrypoint<RuntimeEnv, RepositoryIndexJob> {
  async run(event: WorkflowEvent<RepositoryIndexJob>, step: WorkflowStep) {
    const job = indexJobSchema.parse(event.payload);
    const config = getIndexConfig(this.env);
    if (!config.enabled) return { status: "disabled" };
    // Retrying a busy lease has not spent model tokens. Paid build steps are never replayed.
    for (let attempt = 0; attempt < 31; attempt++) {
      const result = await step.do(
        `build-index-${attempt}`,
        {
          retries: { limit: 0, delay: "1 second" },
          timeout: "15 minutes",
          sensitive: "output",
        },
        async () => {
          try {
            const app = new GitHubApp({
              appId: this.env.GITHUB_APP_ID,
              privateKey: this.env.GITHUB_PRIVATE_KEY,
            });
            const source = new GitHubRepositorySource(
              job,
              await app.installationRepositoryToken(job),
              undefined,
              config.maxFileBytes,
            );
            const gateway = await this.env.INSTALLATION_SETTINGS.getByName(
              String(job.installationId),
            )
              .getGateway()
              .catch(() => {
                log("index.summary_unavailable", {
                  installationId: job.installationId,
                  repositoryId: job.repositoryId,
                  code: "INDEX_GATEWAY_UNAVAILABLE",
                });
                return null;
              });
            const summary =
              gateway && config.summaryLimit > 0
                ? createFileSummaryGenerator({
                    gateway,
                    model: config.model,
                    pricing: getSettings(this.env).pricing,
                    maxUsd: config.maxUsd,
                    maxCalls: config.summaryLimit,
                    deadline: Date.now() + config.maxDurationMs,
                  })
                : undefined;
            const result = await new RepositoryIndexer(
              new D1RepositoryIndexStore(this.env.INDEX_DB.withSession("first-primary")),
              source,
              {
                config,
                summarize: summary?.summarize,
                telemetry: (event, fields) => log(event, fields),
              },
            ).build(job);
            if (summary) {
              const cost = summary.cost();
              log("index.model_usage", {
                installationId: job.installationId,
                repositoryId: job.repositoryId,
                calls: cost.calls.length,
                estimatedUsd: cost.totalEstimatedUsd,
                unpricedCalls: cost.unpricedCalls,
                inputTokens: cost.calls.reduce((total, call) => total + (call.inputTokens ?? 0), 0),
                outputTokens: cost.calls.reduce(
                  (total, call) => total + (call.outputTokens ?? 0),
                  0,
                ),
              });
            }
            return result;
          } catch {
            log("index.failed", {
              installationId: job.installationId,
              repositoryId: job.repositoryId,
              code: "INDEX_WORKFLOW_FAILED",
            });
            return { status: "failed" };
          }
        },
      );
      if (result.status !== "busy") return result;
      if (attempt < 30) await step.sleep(`wait-for-index-${attempt}`, "30 seconds");
    }
    log("index.deferred", {
      installationId: job.installationId,
      repositoryId: job.repositoryId,
      code: "INDEX_BUSY",
    });
    return { status: "busy" };
  }
}
