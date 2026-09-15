import { repositoryPathSchema, reviewJobSchema, shaSchema } from "@sherpa/schemas";
import { z } from "zod";
import { GitHubApi, GitHubError, type Fetcher } from "./http";

export const repositoryIdentitySchema = reviewJobSchema.pick({
  installationId: true,
  repositoryId: true,
  owner: true,
  repo: true,
});
export type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>;
export type RepositoryTreeFile = { path: string; blobSha: string; size: number };
const treeEntrySchema = z.object({
  path: z.string().min(1).max(4096),
  mode: z.enum(["100644", "100755", "040000", "120000", "160000"]),
  type: z.enum(["blob", "tree", "commit"]),
  sha: shaSchema,
  size: z.number().int().nonnegative().optional(),
});

/** Scoped immutable Git data for discovery. These responses are never review evidence. */
export class GitHubRepositorySource {
  private readonly api: GitHubApi;
  private readonly repository: RepositoryIdentity;
  private readonly prefix: string;
  private readonly manifests = new Map<string, Map<string, RepositoryTreeFile>>();
  private readonly maxFileBytes: number;
  constructor(
    repository: RepositoryIdentity,
    token: string,
    fetcher?: Fetcher,
    maxFileBytes = 131072,
  ) {
    this.maxFileBytes = z.number().int().min(1).max(1048576).parse(maxFileBytes);
    this.repository = repositoryIdentitySchema.parse(repository);
    this.prefix = `/repos/${this.repository.owner}/${this.repository.repo}`;
    this.api = new GitHubApi(token, fetcher);
  }

  async listFiles(commitSha: string): Promise<RepositoryTreeFile[]> {
    shaSchema.parse(commitSha);
    // Resolve the commit explicitly: a tree SHA must not masquerade as a commit revision.
    const commit = await this.api.request(`${this.prefix}/git/commits/${commitSha}`, {
      maxBytes: 262144,
    });
    const parsedCommit = z
      .object({ sha: z.literal(commitSha), tree: z.object({ sha: shaSchema }) })
      .safeParse(commit?.data);
    if (!parsedCommit.success) throw new GitHubError("INVALID_INDEX_COMMIT");
    const treeSha = parsedCommit.data.tree.sha;
    const response = await this.api.request(`${this.prefix}/git/trees/${treeSha}?recursive=1`, {
      maxBytes: 8 * 1024 * 1024,
    });
    const parsed = z
      .object({
        sha: z.literal(treeSha),
        truncated: z.literal(false),
        tree: z.array(treeEntrySchema).max(20000),
      })
      .safeParse(response?.data);
    if (!parsed.success) throw new GitHubError("INCOMPLETE_OR_INVALID_INDEX_TREE");
    const seen = new Set<string>();
    const files: RepositoryTreeFile[] = [];
    for (const entry of parsed.data.tree) {
      if (seen.has(entry.path)) throw new GitHubError("DUPLICATE_INDEX_TREE_PATH");
      seen.add(entry.path);
      // Gitlinks and symlinks cannot become file reads. Unsafe names are excluded.
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) continue;
      const path = repositoryPathSchema.safeParse(entry.path);
      if (!path.success) continue;
      if (entry.size === undefined) throw new GitHubError("INVALID_INDEX_BLOB_SIZE");
      files.push({ path: path.data, blobSha: entry.sha, size: entry.size });
    }
    this.manifests.set(commitSha, new Map(files.map((file) => [file.path, file])));
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(commitSha: string, path: string, blobSha: string): Promise<string> {
    shaSchema.parse(commitSha);
    repositoryPathSchema.parse(path);
    const file = this.manifests.get(commitSha)?.get(path);
    if (!file || file.blobSha !== blobSha) throw new GitHubError("INDEX_FILE_REVISION_MISMATCH");
    return this.readBlob(
      blobSha,
      file.size,
      /(^|\/)\.gitignore$/.test(path) ? Math.max(32768, this.maxFileBytes) : this.maxFileBytes,
    );
  }

  async isCurrentDefaultRevision(commitSha: string): Promise<boolean> {
    shaSchema.parse(commitSha);
    return (await this.currentDefaultSha()) === commitSha;
  }

  private async readBlob(
    blobSha: string,
    expectedSize: number,
    maxBytes = 131072,
  ): Promise<string> {
    shaSchema.parse(blobSha);
    z.number().int().min(1).max(1048576).parse(maxBytes);
    z.number().int().nonnegative().max(maxBytes).parse(expectedSize);
    const response = await this.api.request(`${this.prefix}/git/blobs/${blobSha}`, {
      maxBytes: Math.ceil(maxBytes * 1.5) + 4096,
    });
    const parsed = z
      .object({
        sha: z.literal(blobSha),
        size: z.literal(expectedSize),
        encoding: z.literal("base64"),
        content: z.string().max(Math.ceil(maxBytes * 1.5)),
      })
      .safeParse(response?.data);
    if (!parsed.success) throw new GitHubError("INVALID_INDEX_BLOB");
    try {
      const encoded = parsed.data.content.replace(/\s/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        throw new Error("INVALID_ENCODING");
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      if (bytes.byteLength !== expectedSize) throw new Error("INVALID_SIZE");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new GitHubError("INVALID_INDEX_BLOB_ENCODING");
    }
  }

  async currentDefaultSha(): Promise<string> {
    const response = await this.api.request(this.prefix, { maxBytes: 262144 });
    const parsed = z
      .object({
        id: z.literal(this.repository.repositoryId),
        name: reviewJobSchema.shape.repo,
        owner: z.object({ login: reviewJobSchema.shape.owner }),
        default_branch: z.string().min(1).max(255),
      })
      .safeParse(response?.data);
    if (
      !parsed.success ||
      parsed.data.name.toLowerCase() !== this.repository.repo.toLowerCase() ||
      parsed.data.owner.login.toLowerCase() !== this.repository.owner.toLowerCase()
    )
      throw new GitHubError("GITHUB_REPOSITORY_SCOPE_MISMATCH");
    const commit = await this.api.request(
      `${this.prefix}/git/ref/heads/${parsed.data.default_branch.split("/").map(encodeURIComponent).join("/")}`,
      { maxBytes: 262144 },
    );
    const parsedCommit = z
      .object({
        object: z.object({ type: z.literal("commit"), sha: shaSchema }),
      })
      .safeParse(commit?.data);
    if (!parsedCommit.success) throw new GitHubError("INVALID_DEFAULT_BRANCH_COMMIT");
    return parsedCommit.data.object.sha;
  }
}
