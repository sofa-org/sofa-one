/**
 * Sanitizes error messages to prevent leaking internal details to API consumers.
 *
 * Strips:
 * - Long hex values (0x followed by 16+ hex chars) → [hex]
 * - Internal URLs (http(s)://...) → [url]
 * - File paths (absolute or /src/...) → [path]
 * - Stack trace lines (at <method> ...) → removed
 * - Excessive whitespace → single space
 *
 * Truncates to `maxLength` characters.
 */
export function sanitizeErrorMessage(message: string, maxLength: number = 500): string {
  return message
    // Strip long hex values (addresses, hashes, calldata)
    .replace(/0x[a-fA-F0-9]{16,}/g, '[hex]')
    // Strip internal URLs that might leak hostnames, ports, paths
    .replace(/https?:\/\/[^\s,)"']+/gi, '[url]')
    // Strip absolute file paths (Unix and Windows)
    .replace(/(?:\/[\w.-]+){2,}|(?:[A-Za-z]:\\[\w.-]+(?:\\[\w.-]+)+)/g, '[path]')
    // Strip stack trace lines ("at FunctionName (file:line:col)" or "at file:line:col")
    .replace(/^\s*at\s+.*$/gm, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Extracts error text from an unknown error, similar to OpenfortService.getErrorText.
 * Concatenates shortMessage, message, details, and cause chain.
 */
export function getErrorText(error: unknown): string {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return error;

  const err = error as Record<string, unknown>;
  const parts: string[] = [];

  for (const key of ['shortMessage', 'message', 'details'] as const) {
    const value = err[key];
    if (typeof value === 'string' && value) parts.push(value);
  }

  // Include cause chain (one level deep)
  const cause = err.cause as Record<string, unknown> | undefined;
  if (cause && typeof cause === 'object') {
    for (const key of ['shortMessage', 'message', 'details'] as const) {
      const value = cause[key];
      if (typeof value === 'string' && value) parts.push(value);
    }
  }

  return parts.join(' ');
}