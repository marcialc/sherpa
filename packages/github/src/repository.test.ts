import { describe, expect, it, vi } from "vitest";
import { GitHubRepositorySource } from "./repository";
const repository = { installationId: 17, repositoryId: 42, owner: "acme", repo: "example" };
const commitSha = "a".repeat(40),
  treeSha = "b".repeat(40),
  blobSha = "c".repeat(40);
const code = "export const value = 1;";
const entry = {
  path: "src/example.ts",
  mode: "100644",
  type: "blob",
  sha: blobSha,
  size: code.length,
};
function source(
  options: { tree?: unknown; blob?: unknown; metadata?: unknown; maxFileBytes?: number } = {},
) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const value = url.includes("/git/commits/")
      ? { sha: commitSha, tree: { sha: treeSha } }
      : url.includes("/git/trees/")
        ? (options.tree ?? { sha: treeSha, truncated: false, tree: [entry] })
        : url.includes("/git/blobs/")
          ? (options.blob ?? {
              sha: blobSha,
              encoding: "base64",
              size: code.length,
              content: btoa(code),
            })
          : url.includes("/git/ref/")
            ? { object: { type: "commit", sha: commitSha } }
            : (options.metadata ?? {
                id: 42,
                name: "example",
                owner: { login: "acme" },
                default_branch: "release/main",
              });
    return Response.json(value);
  });
  return {
    source: new GitHubRepositorySource(repository, "private-token", fetcher, options.maxFileBytes),
    fetcher,
  };
}
describe("immutable index source", () => {
  it("permits bounded ignore files even when the source file cap is lower", async () => {
    const contents = "# ignore rules\n".repeat(100);
    const github = source({
      maxFileBytes: 1024,
      tree: {
        sha: treeSha,
        truncated: false,
        tree: [{ ...entry, path: "nested/.gitignore", size: contents.length }],
      },
      blob: { sha: blobSha, encoding: "base64", size: contents.length, content: btoa(contents) },
    }).source;
    await github.listFiles(commitSha);
    expect(await github.readFile(commitSha, "nested/.gitignore", blobSha)).toBe(contents);
  });

  it("preserves a UTF8 BOM so byte accounting and parser offsets use the original source", async () => {
    const withBom = "\ufeff" + code;
    const bytes = new TextEncoder().encode(withBom);
    const github = source({
      tree: { sha: treeSha, truncated: false, tree: [{ ...entry, size: bytes.length }] },
      blob: {
        sha: blobSha,
        encoding: "base64",
        size: bytes.length,
        content: btoa(String.fromCharCode(...bytes)),
      },
    }).source;
    await github.listFiles(commitSha);
    expect(await github.readFile(commitSha, entry.path, blobSha)).toBe(withBom);
  });

  it("resolves a commit tree then reads only its exact immutable path/blob membership", async () => {
    const { source: github, fetcher } = source();
    expect(await github.listFiles(commitSha)).toEqual([
      { path: entry.path, blobSha, size: code.length },
    ]);
    expect(await github.readFile(commitSha, entry.path, blobSha)).toBe(code);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://api.github.com/repos/acme/example/git/commits/${commitSha}`,
    );
    await expect(github.readFile("d".repeat(40), entry.path, blobSha)).rejects.toThrow(
      "INDEX_FILE_REVISION_MISMATCH",
    );
    await expect(github.readFile(commitSha, "other.ts", blobSha)).rejects.toThrow(
      "INDEX_FILE_REVISION_MISMATCH",
    );
    await expect(github.readFile(commitSha, entry.path, "d".repeat(40))).rejects.toThrow(
      "INDEX_FILE_REVISION_MISMATCH",
    );
  });
  it("rejects truncated trees and duplicate paths rather than publishing partial data", async () => {
    for (const tree of [
      { sha: treeSha, truncated: true, tree: [entry] },
      { sha: treeSha, truncated: false, tree: [entry, entry] },
    ])
      await expect(source({ tree }).source.listFiles(commitSha)).rejects.toThrow();
  });
  it("excludes symlinks, submodules, directories and unsafe names", async () => {
    const tree = {
      sha: treeSha,
      truncated: false,
      tree: [
        entry,
        { ...entry, path: "secret-link.ts", mode: "120000" },
        { ...entry, path: "vendor", mode: "160000", type: "commit" },
        { ...entry, path: "src", mode: "040000", type: "tree" },
        { ...entry, path: "../secret.ts" },
      ],
    };
    expect(await source({ tree }).source.listFiles(commitSha)).toHaveLength(1);
  });
  it("validates returned blob identity, exact size, encoding and UTF8", async () => {
    const base = { sha: blobSha, encoding: "base64", size: code.length, content: btoa(code) };
    for (const blob of [
      { ...base, sha: commitSha },
      { ...base, size: 1 },
      { ...base, content: "!invalid" },
      { ...base, content: btoa("x") },
      { ...base, content: btoa("\xff".repeat(code.length)) },
    ]) {
      const github = source({ blob }).source;
      await github.listFiles(commitSha);
      await expect(github.readFile(commitSha, entry.path, blobSha)).rejects.toThrow();
    }
  });
  it("does not fetch oversized files or expose the credential in failures", async () => {
    const { source: github, fetcher } = source({
      tree: { sha: treeSha, truncated: false, tree: [{ ...entry, size: 200000 }] },
    });
    await github.listFiles(commitSha);
    await expect(github.readFile(commitSha, entry.path, blobSha)).rejects.not.toThrow(
      "private-token",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("checks repository identity before deciding whether a default branch revision is current", async () => {
    const { source: github, fetcher } = source();
    expect(await github.isCurrentDefaultRevision(commitSha)).toBe(true);
    expect(await github.isCurrentDefaultRevision(treeSha)).toBe(false);
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/acme/example/git/ref/heads/release/main",
    );
    await expect(
      source({
        metadata: { id: 99, name: "example", owner: { login: "acme" }, default_branch: "main" },
      }).source.currentDefaultSha(),
    ).rejects.toThrow("GITHUB_REPOSITORY_SCOPE_MISMATCH");
  });
});
