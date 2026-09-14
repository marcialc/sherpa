import { compareFindings, type ChangedFile, type Finding, type RepoConfig } from "@sherpa/schemas";

export { severityOrder } from "@sherpa/schemas";
export type PatchLine = { line: number; text: string };

export function addedLines(file: ChangedFile): PatchLine[] {
  if (!file.patch || file.patch.length > 65536) return [];
  const result: PatchLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let remainingNew = 0;
  let remainingOld = 0;
  let inHunk = false;
  const rows = file.patch.split("\n");
  if (rows.length > 10000) return [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (row === "" && index === rows.length - 1) continue;
    if (row.startsWith("@@")) {
      if (remainingNew || remainingOld) return [];
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(row);
      if (!hunk) return [];
      const oldStart = Number(hunk[1]);
      const newStart = Number(hunk[3]);
      if (inHunk && (oldStart < oldLine || newStart < newLine)) return [];
      oldLine = oldStart;
      newLine = newStart;
      remainingOld = Number(hunk[2] ?? 1);
      remainingNew = Number(hunk[4] ?? 1);
      if (
        [oldLine, newLine, remainingOld, remainingNew].some(
          (value) => !Number.isSafeInteger(value) || value > 10000000,
        ) ||
        (oldLine === 0 && remainingOld !== 0) ||
        (newLine === 0 && remainingNew !== 0)
      )
        return [];
      inHunk = true;
      continue;
    }
    if (!inHunk) return [];
    if (row === "\\ No newline at end of file") continue;
    const prefix = row[0];
    if (prefix !== "+" && prefix !== "-" && prefix !== " ") return [];
    if (prefix !== "+") {
      if (--remainingOld < 0) return [];
      oldLine++;
    }
    if (prefix !== "-") {
      if (--remainingNew < 0) return [];
      if (prefix === "+") result.push({ line: newLine, text: row.slice(1) });
      newLine++;
    }
  }
  return inHunk && !remainingNew && !remainingOld ? result : [];
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function words(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(" ")
      .filter((word) => word.length > 2),
  );
}
function similarity(a: string, b: string): number {
  const first = words(a);
  const second = words(b);
  if (!first.size || !second.size) return 0;
  return [...first].filter((word) => second.has(word)).length / Math.min(first.size, second.size);
}

export function sameFinding(a: Finding, b: Finding): boolean {
  if (a.path !== b.path || a.category !== b.category) return false;
  const evidenceOverlap = a.evidence.some((x) =>
    b.evidence.some((y) => normalize(x).length >= 12 && normalize(x) === normalize(y)),
  );
  return (
    (evidenceOverlap || Math.abs((a.line ?? 0) - (b.line ?? 0)) <= 3) &&
    similarity(`${a.title} ${a.description}`, `${b.title} ${b.description}`) >= 0.7
  );
}

export function groundedFinding(finding: Finding, files: ChangedFile[]): boolean {
  const file = files.find((item) => item.path === finding.path && item.status !== "removed");
  if (!file || !finding.line) return false;
  const changed = addedLines(file);
  const end = finding.line;
  const start = finding.startLine ?? end;
  if (end - start > 10 || !changed.some((item) => item.line === end)) return false;
  // Require a literal quotation from an added line in the cited range. Mere claims
  // of evidence, unchanged context and invented locations cannot pass this gate.
  return changed.some(
    (item) =>
      item.line >= start &&
      item.line <= end &&
      item.text.trim().length >= 8 &&
      finding.evidence.some((evidence) => evidence.includes(item.text.trim())),
  );
}

export function filterFindings(
  candidates: Finding[],
  files: ChangedFile[],
  config: RepoConfig,
  previous: Finding[] = [],
): Finding[] {
  const filtered: Finding[] = [];
  for (const finding of [...candidates].sort(compareFindings)) {
    if (finding.confidence < config.review.minimumConfidence || !groundedFinding(finding, files))
      continue;
    if (
      previous.some((old) => sameFinding(old, finding)) ||
      filtered.some((old) => sameFinding(old, finding))
    )
      continue;
    filtered.push(finding);
  }
  return filtered;
}
