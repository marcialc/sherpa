import {
  findingSchema,
  compareFindings,
  repositoryPathSchema,
  reviewJobSchema,
  shaSchema,
  type ChangedFile,
  type PullRequestContext,
  type ReviewJob,
  type ReviewResult,
  type FindingLimits,
} from "@sherpa/schemas";
import { z } from "zod";
import type { AppIdentity } from "./auth";
import { mapFindingToComment, type ReviewComment } from "./diff";
import { GitHubApi, GitHubError, utf8Prefix, type Fetcher } from "./http";
import {
  findingFingerprint,
  findingMarker,
  formatFinding,
  formatSummary,
  reviewMarker,
  reviewEvent,
  selectFindings,
} from "./review";
import { repositorySchema } from "./webhook";

const prSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(4096),
  body: z.string().max(65536).nullable(),
  draft: z.boolean(),
  state: z.enum(["open", "closed"]),
  changed_files: z.number().int().nonnegative(),
  base: z.object({ sha: shaSchema, repo: repositorySchema }),
  head: z.object({ sha: shaSchema }),
});
const fileSchema = z.object({
  filename: z.string().min(1).max(500),
  previous_filename: z.string().max(500).optional(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
});
const reviewSchema = z.object({
  id: z.number().int().positive(),
  body: z.string().max(100000).nullable(),
  commit_id: shaSchema,
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
  user: z.object({ login: z.string().max(150), type: z.string().max(50) }).nullable(),
});
const MAX_FILE_PAGES = 3;
const MAX_REVIEW_PAGES = 10;

export class GitHubClient {
  private readonly api: GitHubApi;
  constructor(
    token: string,
    fetcher?: Fetcher,
    private readonly identity?: AppIdentity,
  ) {
    this.api = new GitHubApi(token, fetcher);
  }

  private path(input: ReviewJob): string {
    const job = reviewJobSchema.parse(input);
    return `/repos/${job.owner}/${job.repo}/pulls/${job.number}`;
  }

  private async metadata(job: ReviewJob): Promise<z.infer<typeof prSchema>> {
    const response = await this.api.request(this.path(job), { maxBytes: 262144 });
    const result = prSchema.safeParse(response?.data);
    if (!result.success) throw new GitHubError("INVALID_GITHUB_PULL_REQUEST");
    const pr = result.data;
    if (
      pr.number !== job.number ||
      pr.base.repo.id !== job.repositoryId ||
      pr.base.repo.name.toLowerCase() !== job.repo.toLowerCase() ||
      pr.base.repo.owner.login.toLowerCase() !== job.owner.toLowerCase()
    )
      throw new GitHubError("GITHUB_REPOSITORY_SCOPE_MISMATCH");
    return pr;
  }

  async getPullRequest(job: ReviewJob): Promise<PullRequestContext> {
    const pr = await this.metadata(job);
    const files: ChangedFile[] = [];
    const seen = new Set<string>();
    let filesTruncated = false;
    let patchBytes = 0;
    let serializedFileBytes = 0;
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const response = await this.api.request(`${this.path(job)}/files?per_page=100&page=${page}`, {
        maxBytes: 4194304,
      });
      const parsed = z.array(fileSchema).max(100).safeParse(response?.data);
      if (!parsed.success) throw new GitHubError("INVALID_GITHUB_FILES");
      for (const file of parsed.data) {
        // Files with unsafe names remain unreviewed rather than becoming tool paths.
        if (!repositoryPathSchema.safeParse(file.filename).success) {
          filesTruncated = true;
          continue;
        }
        if (seen.has(file.filename)) throw new GitHubError("GITHUB_FILES_CHANGED_DURING_READ");
        seen.add(file.filename);
        const bytes = new TextEncoder().encode(file.patch ?? "").byteLength;
        const includePatch = bytes <= 65536 && patchBytes + bytes <= 163840;
        const previousPath = repositoryPathSchema.safeParse(file.previous_filename);
        const mapped: ChangedFile = {
          path: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          ...(previousPath.success ? { previousPath: previousPath.data } : {}),
          ...(includePatch && file.patch !== undefined ? { patch: file.patch } : {}),
        };
        const serializedBytes = new TextEncoder().encode(JSON.stringify(mapped)).byteLength;
        if (serializedFileBytes + serializedBytes > 245760) {
          filesTruncated = true;
          continue;
        }
        files.push(mapped);
        serializedFileBytes += serializedBytes;
        if (includePatch) patchBytes += bytes;
        else filesTruncated = true;
      }
      if (!response?.hasNext && parsed.data.length < 100) break;
      if (page === MAX_FILE_PAGES) filesTruncated = true;
    }
    filesTruncated ||= files.length < pr.changed_files;
    // File-list endpoints use the live PR. A second snapshot detects a mid-pagination push.
    const fresh = await this.metadata(job);
    if (
      fresh.head.sha !== pr.head.sha ||
      fresh.base.sha !== pr.base.sha ||
      fresh.changed_files !== pr.changed_files
    )
      throw new GitHubError("GITHUB_PR_CHANGED_DURING_READ");
    const title = utf8Prefix(pr.title, 1024);
    const body = utf8Prefix(pr.body ?? "", 8192);
    filesTruncated ||= title !== pr.title || body !== (pr.body ?? "");
    return {
      job,
      title,
      body,
      draft: pr.draft,
      state: pr.state,
      files,
      filesTruncated,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
    };
  }

  async isCurrent(job: ReviewJob): Promise<boolean> {
    const pr = await this.metadata(job);
    return pr.state === "open" && pr.head.sha === job.headSha && pr.base.sha === job.baseSha;
  }

  async getConfig(job: ReviewJob, baseSha: string): Promise<string | null> {
    return this.getTrustedFile(job, baseSha, ".ai-reviewer.yml");
  }

  async getTrustedFile(job: ReviewJob, baseSha: string, filePath: string): Promise<string | null> {
    reviewJobSchema.parse(job);
    shaSchema.parse(baseSha);
    repositoryPathSchema.parse(filePath);
    if (filePath.split("/").includes(".")) throw new GitHubError("INVALID_POLICY_PATH");
    if (baseSha !== job.baseSha) throw new GitHubError("CONFIG_MUST_USE_TRUSTED_BASE");
    const path = filePath.split("/").map(encodeURIComponent).join("/");
    const response = await this.api.request(
      `/repos/${job.owner}/${job.repo}/contents/${path}?ref=${baseSha}`,
      { maxBytes: 65536, allow404: true },
    );
    if (response === null) return null;
    const parsed = z
      .object({
        type: z.literal("file"),
        encoding: z.literal("base64"),
        size: z.number().int().nonnegative().max(32768),
        content: z.string().max(50000),
      })
      .safeParse(response.data);
    if (!parsed.success) throw new GitHubError("INVALID_REPOSITORY_CONFIG_RESPONSE");
    try {
      const encoded = parsed.data.content.replace(/\s/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("encoding");
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      if (bytes.byteLength > 32768 || bytes.byteLength !== parsed.data.size)
        throw new Error("size");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new GitHubError("INVALID_REPOSITORY_CONFIG_ENCODING");
    }
  }

  async findReview(job: ReviewJob): Promise<{ id: number; postedFingerprints: string[] } | null> {
    if (!this.identity || !/^[a-zA-Z0-9-]+\[bot\]$/.test(this.identity.botLogin))
      throw new GitHubError("GITHUB_APP_IDENTITY_REQUIRED");
    const marker = reviewMarker(job);
    for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
      const response = await this.api.request(
        `${this.path(job)}/reviews?per_page=100&page=${page}`,
        { maxBytes: 4194304 },
      );
      const parsed = z.array(reviewSchema).max(100).safeParse(response?.data);
      if (!parsed.success) throw new GitHubError("INVALID_GITHUB_REVIEWS");
      for (const review of parsed.data) {
        if (
          review.state !== "PENDING" &&
          review.user?.type === "Bot" &&
          review.user.login === this.identity.botLogin &&
          review.commit_id === job.headSha &&
          review.body?.split("\n").includes(marker)
        ) {
          const postedFingerprints = [
            ...new Set(
              Array.from(
                review.body.matchAll(/^<!-- sherpa:finding:([a-f0-9]{64}) -->$/gm),
                (match) => match[1]!,
              ),
            ),
          ];
          return { id: review.id, postedFingerprints };
        }
      }
      if (!response?.hasNext && parsed.data.length < 100) return null;
    }
    throw new GitHubError("GITHUB_RECONCILIATION_LIMIT");
  }

  async publishReview(
    job: ReviewJob,
    result: ReviewResult,
    options: {
      maxComments?: number;
      findingLimits?: Partial<FindingLimits>;
      setupOrigin?: string;
    } = {},
  ): Promise<{ id: number; postedFingerprints: string[] }> {
    if (result.reviewedHeadSha !== job.headSha) throw new GitHubError("STALE_REVIEW_RESULT");
    const findings = z.array(findingSchema).parse(result.findings).sort(compareFindings);
    if (
      !["PASS", "PASS_WITH_FINDINGS", "NEEDS_ATTENTION", "REVIEW_FAILED"].includes(result.outcome)
    )
      throw new GitHubError("INVALID_REVIEW_OUTCOME");
    const context = await this.getPullRequest(job);
    if (
      context.state !== "open" ||
      context.headSha !== job.headSha ||
      context.baseSha !== job.baseSha
    )
      throw new GitHubError("STALE_PULL_REQUEST");
    const prior = await this.findReview(job);
    if (prior) return prior;
    const comments: ReviewComment[] = [];
    const maxComments = z
      .number()
      .int()
      .min(0)
      .max(30)
      .parse(options.maxComments ?? 10);
    const summaries: Array<{ finding: (typeof findings)[number]; fingerprint: string }> = [];
    const fingerprints = new Set<string>();
    const unique: typeof summaries = [];
    for (const finding of findings) {
      const fingerprint = await findingFingerprint(finding);
      if (fingerprints.has(fingerprint)) continue;
      fingerprints.add(fingerprint);
      unique.push({ finding, fingerprint });
    }
    const selected = new Set(
      selectFindings(
        unique.map(({ finding }) => finding),
        options.findingLimits,
      ),
    );
    for (const { finding, fingerprint } of unique) {
      if (!selected.has(finding)) continue;
      summaries.push({ finding, fingerprint });
      const body = `${formatFinding(finding)}\n\n${findingMarker(fingerprint)}`;
      const comment = mapFindingToComment(finding, context.files, body);
      if (comment && comments.length < maxComments) comments.push(comment);
    }
    const postedFingerprints = summaries.map(({ fingerprint }) => fingerprint);
    const acceptedResult = { ...result, findings: unique.map(({ finding }) => finding) };
    const body = formatSummary(
      job,
      acceptedResult,
      summaries,
      postedFingerprints,
      options.setupOrigin,
    );
    // Refresh immediately before the single non-idempotent request. GitHub provides no conditional POST.
    const fresh = await this.metadata(job);
    if (fresh.state !== "open" || fresh.head.sha !== job.headSha || fresh.base.sha !== job.baseSha)
      throw new GitHubError("STALE_PULL_REQUEST");
    const response = await this.api.request(`${this.path(job)}/reviews`, {
      method: "POST",
      body: {
        commit_id: job.headSha,
        body,
        event: reviewEvent(acceptedResult),
        comments,
      },
      maxBytes: 262144,
    });
    const parsed = z.object({ id: z.number().int().positive() }).safeParse(response?.data);
    if (!parsed.success) throw new GitHubError("INVALID_GITHUB_PUBLISHED_REVIEW", undefined, true);
    return { id: parsed.data.id, postedFingerprints };
  }
}
