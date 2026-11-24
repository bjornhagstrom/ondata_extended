/**
 * Cloudflare Workers host: /, /health and /mcp, stateless per request, CORS, a log line per
 * tool call, and a generic error that leaks nothing. `createServicesHandler` serves several
 * services from one Worker, each at its own path, public or private.
 *
 * Derived from ondata/ckan-mcp-server src/worker.ts (commit 09e8cdc), lines 239-398. What was
 * specific to one deployment is now passed in: the landing page, the health body, which tool
 * arguments may be logged, the Analytics Engine data point and extra response headers.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { summarizeToolError, takeTelemetry } from "./telemetry.js";
import {
  authorizationServerMetadata, authorize, hasAccess, loginConfigured, loginKeys, loginUrls, protectedResourceMetadata, register, token,
  unauthorized, type ServiceLogin
} from "./login.js";

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
  /** Added to every /mcp response (service notices); a function when they depend on the deployment's env. */
  extraHeaders?: Record<string, string> | ((env: Env) => Record<string, string>);
  /**
   * Answer POST /mcp as one JSON body (default) or, with false, as an SSE stream, the transport's
   * default. The log line's status and error summary are read from a JSON body only; with an SSE
   * answer they say "ok".
   */
  jsonResponse?: boolean;
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


/** What serving one MCP endpoint needs; shared by the one-service and the several-service handler. */
type McpRoute<Env> = Pick<WorkerHostOptions<Env>, "buildServer" | "logEntry" | "analytics" | "dataPoint" | "extraHeaders" | "jsonResponse">;

const notFound = () => new Response("Not Found", { status: 404, headers: CORS });
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...CORS } });

/** One MCP endpoint: POST answers, OPTIONS is the CORS preflight, anything else is 405. */
async function serveMcp<Env>(request: Request, env: Env, options: McpRoute<Env>): Promise<Response> {
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
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: options.jsonResponse ?? true });
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
        // A JSON answer, or (jsonResponse: false) an SSE stream whose last `data:` line holds it.
        const body = await response.clone().text();
        const sse = (response.headers.get("content-type") ?? "").includes("text/event-stream");
        const data = sse ? body.split("\n").filter((l) => l.startsWith("data: ")).at(-1)?.slice(6) : body;
        const rj = JSON.parse(data ?? "") as Record<string, unknown>;
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
    const extra = typeof options.extraHeaders === "function" ? options.extraHeaders(env) : options.extraHeaders;
    for (const [k, v] of Object.entries(extra ?? {})) headers.set(k, v);
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

/** One service per Worker: GET /, GET /health and /mcp. */
export function createWorkerHandler<Env>(options: WorkerHostOptions<Env>) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        const page = options.landing?.(request, env);
        if (page) return page;
      }

      if (request.method === "GET" && url.pathname === "/health") return jsonResponse(options.health(env));

      if (url.pathname === "/mcp") return serveMcp(request, env, options);

      return notFound();
    }
  };
}

// ---------------------------------------------------------------------------------------
// Several services in one Worker

/**
 * One service of a Worker that hosts several. Each service has its own MCP server (and so, as the
 * host builds it, its own engine: allowed hosts, cache and rate limit are not shared) and its own
 * path: `/<path>/mcp` and `/<path>/health`.
 *
 * Give exactly one of `path` and `secretPath`:
 * - `path`: a public service, listed on GET / (through the host's landing page) and GET /health.
 * - `secretPath`: a private service, reachable only at a path read from a secret of the deployment
 *   and never listed. Anyone who has the URL can use it, as with a shared link: it keeps the
 *   service out of sight, it is not authentication. A missing or short secret switches the
 *   service off; it never falls back to a guessable path.
 */
export interface WorkerService<Env> extends McpRoute<Env> {
  /** For logs and the listing: lower-case letters, digits and "-". A private service's id is never sent to a caller. */
  id: string;
  /** The body of GET /<path>/health. */
  health(env: Env): Record<string, unknown>;
  path?: string;
  secretPath?(env: Env): string | undefined;
  /**
   * A login in front of /<path>/mcp (src/login.ts): an MCP client gets in only with an access token, which it gets
   * when a person types the deployment's password once. Its endpoints sit under the same path. A service whose
   * login is not set up (a missing or short password or signing secret) is off: it answers 404 like an unknown path.
   */
  login?: ServiceLogin<Env>;
}

export interface ServicesHostOptions<Env> {
  services: readonly WorkerService<Env>[];
  /** Extra fields for GET /health, which lists the public services (never a private one). */
  health?(env: Env): Record<string, unknown>;
  /** GET / ; receives the public services only. null (or no function) means 404. */
  landing?(request: Request, env: Env, publicServices: readonly WorkerService<Env>[]): Response | null;
}

const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PUBLIC_PATH = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** At least 32 characters from a 64-character alphabet: about 192 bits when generated at random. */
const SECRET_PATH = /^[A-Za-z0-9_-]{32,256}$/;
const RESERVED_PATHS = new Set(["mcp", "health", ".well-known"]);

/** Compares in time that depends on the secret's length only, not on how much of it matches. */
function sameSecret(candidate: string, secret: string): boolean {
  let diff = candidate.length ^ secret.length;
  for (let i = 0; i < secret.length; i++) diff |= (i < candidate.length ? candidate.charCodeAt(i) : 0) ^ secret.charCodeAt(i);
  return diff === 0;
}

/** Checks the services once, when the Worker module loads; a wrong setup fails the deployment, not a request. */
export function validateServices<Env>(services: readonly WorkerService<Env>[]): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const s of services) {
    if (!SERVICE_ID.test(s.id)) throw new Error(`Service id "${s.id}" must be lower-case letters, digits and "-"`);
    if (ids.has(s.id)) throw new Error(`Service "${s.id}" is listed twice`);
    ids.add(s.id);
    if ((s.path === undefined) === (s.secretPath === undefined)) throw new Error(`Service "${s.id}" needs exactly one of path and secretPath`);
    if (s.path !== undefined) {
      if (!PUBLIC_PATH.test(s.path) || RESERVED_PATHS.has(s.path)) throw new Error(`Service "${s.id}" has an invalid path "${s.path}"`);
      if (paths.has(s.path)) throw new Error(`Path "${s.path}" is used by more than one service`);
      paths.add(s.path);
    }
  }
}

/**
 * Several services in one Worker, kept apart by path:
 * GET / (the host's page, public services only), GET /health (status and the public services),
 * /<path>/mcp and /<path>/health per service. Everything else, a private service with a wrong or
 * missing secret included, is the same 404.
 */
export function createServicesHandler<Env>(options: ServicesHostOptions<Env>) {
  validateServices(options.services);
  const publicServices = options.services.filter((s) => s.path !== undefined);
  const byPath = new Map(publicServices.map((s) => [s.path!, s]));
  const privateServices = options.services.filter((s) => s.secretPath !== undefined);
  const warned = new Set<string>();

  /** The private service whose secret is `segment`, or undefined. Never logs a secret. */
  function privateService(segment: string, env: Env): WorkerService<Env> | undefined {
    const matches: WorkerService<Env>[] = [];
    for (const s of privateServices) {
      const secret = s.secretPath!(env);
      if (secret === undefined || !SECRET_PATH.test(secret) || byPath.has(secret)) {
        if (!warned.has(s.id)) {
          warned.add(s.id);
          console.warn(`Private service "${s.id}" is off: its secret path is missing or not 32-256 characters of A-Z, a-z, 0-9, "_" and "-".`);
        }
        continue;
      }
      if (sameSecret(segment, secret)) matches.push(s);
    }
    if (matches.length > 1) {
      console.error(`Private services ${matches.map((s) => `"${s.id}"`).join(", ")} share a secret path; none is served.`);
      return undefined;
    }
    return matches[0];
  }

  /** Whether a service is on as far as its login goes (no login, or one that is set up); quiet, for the listings. */
  const servedLogin = (s: WorkerService<Env>, env: Env) => !s.login || loginConfigured(s.login, env);

  /** Whether a service's login is set up; says once, without any value, when it is not. */
  function loginReady(s: WorkerService<Env>, env: Env): boolean {
    if (!s.login || loginConfigured(s.login, env)) return true;
    if (!warned.has(`login:${s.id}`)) {
      warned.add(`login:${s.id}`);
      console.warn(`Service "${s.id}" is off: its login needs a password of at least 16 characters and a signing secret of 32-256 characters of A-Z, a-z, 0-9, "_" and "-".`);
    }
    return false;
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        const page = options.landing?.(request, env, publicServices.filter((s) => servedLogin(s, env)));
        return page ?? notFound();
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          status: "ok",
          ...options.health?.(env),
          services: publicServices.filter((s) => servedLogin(s, env)).map((s) => ({ id: s.id, endpoint: `/${s.path}/mcp` }))
        });
      }

      // A login's discovery documents, at the addresses RFC 9728 and RFC 8414 derive from the service's path.
      const wellKnown = /^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)\/([^/]+)(\/mcp)?$/.exec(url.pathname);
      if (wellKnown) {
        const [, doc, segment, mcp] = wellKnown;
        const service = byPath.get(segment) ?? privateService(segment, env);
        if (!service?.login || request.method !== "GET" || (doc === "oauth-protected-resource") !== (mcp !== undefined)) return notFound();
        if (!loginReady(service, env)) return notFound();
        const urls = loginUrls(request, segment);
        return doc === "oauth-protected-resource" ? protectedResourceMetadata(urls) : authorizationServerMetadata(urls);
      }

      const route = /^\/([^/]+)\/(mcp|health|authorize|token|register)$/.exec(url.pathname);
      if (!route) return notFound();
      const [, segment, what] = route;
      const service = byPath.get(segment) ?? privateService(segment, env);
      if (!service) return notFound();
      if (service.login && !loginReady(service, env)) return notFound();

      if (what === "health") return request.method === "GET" ? jsonResponse(service.health(env)) : notFound();
      if (!service.login) return what === "mcp" ? serveMcp(request, env, service) : notFound();

      const keys = (await loginKeys(service.login, env, service.id))!;
      const urls = loginUrls(request, segment);
      if (what === "authorize") return authorize(request, keys, service.login.page(request), urls.issuer, service.login.attemptLimiter?.(env), service.id);
      if (what === "token") return token(request, keys, service.login);
      if (what === "register") return register(request, keys, service.login.redirectHosts);
      // The CORS preflight carries no token; everything else on /mcp needs one.
      if (request.method !== "OPTIONS") {
        const access = await hasAccess(request, keys);
        if (!access.ok) return unauthorized(urls, access.tokenGiven);
      }
      return serveMcp(request, env, service);
    }
  };
}
