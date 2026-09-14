import type { ChangedFile, Finding, ReviewJob } from "@sherpa/schemas";
export const base = "a".repeat(40);
export const head = "b".repeat(40);
export const repository = {
  id: 22,
  name: "calculator",
  full_name: "acme/calculator",
  owner: { login: "acme" },
};
export const webhook = {
  action: "opened",
  number: 7,
  installation: { id: 11 },
  repository,
  pull_request: {
    number: 7,
    draft: false,
    state: "open",
    base: { sha: base, repo: repository },
    head: { sha: head },
  },
};
export const metadata = {
  ...webhook.pull_request,
  title: "Correct the addition helper",
  body: "Check handling of negative numbers.",
  changed_files: 1,
};
export const file: ChangedFile = {
  path: "src/math.js",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch:
    "@@ -1,3 +1,3 @@\n function add(left, right) {\n-  return left + right;\n+  return left - right;\n }",
};
export const apiFile = {
  filename: file.path,
  status: file.status,
  additions: file.additions,
  deletions: file.deletions,
  patch: file.patch,
};
export const finding: Finding = {
  id: "candidate",
  title: "Addition now subtracts its right operand",
  description: "Calling add(5, 2) now returns 3 instead of 7, breaking callers that expect a sum.",
  path: file.path,
  line: 2,
  severity: "high",
  priority: "must_fix",
  category: "correctness",
  confidence: 0.95,
  evidence: ["return left - right;"],
  originatingAgent: "lightweight",
};
export const fixtureJob: ReviewJob = {
  reviewId: "c".repeat(64),
  deliveryId: "test-delivery",
  installationId: 11,
  repositoryId: 22,
  owner: "acme",
  repo: "calculator",
  number: 7,
  baseSha: base,
  headSha: head,
  action: "opened",
};
