/**
 * Defence in depth for logs: even though LogFields is deliberately narrow, a value that
 * reaches a log should never be able to carry a credential we hold. Providers register
 * their key once and every log line is scrubbed against the registry.
 */
const secrets: string[] = [];

/** Register a credential so later log lines cannot echo it. */
export function registerSecret(secret: string): void {
  if (secret.length < 8) return;
  secrets.push(secret);
}

/** Replace any registered credential in a log value with a placeholder. */
export function redactSecrets(value: string): string {
  let out = value;
  for (const secret of secrets) {
    out = out.replace(new RegExp(secret), "[redacted]");
  }
  return out;
}
