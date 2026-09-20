/**
 * How long a provider asked us to wait before retrying. RFC 9110 allows either a delay in
 * seconds or an HTTP date, so both spellings are accepted and normalised to milliseconds.
 */
export function retryDelayMs(header: string | null): number {
  if (!header) return 0;
  if (/^\d+(\.\d+)?$/.test(header)) return Number(header);
  return Date.parse(header) - Date.now();
}
