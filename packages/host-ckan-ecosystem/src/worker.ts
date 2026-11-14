/**
 * Cloudflare Workers entry: GET /health and POST /mcp from the core; no landing page (GET / is 404) while this is
 * a proof of concept.
 */

import { createWorkerHandler, pickTelemetryFields, type AnalyticsEngineDataset, type ConfigSource, type Engine } from "@ondata-extended/core";
import { buildServer, createEcosystemEngine, profile, SERVER_NAME, SERVER_VERSION } from "./server.js";

type Env = ConfigSource & { ANALYTICS?: AnalyticsEngineDataset };

// One engine per isolate, not per request: it holds the cache, the rate limiter and the per-host
// throttle, which must span requests.
let engine: Engine | undefined;

export default createWorkerHandler<Env>({
  buildServer: (env) => buildServer((engine ??= createEcosystemEngine(env))),
  health: () => ({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION, tools: profile.tools.length, runtime: "cloudflare-workers" }),
  logEntry: (tool, args) => pickTelemetryFields(tool, args, profile.telemetryFields),
  analytics: (env) => env.ANALYTICS,
  dataPoint: (entry) => ({
    blobs: [String(entry.tool ?? ""), String(entry.query ?? entry.extension ?? entry.plugin ?? ""), String(entry.status ?? "")],
    doubles: [Number(entry.duration_ms ?? 0), entry.cache_hit ? 1 : 0],
    indexes: [String(entry.tool ?? "")]
  })
});
