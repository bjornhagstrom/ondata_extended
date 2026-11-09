/**
 * Cloudflare Workers host: /, /health and /mcp, stateless per request, CORS, a log line per
 * tool call, and a generic error that leaks nothing.
 *
 * Derived from ondata/ckan-mcp-server src/worker.ts (commit 09e8cdc), lines 239-398. What was
 * specific to one deployment is now passed in: the landing page, the health body, which tool
 * arguments may be logged, the Analytics Engine data point and extra response headers.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { summarizeToolError, takeTelemetry } from "./telemetry.js";

export interface AnalyticsEngineDataset {
  writeDataPoint(event: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface WorkerHostOptions<Env> {
  buildServer(env: Env): McpServer;
  /** The body of GET /health. */
  health(env: Env): Record<string, unknown>;
  /** GET / ; null means 404. */
  landing?(request: Request, env: Env): Response | null;
  /**
   * The log entry for a tool call from its arguments, or null to log nothing. Use
   * `pickTelemetryFields` for the common case.
   */
  logEntry?(tool: string, args: Record<string, unknown>): Record<string, unknown> | null;
  /** Writes one data point per logged call; receives the finished entry. */
  analytics?(env: Env): AnalyticsEngineDataset | undefined;
  dataPoint?(entry: Record<string, unknown>): { blobs?: string[]; doubles?: number[]; indexes?: string[] };
  /** Added to every /mcp response (service notices). */
  extraHeaders?: Record<string, string>;
}

const CORS = { "Access-Control-Allow-Origin": "*" };
const MAX_LOGGED_STRING = 200;

/** A log entry with the listed arguments; objects become capped JSON strings, long strings are capped. */
export function pickTelemetryFields(tool: string, args: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const entry: Record<string, unknown> = { tool };
  for (const key of fields) {
    const v = args[key];
    if (v === undefined) continue;
    if (v !== null && typeof v === "object") entry[key] = JSON.stringify(v).slice(0, MAX_LOGGED_STRING);
    else if (typeof v === "string") entry[key] = v.slice(0, MAX_LOGGED_STRING);
    else entry[key] = v;
  }
  return entry;
}

export function createWorkerHandler<Env>(options: WorkerHostOptions<Env>) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        const page = options.landing?.(request, env);
        if (page) return page;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return new Response(JSON.stringify(options.health(env)), {
          headers: { "Content-Type": "application/json", ...CORS }
        });
      }

      if (url.pathname === "/mcp") {
        if (request.method !== "POST" && request.method !== "OPTIONS") {
          return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, OPTIONS", ...CORS } });
        }
        if (request.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              ...CORS,
              "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id",
              "Access-Control-Max-Age": "86400"
            }
          });
        }

        try {
          const server = options.buildServer(env);
          const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          await server.connect(transport);

          let logEntry: Record<string, unknown> | null = null;
          try {
            const body = (await request.clone().json()) as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
            if (body?.method === "tools/call" && body.params?.name && options.logEntry) {
              logEntry = options.logEntry(body.params.name, body.params.arguments ?? {});
            }
          } catch { /* not JSON */ }

          const t0 = Date.now();
          const response = await transport.handleRequest(request);
          const durationMs = Date.now() - t0;

          if (logEntry) {
            const noted = takeTelemetry(server);
            if (noted) Object.assign(logEntry, noted);
            logEntry.duration_ms = durationMs;
            let status = "ok";
            try {
              const rj = (await response.clone().json()) as Record<string, unknown>;
              const result = rj?.result as Record<string, unknown> | undefined;
              if (result?.isError || rj?.error) {
                status = "error";
                const content = result?.content as { text?: unknown }[] | undefined;
                const text = content?.[0]?.text ?? (rj?.error as { message?: unknown } | undefined)?.message;
                if (typeof text === "string") Object.assign(logEntry, summarizeToolError(text));
              }
            } catch { /* ignore */ }
            logEntry.status = status;
            console.log(JSON.stringify(logEntry));
            const sink = options.analytics?.(env);
            if (sink && options.dataPoint) sink.writeDataPoint(options.dataPoint(logEntry));
          }

          const headers = new Headers(response.headers);
          headers.set("Access-Control-Allow-Origin", "*");
          for (const [k, v] of Object.entries(options.extraHeaders ?? {})) headers.set(k, v);
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        } catch (error) {
          // Full detail server-side; a generic message to the caller so internal exception
          // text (hostnames, IPs, stack fragments) is not leaked (GHSA-6f9w).
          console.error("Worker error:", error);
          return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...CORS }
          });
        }
      }

      return new Response("Not Found", { status: 404, headers: CORS });
    }
  };
}
