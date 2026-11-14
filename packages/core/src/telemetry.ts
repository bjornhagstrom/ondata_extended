/**
 * Per-call telemetry side channel and error classification.
 *
 * Tools note fields during a call; the host reads them back after the call and writes its
 * log line. Keyed by the McpServer instance, which the HTTP hosts create per request, so
 * concurrent requests in one isolate cannot read each other's fields.
 *
 * Derived from ondata/ckan-mcp-server src/utils/search-telemetry.ts and
 * src/utils/error-telemetry.ts (commit 09e8cdc), generalized from "search results" to any
 * fields.
 */

const notes = new WeakMap<object, Record<string, unknown>>();

export function noteTelemetry(server: object, fields: Record<string, unknown>): void {
  notes.set(server, { ...(notes.get(server) ?? {}), ...fields });
}

/** Returns and clears what was noted for this server instance. */
export function takeTelemetry(server: object): Record<string, unknown> | null {
  const value = notes.get(server) ?? null;
  notes.delete(server);
  return value;
}

const MAX_MESSAGE_LENGTH = 200;

export type ErrorKind = "validation" | "not_allowed" | "timeout" | "upstream_http" | "unreachable" | "other";

export interface ErrorTelemetry {
  error_message: string;
  error_kind: ErrorKind;
}

// First match wins. An HTTP status comes first: it is written by the server, while the text
// after it can be the upstream's own reason with any words in it. Then an input rejected
// before any request is "validation" even when its message mentions a URL, and a timeout is
// reported as such whatever wraps it.
const KINDS: [ErrorKind, RegExp][] = [
  ["upstream_http", /(?:API error|endpoint error|returned) \(?\d{3}\b/i],
  ["validation", /-32602|Input validation error|Invalid URL|Disallowed protocol/i],
  ["not_allowed", /not allowed|allowed list|SSRF/i],
  ["timeout", /timeout|timed out/i],
  ["unreachable", /Server not found|Network error|fetch failed|ENOTFOUND|ECONNREFUSED/i]
];

export function summarizeToolError(text: string): ErrorTelemetry {
  const message = text.replace(/\s+/g, " ").trim();
  const kind = KINDS.find(([, pattern]) => pattern.test(message))?.[0] ?? "other";
  return { error_message: message.slice(0, MAX_MESSAGE_LENGTH), error_kind: kind };
}
