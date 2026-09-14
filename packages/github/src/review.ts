import {
  compareFindings,
  completedVerdict,
  findingLimitsSchema,
  findingSchema,
  type Finding,
  type FindingLimits,
  type FindingPriority,
  type ReviewJob,
  type ReviewResult,
} from "@sherpa/schemas";
import { sha256 } from "./webhook";
import { utf8Prefix } from "./http";

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Excludes line offsets so unchanged evidence survives inserted lines on synchronize. */
export async function findingFingerprint(input: Finding): Promise<string> {
  const finding = findingSchema.parse(input);
  return sha256(
    JSON.stringify([
      finding.path,
      finding.category,
      normalized(finding.title),
      (finding.relatedSymbols ?? []).map(normalized).sort(),
      finding.evidence.map(normalized).sort(),
    ]),
  );
}

export function reviewMarker(job: ReviewJob): string {
  // Opaque validated IDs prevent repository/model text from choosing the idempotency marker.
  if (!/^[a-f0-9]{64}$/.test(job.reviewId)) throw new Error("INVALID_REVIEW_ID");
  return `<!-- sherpa:review:${job.reviewId} -->`;
}

export function findingMarker(fingerprint: string): string {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("INVALID_FINDING_FINGERPRINT");
  return `<!-- sherpa:finding:${fingerprint} -->`;
}

/** Disable unsolicited mentions and prevent content from manufacturing hidden control markers. */
function safeMarkdown(value: string): string {
  return (
    value
      .replace(
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
        "[REDACTED PRIVATE KEY]",
      )
      .replace(
        /\b(?:gh[pousr]_[A-Za-z0-9_.-]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g,
        "[REDACTED CREDENTIAL]",
      )
      .replace(/\bBearer\s+[A-Za-z0-9_.+/=-]{16,}/gi, "Bearer [REDACTED]")
      .replace(/<!--/g, "&lt;!--")
      .replace(/@/g, "@\u200b")
      // eslint-disable-next-line no-control-regex -- Remove untrusted display control bytes from GitHub comments.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}

const priorities: Record<FindingPriority, { label: string; group: string; icon: string }> = {
  must_fix: { label: "Must Fix", group: "Must Fix", icon: "🔴" },
  should_fix: { label: "Should Fix", group: "Should Fix", icon: "🟠" },
  warning: { label: "Warning", group: "Warnings", icon: "🟡" },
  nit: { label: "Nit", group: "Nits", icon: "🔵" },
};
const orderedPriorities = ["must_fix", "should_fix", "warning", "nit"] as const;

/** Model text cannot create headings, lists, links or formatting in the review template. */
function prose(value: string, maxBytes: number): string {
  const safe = safeMarkdown(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
  if (new TextEncoder().encode(safe).byteLength <= maxBytes) return safe;
  return utf8Prefix(safe, Math.max(0, maxBytes - 3)).replace(/\\$/, "") + "…";
}

function location(finding: Finding): string {
  const path = `${safeMarkdown(finding.path)}${finding.line ? `:${finding.line}` : ""}`;
  if (!path.includes("`")) return `\`${path}\``;
  // HTML code handles unusual paths without allowing backticks to break out of a code span.
  return `<code>${path.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`;
}

export function formatFinding(finding: Finding): string {
  const priority = priorities[finding.priority];
  const category =
    finding.category === "types"
      ? "Types/API"
      : finding.category[0]!.toUpperCase() + finding.category.slice(1);
  let body = `${priority.icon} **${priority.label} · ${category}**\n\n**${prose(finding.title, 500)}**\n\n${prose(finding.description, 1200)}`;
  if (finding.suggestedFix) body += `\n\n**Fix:** ${prose(finding.suggestedFix, 650)}`;
  return body;
}

/** Presentation caps never remove accepted blockers. */
export function selectFindings(findings: Finding[], limits?: Partial<FindingLimits>): Finding[] {
  const parsed = findingLimitsSchema.parse(limits ?? {});
  const maximum: Record<FindingPriority, number> = {
    must_fix: Infinity,
    should_fix: parsed.shouldFix,
    warning: parsed.warnings,
    nit: parsed.nits,
  };
  const counts = { must_fix: 0, should_fix: 0, warning: 0, nit: 0 };
  return [...findings]
    .sort(compareFindings)
    .filter((finding) => ++counts[finding.priority] <= maximum[finding.priority]);
}

export function reviewEvent(result: ReviewResult): "APPROVE" | "COMMENT" | "REQUEST_CHANGES" {
  const verdict = completedVerdict(result);
  if (verdict === "NOT_APPROVED") return "REQUEST_CHANGES";
  if (verdict === "APPROVED") return "APPROVE";
  return "COMMENT";
}

type SummaryFinding = { finding: Finding; fingerprint: string };

function reviewNote(code: string): string {
  if (code.startsWith("ROUTER_"))
    return "Optional reviewer routing failed; the configured reviewers were still used.";
  const notes: Record<string, string> = {
    BILLING_NOT_CONFIGURED:
      "This GitHub App installation has no Cloudflare AI Gateway, so models were not called. Save a Gateway on the setup page, then push a new commit.",
    SANDBOX_UNAVAILABLE_DIFF_ONLY_REVIEW:
      "Repository access was unavailable; only the supplied diff was reviewed.",
    INCOMPLETE_DIFF_COVERAGE:
      "Some changed files or diff sections were unavailable or too large to review.",
    NO_ENABLED_REVIEWERS: "No reviewers were enabled for this change.",
    CANDIDATE_LIMIT: "The analysis limit was reached before all proposed findings could be judged.",
    JUDGE_INPUT_LIMIT: "Some proposed findings exceeded the judge's context limit.",
    JUDGE_CONTEXT_UNRESOLVED:
      "The judge could not obtain enough context to resolve every proposed finding.",
    JUDGE_CONTEXT_INCOMPLETE: "Some context requested by the judge was unavailable or truncated.",
    SPECIALIST_CONTEXT_INCOMPLETE:
      "Some context or validation requested by a reviewer was unavailable or truncated.",
  };
  if (notes[code]) return notes[code];
  if (/^[A-Z_]+$/.test(code)) return `A review step did not complete (${code}).`;
  return code;
}

export function trustedSetupOrigin(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.pathname !== "/" && url.pathname !== "") return undefined;
    if (url.protocol === "https:") return url.origin;
    if (url.protocol === "http:" && url.hostname === "localhost") return url.origin;
  } catch {
    return undefined;
  }
  return undefined;
}

export function formatSummary(
  job: ReviewJob,
  result: ReviewResult,
  summaryFindings: SummaryFinding[],
  allFingerprints: string[],
  setupOrigin?: string,
): string {
  const verdict = completedVerdict(result);
  const titles = {
    APPROVED: "✅ Approved",
    APPROVED_WITH_COMMENTS: "🟡 Approved With Comments",
    NOT_APPROVED: "❌ Not Approved",
  };
  let body = `## 🤖 AI Review\n\n### ${verdict ? titles[verdict] : "⚠️ Review Incomplete"}`;
  const counts = orderedPriorities
    .map((priority) => {
      const count = result.findings.filter((finding) => finding.priority === priority).length;
      const label =
        priorities[priority].label +
        (count !== 1 && (priority === "warning" || priority === "nit") ? "s" : "");
      return count ? `${count} ${label}` : null;
    })
    .filter((count) => count !== null);
  if (counts.length) body += `\n\n**${counts.join(" · ")}**`;
  if (verdict === "APPROVED") body += "\n\nNo blocking or meaningful issues found.";
  else if (verdict === "NOT_APPROVED") {
    const blockers = [...result.findings]
      .sort(compareFindings)
      .filter((finding) => finding.priority === "must_fix");
    body += `\n\nResolve ${blockers.length === 1 ? "the blocker" : "the blockers"} before merging: ${blockers
      .slice(0, 2)
      .map((finding) => prose(finding.title, 180))
      .join("; ")}${blockers.length > 2 ? `; and ${blockers.length - 2} more below` : ""}.`;
  } else if (verdict === "APPROVED_WITH_COMMENTS")
    body += "\n\nSafe to merge; review the non-blocking improvements below.";
  else
    body +=
      "\n\nReview could not be completed. No approval was issued; rerun the review before relying on it.";
  if (!result.coverageComplete && verdict === "NOT_APPROVED")
    body +=
      "\n\nReview coverage is incomplete. The confirmed blockers below still require changes; rerun the review for full coverage.";
  // All findings, including inline comments, appear in this compact overview.
  const entries = [...summaryFindings].sort((a, b) => compareFindings(a.finding, b.finding));
  const manifest = `\n\n${reviewMarker(job)}\n${allFingerprints.map(findingMarker).join("\n")}`;
  const entryBudget = Math.min(
    1800,
    Math.floor(
      (54000 - new TextEncoder().encode(manifest).byteLength) / Math.max(1, entries.length),
    ),
  );
  for (const priority of orderedPriorities) {
    const group = entries.filter(({ finding }) => finding.priority === priority);
    if (!group.length) continue;
    body += `\n\n### ${priorities[priority].icon} ${priorities[priority].group}`;
    for (const [index, { finding }] of group.entries()) {
      const indent = " ".repeat(String(index + 1).length + 2);
      const heading = `${index + 1}. **${prose(finding.title, 350)}**\n\n${indent}${location(finding)}`;
      const remaining = entryBudget - new TextEncoder().encode(heading).byteLength - 50;
      if (remaining < 120) throw new Error("REVIEW_SUMMARY_TOO_LARGE");
      const descriptionBudget = finding.suggestedFix ? Math.floor(remaining * 0.65) : remaining;
      body += `\n\n${heading}\n\n${indent}${prose(finding.description, Math.min(750, descriptionBudget))}`;
      if (finding.suggestedFix)
        body += `\n\n${indent}**Fix:** ${prose(finding.suggestedFix, Math.min(450, remaining - descriptionBudget))}`;
    }
  }
  const omitted = result.findings.length - entries.length;
  if (omitted > 0)
    body += `\n\n${omitted} lower-priority ${omitted === 1 ? "finding omitted" : "findings omitted"} by the configured display limits. Counts include all accepted findings.`;
  if (verdict === "APPROVED") {
    const areas = [
      ...new Set(
        result.risk.agents.map((agent) =>
          agent === "types"
            ? "types/API"
            : agent === "lightweight"
              ? "correctness and security (lightweight)"
              : agent,
        ),
      ),
    ];
    if (areas.length) body += `\n\n**Reviewed:**\n\n${areas.map((area) => `* ${area}`).join("\n")}`;
  }
  if (result.warnings.length) {
    // Operational diagnostics are separate from judge-accepted code Warnings and their counts.
    const notes = [...new Set(result.warnings.map(reviewNote))].slice(0, 3);
    body += `\n\nReview notes: ${notes.map((note) => prose(note, 250)).join(" ")}`;
  }
  const origin = trustedSetupOrigin(setupOrigin);
  if (result.warnings.includes("BILLING_NOT_CONFIGURED") && origin)
    body += `\n\nConfigure billing at ${origin}/setup`;
  body += `\n\nReviewed commit: \`${job.headSha}\`.`;
  // Keep a compact manifest in the review body, including fingerprints of inline findings.
  body += manifest;
  if (new TextEncoder().encode(body).byteLength > 60000)
    throw new Error("REVIEW_SUMMARY_TOO_LARGE");
  return body;
}
