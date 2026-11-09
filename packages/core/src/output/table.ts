/**
 * Tabular output: rows as JSONL or CSV, cut on whole rows, with a trailing notice that survives
 * truncation. New in this core (not in ondata/ckan-mcp-server); the shape follows the row model
 * of ondata's italianparliament-mcp (src/tools/types.ts, src/server.ts formatResult, MIT), where
 * every tool returns rows and the server formats them centrally.
 *
 * Why not `truncateText`: it cuts characters from the end, which would cut a row in half and
 * drop exactly the trailing notice that tells the model the list is incomplete.
 */

import type { Row, TableOptions } from "@ondata-extended/profile-contract";

function csvEscape(value: string): string {
  if (value === "") return "";
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function columnsOf(rows: Row[], opts: TableOptions): string[] {
  return opts.columns ?? (rows[0] ? Object.keys(rows[0]) : []);
}

function render(rows: Row[], columns: string[], format: "jsonl" | "csv"): string {
  if (format === "csv") {
    return [columns.join(","), ...rows.map((r) => columns.map((c) => csvEscape(r[c] ?? "")).join(","))].join("\n");
  }
  // Same columns, same order as CSV and the structured channel.
  return rows.map((r) => JSON.stringify(Object.fromEntries(columns.map((c) => [c, r[c] ?? ""])))).join("\n");
}

const project = (rows: Row[], columns: string[]): Row[] => rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? ""])));

export interface FormattedTable {
  text: string;
  structured: { columns: string[]; rows: Row[]; total: number; truncated: boolean };
}

export function formatTable(rows: Row[], opts: TableOptions, limit: number): FormattedTable {
  const columns = columnsOf(rows, opts);
  const format = opts.format ?? "jsonl";
  if (rows.length === 0) {
    return { text: opts.emptyText, structured: { columns, rows: [], total: 0, truncated: false } };
  }
  const projected = project(rows, columns);
  const structuredFor = (kept: number) => ({ columns, rows: projected.slice(0, kept), total: rows.length, truncated: kept < rows.length });
  // Both channels must show the same rows: a prefix fits only if the text and the structured JSON both fit.
  const fits = (kept: number) => compose(kept).length <= limit && JSON.stringify(structuredFor(kept)).length <= limit;
  const compose = (kept: number) => {
    const parts = [render(rows.slice(0, kept), columns, format)];
    if (kept < rows.length) {
      parts.push(`[${kept} of ${rows.length} rows shown: the rest did not fit in the ${limit}-character limit. Narrow the query or page through it.]`);
    }
    if (opts.notice) parts.push(opts.notice);
    return parts.join("\n");
  };

  if (fits(rows.length)) return { text: compose(rows.length), structured: structuredFor(rows.length) };

  // Largest prefix that fits, by binary search (re-rendering per row would be quadratic).
  let low = 0;
  let high = rows.length - 1;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const text = compose(best);
  return { text: text.length <= limit ? text : text.slice(0, limit), structured: structuredFor(best) };
}

/** Text cut to the limit with `trailer` kept after it (e.g. a notice the model must see). */
export function truncateTextKeeping(text: string, trailer: string, limit: number): string {
  const joined = `${text}\n${trailer}`;
  if (joined.length <= limit) return joined;
  const marker = `\n\n... [Response truncated at ${limit} characters]\n`;
  const room = limit - marker.length - trailer.length;
  if (room <= 0) return trailer.slice(0, limit);
  return text.slice(0, room) + marker + trailer;
}
