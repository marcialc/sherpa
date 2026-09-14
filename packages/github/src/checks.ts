import { reviewJobSchema, type ReviewJob } from "@sherpa/schemas";
import { z } from "zod";
import type { AppIdentity } from "./auth";
import { GitHubApi, GitHubError, type Fetcher } from "./http";

export type CheckCompletion = {
  conclusion: "success" | "failure" | "skipped" | "cancelled" | "neutral";
  title: string;
  summary: string;
};
const checkSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  head_sha: z.string(),
  external_id: z.string().nullable(),
  app: z.object({ id: z.number().int().positive() }),
  status: z.enum(["queued", "in_progress", "completed", "waiting", "pending", "requested"]),
});
type CheckRun = z.infer<typeof checkSchema>;

/** Check credentials never need Contents or Pull requests write access. */
export class GitHubChecks {
  private readonly api: GitHubApi;
  constructor(
    token: string,
    private readonly identity: AppIdentity,
    fetcher?: Fetcher,
  ) {
    this.api = new GitHubApi(token, fetcher);
  }

  private owns(check: CheckRun, job: ReviewJob): boolean {
    return (
      check.name === "Sherpa" &&
      check.app.id === this.identity.appId &&
      check.head_sha === job.headSha &&
      check.external_id === job.reviewId
    );
  }

  async find(input: ReviewJob): Promise<number | undefined> {
    const job = reviewJobSchema.parse(input);
    for (let page = 1; page <= 10; page++) {
      const result = await this.api.request(
        `/repos/${job.owner}/${job.repo}/commits/${job.headSha}/check-runs?check_name=Sherpa&app_id=${this.identity.appId}&filter=all&per_page=100&page=${page}`,
      );
      const parsed = z
        .object({ check_runs: z.array(checkSchema).max(100) })
        .safeParse(result?.data);
      if (!parsed.success) throw new GitHubError("INVALID_GITHUB_CHECK_RESPONSE");
      const match = parsed.data.check_runs.find((check) => this.owns(check, job));
      if (match) return match.id;
      if (!result?.hasNext) return undefined;
    }
    // Do not create a duplicate if we could not finish checking existing runs.
    throw new GitHubError("GITHUB_CHECK_PAGINATION_LIMIT");
  }

  async queue(input: ReviewJob): Promise<number> {
    const job = reviewJobSchema.parse(input);
    const existing = await this.find(job);
    if (existing !== undefined) return existing;
    try {
      const result = await this.api.request(`/repos/${job.owner}/${job.repo}/check-runs`, {
        method: "POST",
        body: {
          name: "Sherpa",
          head_sha: job.headSha,
          external_id: job.reviewId,
          status: "queued",
          details_url: `https://github.com/${job.owner}/${job.repo}/pull/${job.number}`,
          output: {
            title: "Review queued",
            summary: "Waiting to review this pull request commit.",
          },
        },
      });
      const parsed = checkSchema.safeParse(result?.data);
      if (!parsed.success || !this.owns(parsed.data, job))
        throw new GitHubError("INVALID_GITHUB_CHECK_RESPONSE");
      return parsed.data.id;
    } catch (error) {
      // A lost response can follow a successful POST. Only read back; never resend here.
      if (error instanceof GitHubError && error.ambiguous) {
        const recovered = await this.find(job);
        if (recovered !== undefined) return recovered;
      }
      throw error;
    }
  }

  private async current(job: ReviewJob, id: number): Promise<CheckRun> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new GitHubError("INVALID_GITHUB_CHECK_ID");
    const result = await this.api.request(`/repos/${job.owner}/${job.repo}/check-runs/${id}`);
    const parsed = checkSchema.safeParse(result?.data);
    if (!parsed.success || parsed.data.id !== id || !this.owns(parsed.data, job))
      throw new GitHubError("GITHUB_CHECK_SCOPE_MISMATCH");
    return parsed.data;
  }

  async start(input: ReviewJob, id: number): Promise<void> {
    const job = reviewJobSchema.parse(input);
    const current = await this.current(job, id);
    if (current.status === "completed" || current.status === "in_progress") return;
    await this.api.request(`/repos/${job.owner}/${job.repo}/check-runs/${id}`, {
      method: "PATCH",
      body: {
        status: "in_progress",
        started_at: new Date().toISOString(),
        output: {
          title: "Review in progress",
          summary: "Inspecting the changes, investigating potential bugs, and verifying findings.",
        },
      },
    });
  }

  async complete(input: ReviewJob, id: number, completion: CheckCompletion): Promise<void> {
    const job = reviewJobSchema.parse(input);
    const current = await this.current(job, id);
    // Redelivery must not replace a real result with a duplicate/skipped result.
    if (current.status === "completed") return;
    await this.api.request(`/repos/${job.owner}/${job.repo}/check-runs/${id}`, {
      method: "PATCH",
      body: {
        status: "completed",
        completed_at: new Date().toISOString(),
        conclusion: completion.conclusion,
        output: { title: completion.title, summary: completion.summary },
      },
    });
  }
}
