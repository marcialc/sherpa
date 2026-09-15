/** Only operational counters and fixed internal codes may enter index logs. */
export function logIndex(event: string, fields: Record<string, string | number | boolean>): void {
  const safe: Record<string, string | number | boolean> = {};
  const counters = new Set([
    "installationId",
    "repositoryId",
    "durationMs",
    "filesParsed",
    "filesReused",
    "filesSkipped",
    "summariesGenerated",
    "summaryAttempts",
    "embeddingOperations",
    "calls",
    "estimatedUsd",
    "unpricedCalls",
    "inputTokens",
    "outputTokens",
    "count",
    "resultCount",
    "latencyMs",
  ]);
  for (const [key, value] of Object.entries(fields)) {
    if (counters.has(key) && typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    if (key === "code" && typeof value === "string" && /^[A-Z_]{1,80}$/.test(value))
      safe[key] = value;
    if (key === "stale" && typeof value === "boolean") safe[key] = value;
    if (key === "mode" && (value === "initial" || value === "incremental")) safe[key] = value;
    if (
      key === "status" &&
      typeof value === "string" &&
      [
        "ready",
        "busy",
        "disabled",
        "superseded",
        "failed",
        "exact",
        "base",
        "stale",
        "missing",
        "building",
        "version-mismatch",
        "unavailable",
      ].includes(value)
    )
      safe[key] = value;
  }
  try {
    if (/^index\.[a-z_]{1,50}$/.test(event)) console.log(JSON.stringify({ event, ...safe }));
  } catch {
    /* Telemetry cannot fail a build. */
  }
}
