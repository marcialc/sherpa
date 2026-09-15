# Repository index implementation plan

Inspection found a webhook Worker, review Workflow, SQLite PR ledger and installation settings Durable Objects, and fresh isolated repository Sandboxes. There is no existing bulk repository store. The model layer already supports installation-owned AI Gateway transport, validated structured output, and reservation-based budgets. Evidence is executor-owned; index data will never enter its schemas or stores.

1. Add a modular repository-index package with versioned types, deterministic JS/TS AST parsing, bounded summary generation, and scoped retrieval.
2. Use D1 for immutable file records, searchable terms, revision membership, and fenced build/publication state. Reuse unchanged Git blob records; publish only complete revisions. Reject truncated source trees.
3. Extend the existing GitHub API/token abstraction for immutable tree/blob reads. Index asynchronously in a separate Workflow on default-branch pushes; PR base events bootstrap discovery without blocking reviews.
4. Inject bounded untrusted discovery hints into planning and specialist ANALYZE only. Keep VERIFY, judge, RepositoryTools, evidence IDs and executor attestation unchanged.
5. Test parsing, incremental changes, retries/interruption, revision races, scope isolation, retrieval ranking, provider failure, and index-only evidence rejection. Run formatting, lint, typecheck, tests, and deployment dry run; review the full diff.

D1 is chosen for structured lookup and atomic publication without a repository-sized Durable Object. V1 combines exact symbol/path, lexical summary concepts, import relationships, and changed-file proximity. Embeddings/Vectorize are deferred: they need a separately budgeted installation-owned Gateway embedding transport and versioned vector lifecycle. Source code is not persisted in the index. Summary model settings and spend are independent of reviews.

The repository index is contextual retrieval data and is not admissible evidence for review findings.
