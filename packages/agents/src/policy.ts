import {
  repoConfigSchema,
  repositoryPathSchema,
  type AgentName,
  type RepoConfig,
  type ReviewRule,
} from "@sherpa/schemas";

/** Literal characters, * within a segment, and ** across directories; never evaluates a regex. */
export function policyGlobMatches(pattern: string, path: string): boolean {
  if (pattern.length > 200 || path.length > 500) return false;
  if (pattern === "**") return true;
  const firstWildcard = pattern.indexOf("*");
  if (firstWildcard === -1) return pattern === path;
  const lastWildcard = pattern.lastIndexOf("*");
  let suffix = pattern.slice(lastWildcard + 1);
  // **/ may consume zero directories, so its slash is not a mandatory suffix.
  if (pattern[lastWildcard - 1] === "*" && suffix.startsWith("/")) suffix = suffix.slice(1);
  if (!path.startsWith(pattern.slice(0, firstWildcard)) || !path.endsWith(suffix)) return false;
  if (pattern.endsWith("/**") && firstWildcard === pattern.length - 2)
    return path.startsWith(pattern.slice(0, -2));
  let current = Array<boolean>(path.length + 1).fill(false);
  current[0] = true;
  for (let index = 0; index < pattern.length; index++) {
    const next = Array<boolean>(path.length + 1).fill(false);
    const character = pattern[index];
    const globstar = character === "*" && pattern[index + 1] === "*";
    if (globstar && pattern[index + 2] === "/") {
      let reachable = false;
      for (let position = 0; position <= path.length; position++) {
        reachable ||= current[position]!;
        next[position] =
          current[position]! || (reachable && position > 0 && path[position - 1] === "/");
      }
      index += 2;
    } else if (character === "*") {
      for (let position = 0; position <= path.length; position++)
        next[position] =
          current[position]! ||
          (position > 0 && next[position - 1]! && (globstar || path[position - 1] !== "/"));
      if (globstar) index++;
    } else {
      for (let position = 1; position <= path.length; position++)
        next[position] = current[position - 1]! && path[position - 1] === character;
    }
    current = next;
  }
  return current[path.length]!;
}

type ScopedRule = { instructions: string; paths: string[] };
export type TrustedRules = { rules: ScopedRule[]; truncated: boolean };
const encodedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
function specificity(pattern: string): number {
  return (
    pattern.split("/").filter((segment) => !segment.includes("*")).length * 1000 +
    pattern.replace(/\*/g, "").length
  );
}
function safePaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => repositoryPathSchema.safeParse(path).success))].slice(
    0,
    300,
  );
}

/** Input config must be loaded from the trusted base. Paths select policy; they never provide instructions. */
export function trustedRulesFor(
  config: RepoConfig,
  agent: AgentName | "judge",
  paths: string[],
  relevantAgents?: AgentName[],
): TrustedRules {
  const selectedPaths = safePaths(paths);
  const matching = config.reviewRules
    .flatMap((rule, index) => {
      if (
        rule.agents &&
        (agent === "judge"
          ? relevantAgents && !rule.agents.some((name) => relevantAgents.includes(name))
          : !rule.agents.includes(agent))
      )
        return [];
      const matchedPatterns = rule.paths.filter((pattern) =>
        selectedPaths.some((path) => policyGlobMatches(pattern, path)),
      );
      return matchedPatterns.length
        ? [
            {
              rule,
              index,
              score: Math.max(...matchedPatterns.map(specificity)),
              paths: matchedPatterns,
            },
          ]
        : [];
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const result: TrustedRules = { rules: [], truncated: paths.length > 300 };
  let usedBytes = encodedBytes(result);
  for (const match of matching) {
    const rule = { paths: match.paths, instructions: match.rule.instructions };
    const size = encodedBytes(rule) + (result.rules.length ? 1 : 0);
    if (result.rules.length >= 4 || usedBytes + size > 6144) {
      result.truncated = true;
      continue;
    }
    result.rules.push(rule);
    usedBytes += size;
  }
  return result;
}

/** Explicit agent assignments add reviewers; instructions never disable agents or grant tool access. */
export function trustedRuleAgents(config: RepoConfig, paths: string[]): AgentName[] {
  const selectedPaths = safePaths(paths);
  return [
    ...new Set(
      config.reviewRules.flatMap((rule) =>
        rule.paths.some((pattern) => selectedPaths.some((path) => policyGlobMatches(pattern, path)))
          ? (rule.agents ?? [])
          : [],
      ),
    ),
  ].filter((agent) => config.agents[agent]);
}

/** The callback must read exact immutable BASE blobs; never pass Sandbox or HEAD file readers. */
export async function loadTrustedPolicy(
  config: RepoConfig,
  readBaseFile: (path: string) => Promise<string | null>,
): Promise<RepoConfig> {
  const validated = repoConfigSchema.parse(config);
  const rules: ReviewRule[] = [...validated.reviewRules];
  const seen = new Set<string>();
  for (const file of validated.instructionFiles) {
    if (seen.has(file.path)) throw new Error("DUPLICATE_POLICY_FILE");
    seen.add(file.path);
    const instructions = await readBaseFile(file.path);
    if (instructions === null) throw new Error("TRUSTED_POLICY_FILE_MISSING");
    if (new TextEncoder().encode(instructions).byteLength > 2048)
      throw new Error("TRUSTED_POLICY_FILE_TOO_LARGE");
    const separator = file.path.lastIndexOf("/");
    const paths = [separator === -1 ? "**" : `${file.path.slice(0, separator)}/**`];
    rules.push({
      paths,
      instructions: instructions.trim(),
      ...(file.agents ? { agents: file.agents } : {}),
    });
  }
  // Parse the expanded form too; explicit files share the overall rule/text ceiling.
  return repoConfigSchema.parse({ ...validated, reviewRules: rules });
}
