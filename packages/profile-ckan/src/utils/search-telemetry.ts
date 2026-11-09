/**
 * Search results side channel for worker telemetry
 *
 * Ported from ondata/ckan-mcp-server src/utils/search-telemetry.ts at 09e8cdc (MIT, see
 * NOTICE.md). ondata kept the results in a WeakMap keyed by the McpServer instance; here they
 * go through `ctx.telemetry`, which the core keys the same way (per server instance) and the
 * Worker host reads back after the call.
 */

import type { EngineContext } from "@ondata-extended/profile-contract";

/** Max datasets kept per event: bounds the log line size. */
export const SEARCH_TELEMETRY_MAX_RESULTS = 20;
const MAX_FIELD_LENGTH = 100;

export interface SearchTelemetry {
  result_count: number;
  result_start: number;
  result_ids: string[];
  result_names: string[];
}

/**
 * Records the datasets the caller actually received: only those whose id or name
 * appears in `replyText`, so datasets dropped by the character limit are not
 * logged as shown. A missing name falls back to the id, as the replies do.
 */
export function searchTelemetry(
  count: number,
  start: number,
  datasets: { id?: string; name?: string }[],
  replyText: string
): SearchTelemetry {
  const shown = datasets.filter(
    (d) => (d.id && replyText.includes(d.id)) || (d.name && replyText.includes(d.name))
  );
  const kept = shown.slice(0, SEARCH_TELEMETRY_MAX_RESULTS);
  return {
    result_count: count,
    result_start: start,
    result_ids: kept.map((d) => String(d.id ?? "").slice(0, MAX_FIELD_LENGTH)),
    result_names: kept.map((d) => String(d.name || d.id || "").slice(0, MAX_FIELD_LENGTH))
  };
}

export function recordSearchResults(
  ctx: EngineContext,
  count: number,
  start: number,
  datasets: { id?: string; name?: string }[],
  replyText: string
): void {
  ctx.telemetry.note({ ...searchTelemetry(count, start, datasets, replyText) });
}
