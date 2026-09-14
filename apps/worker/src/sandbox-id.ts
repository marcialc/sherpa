/** Sandbox SDK IDs are limited to 63 characters. Keep the full per-attempt UUID
 * so retries and different installations never intentionally share a container. */
export function reviewSandboxId(reviewId: string): string {
  return `${reviewId.slice(0, 16)}-${crypto.randomUUID()}`;
}
