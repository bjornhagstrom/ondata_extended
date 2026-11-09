/**
 * Cloudflare Workers entry for the CKAN deployment: ondata's `/`, `/health`, `/mcp`, its log line
 * and Analytics Engine data point per tool call, and its response headers.
 *
 * As ondata/ckan-mcp-server src/worker.ts at 09e8cdc (MIT, see NOTICE.md). The health counts are
 * taken from the registered profile (ondata wrote them by hand; they are equal: 20, 7, 6). The
 * version is ours (docs/DECISIONS.md). The service notices (headers, and the Markdown footer the
 * profile adds on Workers) are the deployment's: ondata's texts unless `CKAN_SERVICE_NOTICE`,
 * `CKAN_SERVICE_RECOMMENDATION` and `CKAN_DEMO_NOTICE` are set.
 */

import { createWorkerHandler, type AnalyticsEngineDataset, type ConfigSource, type Engine } from "@ondata-extended/core";
import { buildServer, createCkanEngine, profile, SERVER_VERSION } from "./server.js";
import { landingPage } from "./landing.js";

type Env = ConfigSource & { ANALYTICS?: AnalyticsEngineDataset };

const SINGLE_FIELDS = [
  "q", "fq", "query", "id", "name", "pattern", "resource_id", "format_filter", "sort", "rows", "limit",
  "country", "language", "has_datastore", "min_datasets"
];

/** ondata's log entry for a tool call (src/worker.ts:280-309): which arguments, and which are capped. */
export function ckanLogEntry(tool: string, a: Record<string, unknown>): Record<string, unknown> {
  const logEntry: Record<string, unknown> = { tool, server: a["server_url"] ?? a["endpoint_url"] ?? "" };
  for (const key of SINGLE_FIELDS) {
    if (a[key] !== undefined) logEntry[key] = a[key];
    // ondata logs sql capped, in its place in the list
    if (key === "limit" && a["sql"] !== undefined) logEntry["sql"] = String(a["sql"]).slice(0, 200);
  }
  // Paging and filters (since 2026-11-04): without them a repeated call cannot be
  // told from a paged or filtered one. Objects are logged as capped JSON strings.
  for (const key of ["page", "page_size", "offset", "distinct"] as const) {
    if (a[key] !== undefined) logEntry[key] = a[key];
  }
  for (const key of ["filters", "fields"] as const) {
    if (a[key] !== undefined) {
      const v = a[key];
      logEntry[key] = (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 200);
    }
  }
  return logEntry;
}

// One engine per isolate, not per request: it holds the cache, the rate limiter and the throttle.
let engine: Engine | undefined;

export default createWorkerHandler<Env>({
  buildServer: (env) => buildServer((engine ??= createCkanEngine(env))),
  health: () => ({
    status: "ok",
    version: SERVER_VERSION,
    tools: profile.tools.length,
    resources: profile.resources?.length ?? 0,
    prompts: profile.prompts?.length ?? 0,
    runtime: "cloudflare-workers"
  }),
  landing: (request) => landingPage(new URL(request.url)),
  logEntry: ckanLogEntry,
  analytics: (env) => env.ANALYTICS,
  dataPoint: (logEntry) => ({
    blobs: [
      String(logEntry["tool"] ?? ""),
      String(logEntry["server"] ?? ""),
      String(logEntry["q"] ?? logEntry["query"] ?? logEntry["id"] ?? ""),
      String(logEntry["status"] ?? ""),
      String(logEntry["country"] ?? "")
    ],
    doubles: [Number(logEntry["duration_ms"] ?? 0), logEntry["cache_hit"] ? 1 : 0],
    indexes: [String(logEntry["tool"] ?? "")]
  }),
  // ondata's values unless the deployment sets its own (wrangler.toml [vars])
  extraHeaders: (env) => ({
    "X-Service-Notice": env.CKAN_SERVICE_NOTICE || "Demo instance - 100k requests/day shared quota",
    "X-Recommendation": env.CKAN_SERVICE_RECOMMENDATION || "https://github.com/ondata/ckan-mcp-server#installation"
  })
});
