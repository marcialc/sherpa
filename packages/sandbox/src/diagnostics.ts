// Only application-defined codes may reach logs; SDK errors can contain commands or source.
const repositoryFailureCodes = new Set([
  "SANDBOX_SUPERVISOR_FAILED",
  "INVALID_SANDBOX_RESPONSE",
  "REPOSITORY_COMMAND_TIMEOUT",
  "REPOSITORY_OUTPUT_LIMIT",
  "REPOSITORY_COMMAND_FAILED",
  "SESSION_ALREADY_PREPARED",
  "PULL_REQUEST_HEAD_CHANGED",
  "MERGE_BASE_UNAVAILABLE",
  "TOO_MANY_CHANGED_FILES",
  "INVALID_GIT_DIFF",
  "CHANGED_FILE_DIFF_LIMIT",
  "REVIEW_DIFF_LIMIT",
  "SANDBOX_ALREADY_BOUND",
  "SANDBOX_NOT_BOUND",
]);

export function repositoryFailureCode(error: unknown): string {
  return error instanceof Error && repositoryFailureCodes.has(error.message)
    ? error.message
    : "SANDBOX_UNAVAILABLE";
}
