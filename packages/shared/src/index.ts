import { redactSecrets } from "./redact";
export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("BODY_TOO_LARGE");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export { registerSecret } from "./redact";

export type LogFields = {
  reviewId?: string;
  installationId?: number;
  repositoryId?: number;
  pr?: number;
  stage?: string;
  durationMs?: number;
  count?: number;
  outcome?: string;
  code?: string;
  model?: string;
  /** The provider's own error identifier, and the request parameter it blamed. */
  providerCode?: string;
  param?: string;
  /**
   * A rejected repository tool: which tool, which rule refused it, and the line span it
   * asked for. No path and no output -- naming the rule and the number is enough to say
   * what the model did wrong, without putting repository content in a log.
   */
  tool?: string;
  reason?: string;
  span?: number;
  agent?: string;
  totalEstimatedUsd?: number;
};
/** Deliberately narrow fields: error bodies, model text and repository content never enter logs. */
export function log(event: string, fields: LogFields = {}): void {
  console.log(redactSecrets(JSON.stringify({ event, ...fields })));
}
export async function hashText(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
