import { handleWebhook } from "./webhook";
import { dispatchReview } from "./dispatch";
import { handleSetup } from "./setup";
import type { RuntimeEnv } from "./settings";
export { ReviewWorkflow } from "./workflow";
export { ReviewLedger } from "./ledger";
export { InstallationSettings } from "./installation-settings";
export { ReviewSandbox, ContainerProxy } from "@sherpa/sandbox/cloudflare";

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET")
      return Response.json({ service: "sherpa", status: "ok" });
    if (url.pathname === "/github/webhook")
      return handleWebhook(request, {
        secret: env.GITHUB_WEBHOOK_SECRET,
        start: (job) => dispatchReview(env.REVIEW_WORKFLOW, job),
      });
    if (
      url.pathname === "/setup" ||
      url.pathname === "/setup/callback" ||
      url.pathname === "/setup/gateway"
    )
      return handleSetup(request, env);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<RuntimeEnv>;
