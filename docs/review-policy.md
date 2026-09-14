# Trusted repository review policy

Sherpa reads `.ai-reviewer.yml` and enrolled instruction files at the PR's immutable **base commit SHA**. It verifies the live PR base and head before and after loading policy, and again before publishing. Changes to policy in the PR cannot weaken that PR's review. Those changes take effect for later PRs after they are merged into the base branch.

```yaml
reviewRules:
  - paths: ["migrations/**", "**/*.sql"]
    agents: [correctness, security]
    instructions: >-
      Check destructive changes, rollback plans, and compatibility while old
      and new application versions run together.
  - paths: ["**/*.tsx"]
    agents: [types, testing]
    instructions: >-
      Check component API compatibility and accessible names for controls.

instructionFiles:
  - path: AGENTS.md
  - path: migrations/AGENTS.md
    agents: [correctness, security]
```

`paths` use case-sensitive repository-relative patterns. `*` matches within one directory segment; `**` spans directories. `**/*.tsx` matches both `App.tsx` and `src/ui/App.tsx`. A rule applies only when at least one reviewed path matches. Omitted `agents` makes the instructions available to whichever reviewers are selected for those paths. Explicit agent assignments add those enabled reviewers to routing; they do not disable other reviewers.

Only `AGENTS.md` files explicitly listed in the base configuration are loaded as reviewer policy. There is no automatic discovery. A root `AGENTS.md` applies repository-wide; `migrations/AGENTS.md` applies only below `migrations/`. Agent restrictions on an enrolled file apply to its instructions. Other repository files, PR descriptions, and every file read from HEAD remain untrusted evidence rather than reviewer policy.

Changes to `AGENTS.md`, `SECURITY.md`, security-policy documents, `review-rules.md`, and reviewer configuration are themselves routed for security and correctness review, including renames away from these paths. Documentation-only skipping cannot hide these changes. Reviewers assess the proposed changes under the existing base policy; the proposed instruction text does not become active policy during that review.

Specific path rules are supplied before broad rules. Specialists receive rules relevant to their paths and domain. The final judge receives rules relevant to candidate paths and originating reviewer domains. These instructions guide review judgment; they cannot override system safety, grant shell or network access, expose credentials, alter service budgets, or enable project validation. Execution permissions still come from the separately validated base configuration and service settings.

Policy is bounded: at most 20 rules after expansion, 10 patterns per rule, 2,000 characters per instruction, and 24 KiB of instruction text in total. Up to six `AGENTS.md` files may be enrolled; each must fit within 2 KiB and the instruction character limit. Each model call receives at most four complete matching rules within a 6 KiB policy envelope. When applicable rules do not fit, review coverage is marked incomplete; instructions are never silently cut mid-rule. Missing or oversized enrolled base files fail policy loading.

Use narrowly scoped rules and short instructions. Unrelated rules consume neither the specialist's policy context nor the judge's policy context.
