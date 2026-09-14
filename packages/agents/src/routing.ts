import type { AgentName, ChangedFile, RepoConfig, RiskProfile } from "@sherpa/schemas";
import { policyGlobMatches, trustedRuleAgents } from "./policy";

export function routeReview(files: ChangedFile[], config: RepoConfig): RiskProfile {
  const isPolicyPath = (path: string) =>
    /(?:^|\/)(?:agents|security(?:[-_]policy)?|review[-_]rules)\.md$/i.test(path) ||
    /(?:^|\/)\.(?:ai-reviewer|sherpa)\.ya?ml$/i.test(path) ||
    config.instructionFiles.some((file) => file.path === path);
  const assigned = trustedRuleAgents(
    config,
    files.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]),
  );
  const agents = new Set<AgentName>(assigned);
  const reasons = new Set<string>();
  if (assigned.length) reasons.add("trusted-review-rule");
  let score = 0;
  const isDocumentation = (path: string) =>
    /\.(md|rst|txt)$/i.test(path) &&
    !/(?:^|\/)(?:requirements[^/]*|cmakelists)\.txt$/i.test(path) &&
    !isPolicyPath(path);
  const allDocs =
    files.length > 0 &&
    files.every(
      (file) =>
        isDocumentation(file.path) && (!file.previousPath || isDocumentation(file.previousPath)),
    );
  // Explicit trusted path rules are additive and can opt documentation into review.
  for (const file of files) {
    for (const [pattern, selected] of Object.entries(config.routing.paths)) {
      if (
        policyGlobMatches(pattern, file.path) ||
        (file.previousPath && policyGlobMatches(pattern, file.previousPath))
      ) {
        selected.forEach((agent) => agents.add(agent));
        reasons.add("configured-path");
      }
    }
  }
  if (allDocs && !agents.size) {
    return {
      score: 0,
      reasons: ["documentation-only"],
      agents:
        config.routing.docsOnly === "lightweight" && config.agents.lightweight
          ? ["lightweight"]
          : [],
      skip: config.routing.docsOnly === "skip" || !config.agents.lightweight,
    };
  }
  if (!files.length) return { score: 0, reasons: ["no-changes"], agents: [], skip: true };
  agents.add("correctness");
  for (const file of files) {
    const path = (
      file.previousPath ? `${file.previousPath}/${file.path}` : file.path
    ).toLowerCase();
    if (isPolicyPath(file.path) || (file.previousPath && isPolicyPath(file.previousPath))) {
      score = Math.max(score, 80);
      reasons.add("review-policy-change");
      agents.add("security");
      agents.add("correctness");
    }
    if (
      /(?:^|[/_.-])(auth|oauth|permission|session|token|secret|crypto|webhook|middleware|payment|billing|admin)(?:[/_.-]|$)/.test(
        path,
      ) ||
      /(?:^|\/)\.github\/workflows\//.test(path) ||
      /(?:^|\/)\.(?:sherpa|ai-reviewer)\.ya?ml(?:\/|$)/.test(path)
    ) {
      score = Math.max(score, 80);
      reasons.add("security-sensitive");
      agents.add("security");
      agents.add("testing");
    }
    if (
      /\b(?:authorize|isAuthenticated|verifyToken|authorization|permissions?|session|apiKey)\b/i.test(
        file.patch ?? "",
      )
    ) {
      score = Math.max(score, 75);
      reasons.add("security-sensitive-code");
      agents.add("security");
      agents.add("testing");
    }
    if (
      /(?:^|\/)(?:cmakelists\.txt|makefile|dockerfile|build\.gradle)(?:\/|$)|\.(?:cmake|mk|mdx)$/.test(
        path,
      )
    ) {
      score = Math.max(score, 55);
      reasons.add("executable-build-or-content");
      agents.add("security");
      agents.add("testing");
    }
    if (
      /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.(?:toml|lock)|go\.(?:mod|sum)|requirements[^/]*\.txt|poetry\.lock|pyproject\.toml|gemfile(?:\.lock)?|composer\.(?:json|lock))$/.test(
        path,
      )
    ) {
      score = Math.max(score, 45);
      reasons.add("dependency-change");
      agents.add("security");
      agents.add("testing");
    }
    if (/\.(?:ts|tsx|mts|cts)(?:\/|$)/.test(path)) {
      agents.add("types");
      agents.add("testing");
      score = Math.max(score, 25);
      reasons.add("type-sensitive");
    }
    if (
      /(?:^|[/_.-])(db|database|query|cache|migration|pagination|worker|queue)(?:[/_.-]|$)/.test(
        path,
      ) ||
      /\.sql$/.test(path)
    ) {
      agents.add("performance");
      agents.add("testing");
      score = Math.max(score, 65);
      reasons.add("data-or-concurrency");
    }
    if (file.status === "removed" || file.status === "renamed") {
      score = Math.max(score, 40);
      reasons.add("interface-change");
    }
  }
  const size = files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (size > 500 || files.length > 20) {
    score = Math.max(score, 65);
    agents.add("testing");
    reasons.add("large-change");
  }
  if (
    score < 25 &&
    size <= 80 &&
    agents.size === 1 &&
    !assigned.length &&
    !reasons.has("configured-path")
  ) {
    agents.clear();
    agents.add("lightweight");
    reasons.add("small-change");
  }
  const selected = [...agents].filter((agent) => config.agents[agent]);
  return { score, reasons: [...reasons], agents: selected, skip: false };
}
