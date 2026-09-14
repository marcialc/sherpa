import type { ChangedFile, Finding } from "@sherpa/schemas";

export type DiffLines = {
  additions: Set<number>;
  rightHunks: Map<number, number>;
  deletionHunks: Set<number>;
};
export type ReviewComment = {
  path: string;
  body: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
};

/** Only complete, well-formed hunks can supply an anchor. Truncated patches fail closed. */
export function parsePatch(patch: string | undefined): DiffLines | null {
  if (!patch || patch.length > 65536) return null;
  const additions = new Set<number>();
  const rightHunks = new Map<number, number>();
  const deletionHunks = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let hunk = 0;
  const lines = patch.split("\n");
  if (lines.length > 10000) return null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line === "" && index === lines.length - 1) continue;
    if (line.startsWith("@@")) {
      if (oldRemaining || newRemaining) return null;
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
      if (!match) return null;
      const oldStart = Number(match[1]);
      const newStart = Number(match[3]);
      if (hunk && (oldStart < oldLine || newStart < newLine)) return null;
      oldLine = oldStart;
      newLine = newStart;
      oldRemaining = Number(match[2] ?? "1");
      newRemaining = Number(match[4] ?? "1");
      if (
        [oldLine, newLine, oldRemaining, newRemaining].some(
          (v) => !Number.isSafeInteger(v) || v > 10000000,
        ) ||
        (oldLine === 0 && oldRemaining !== 0) ||
        (newLine === 0 && newRemaining !== 0)
      )
        return null;
      hunk++;
      continue;
    }
    if (!hunk) return null;
    if (line === "\\ No newline at end of file") continue;
    const prefix = line[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") return null;
    if (prefix !== "+") {
      if (--oldRemaining < 0) return null;
      if (prefix === "-") deletionHunks.add(hunk);
      oldLine++;
    }
    if (prefix !== "-") {
      if (--newRemaining < 0 || rightHunks.has(newLine)) return null;
      rightHunks.set(newLine, hunk);
      if (prefix === "+") additions.add(newLine);
      newLine++;
    }
  }
  return hunk && !oldRemaining && !newRemaining ? { additions, rightHunks, deletionHunks } : null;
}

/** Finding lines refer to HEAD. Removed files and ambiguous locations go in the summary. */
export function mapFindingToComment(
  finding: Finding,
  files: ChangedFile[],
  body: string,
): ReviewComment | null {
  const file = files.find((candidate) => candidate.path === finding.path);
  if (!file || file.status === "removed" || !finding.line) return null;
  const diff = parsePatch(file.patch);
  if (!diff) return null;
  const hunk = diff.rightHunks.get(finding.line);
  // GitHub accepts RIGHT context lines; use them only beside an attested deletion.
  if (hunk === undefined || (!diff.additions.has(finding.line) && !diff.deletionHunks.has(hunk)))
    return null;
  const comment: ReviewComment = { path: finding.path, body, line: finding.line, side: "RIGHT" };
  const start = finding.startLine;
  if (start !== undefined && start !== finding.line) {
    if (start < 1 || start > finding.line || finding.line - start > 100) return null;
    for (let line = start; line <= finding.line; line++) {
      if (diff.rightHunks.get(line) !== diff.rightHunks.get(finding.line)) return null;
    }
    comment.start_line = start;
    comment.start_side = "RIGHT";
  }
  return comment;
}
