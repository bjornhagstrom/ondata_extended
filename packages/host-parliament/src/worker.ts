/**
 * Cloudflare Workers entry for the parliament deployment, as ondata/italianparliament-mcp
 * src/worker.ts at fd46810 (MIT, see NOTICE.md): `GET /` an info document in JSON, `GET /health`,
 * the CORS preflight on `/mcp`, `POST /mcp` stateless Streamable HTTP answered as an SSE stream,
 * and a plain 404 for everything else (also `GET /mcp`). No log line and no data point per call:
 * the original writes none.
 *
 * Differences (docs/parliament-port.md, "Round 4: host"): the version is ours and the tool count is
 * the profile's (P9, P10); the SDK's SSE headers (P11); an exception while serving `/mcp` gets the
 * core's generic "Internal error" instead of the exception's message (P12). One engine per isolate,
 * so the Senato throttle covers every request the isolate serves.
 */

import { createWorkerHandler, type ConfigSource, type Engine } from "@ondata-extended/core";
import { buildServer, createParliamentEngine, profile, SERVER_NAME, SERVER_VERSION } from "./server.js";

type Env = ConfigSource;

const JSON_CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

/** The original's info document at `/`, with our version and the number of tools this deployment serves. */
export function infoDocument(): Record<string, unknown> {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description: "MCP server for querying Italian Parliament SPARQL endpoints (Camera + Senato)",
    mcp_endpoint: "/mcp",
    tools: profile.tools.length
  };
}

// One engine per isolate, not per request: it holds the host policies, so the Senato throttle
// (>= 2 s between requests) spans every request this isolate serves, as the original's module-level
// throttle chain does.
let engine: Engine | undefined;

const mcp = createWorkerHandler<Env>({
  buildServer: (env) => buildServer((engine ??= createParliamentEngine(env))),
  health: () => ({ status: "ok", runtime: "cloudflare-workers" }),
  landing: () => new Response(JSON.stringify(infoDocument()), { headers: JSON_CORS }),
  // The original's transport answers with an SSE stream.
  jsonResponse: false
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    // Served by the core's host: the info document, health, and the MCP endpoint.
    if (route === "GET /" || route === "GET /health" || route === "POST /mcp") return mcp.fetch(request, env);
    // The original's preflight: status 200, POST and Content-Type only.
    if (route === "OPTIONS /mcp") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }
    // Everything else, `GET /mcp` included: the original's bare 404.
    return new Response("Not Found", { status: 404 });
  }
};
