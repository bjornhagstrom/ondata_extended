/**
 * The CKAN request layer: `makeCkanRequest` and its errors.
 *
 * Ported from ondata/ckan-mcp-server src/utils/http.ts at 09e8cdc (MIT, see NOTICE.md). The
 * error classes, `extractCkanErrorMessage`, `httpError` and `formatCkanError` are ondata's,
 * unchanged. `makeCkanRequest` keeps ondata's fetch path (the one its Worker runs: identity
 * encoding, browser User-Agent with one honest retry for an Anubis page, 30 s timeout covering
 * the body, five redirect hops, result cache with ondata's TTL table) but sends through the
 * core HTTP client, which owns the SSRF guards, size caps, rate limit and Anubis retry.
 * Differences from ondata, all in docs/test-parity.md: the axios path (Node) is gone, so Node
 * users get the fetch path's request headers; an unknown host reads "Server not found" as on
 * ondata's Node path.
 */

import type { EngineContext } from "@ondata-extended/profile-contract";
import { ResponseTooLargeError, TransportError } from "@ondata-extended/core";
import { getPortalApiUrlForHostname, getPortalApiPath, getPortalMigration } from "./portal-config.js";

export interface MakeCkanRequestOptions {
  cache?: boolean;
  rateLimit?: boolean;
  /** Send the params as a JSON body. For portals that lose a parameter on GET. */
  post?: boolean;
}

export class CkanApiError extends Error {
  readonly status: number | undefined;
  readonly action: string;
  /** The portal the request went to, as the caller wrote it: lets the hint know its origin. */
  readonly serverUrl: string | undefined;
  /** The reason CKAN itself gave, when the portal answered with a CKAN error body. */
  readonly ckanReason: string | undefined;
  constructor(message: string, status: number | undefined, action: string, serverUrl?: string, ckanReason?: string) {
    super(message);
    this.name = 'CkanApiError';
    this.status = status;
    this.action = action;
    this.serverUrl = serverUrl;
    this.ckanReason = ckanReason;
  }
}

const MAX_CKAN_REASON_LENGTH = 300;

/**
 * The reason CKAN gives for a failed action: `error.message`, or for a validation error
 * (which has none) its fields, `query: column "x" does not exist`. One line, capped,
 * with a notice of how many characters were omitted.
 *
 * Only a CKAN error body counts — an object with `success: false` and an `error` — so a
 * firewall page or any other upstream content is never echoed (GHSA-6f9w).
 */
export function extractCkanErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { success, error } = body as { success?: unknown; error?: unknown };
  if (success !== false || error === undefined || error === null) return null;

  let text: string;
  if (typeof error === 'string') {
    text = error;
  } else if (typeof error === 'object') {
    const fields = error as Record<string, unknown>;
    if (typeof fields.message === 'string') {
      text = fields.message;
    } else {
      text = Object.entries(fields)
        .filter(([key]) => key !== '__type')
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join('; ') : typeof value === 'string' ? value : JSON.stringify(value)}`)
        .join('; ');
    }
  } else {
    return null;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= MAX_CKAN_REASON_LENGTH) return text;
  // Say what was cut: the full reason is only in the portal's own API answer.
  return `${text.slice(0, MAX_CKAN_REASON_LENGTH)}… [${text.length - MAX_CKAN_REASON_LENGTH} more characters from the portal omitted]`;
}

/** Build the error for a non-2xx answer, quoting CKAN's own reason when it gave one. */
function httpError(status: number, statusText: string, body: unknown, action: string, serverUrl: string): CkanApiError | CkanTransportError {
  // Cloudflare answers these itself when it cannot reach the origin, so `fetch` does not
  // throw and the status text is empty or "<none>" (#560). The portal was never reached.
  if ((status >= 520 && status <= 527) || status === 530) {
    return new CkanTransportError(`Network error: Cloudflare could not reach the portal (HTTP ${status})`, serverUrl);
  }
  // CKAN answers an unknown action with a bare JSON string, translated up to the colon. Only
  // the fact is kept and the name is ours: an arbitrary body is never reflected (GHSA-6f9w).
  const reason = extractCkanErrorMessage(body)
    ?? (typeof body === 'string' && body.endsWith(`Action name not known: ${action}`) ? `Action name not known: ${action}` : undefined);
  return new CkanApiError(`CKAN API error (${status}): ${reason ?? (statusText || 'Unknown error')}`, status, action, serverUrl, reason);
}

/**
 * A request that never reached CKAN: DNS, socket, or our own 30s timeout.
 *
 * Deliberately not a `CkanApiError`: nothing answered, so there is no status and no
 * upstream message to quote. `formatCkanError` still turns it into a hint, because
 * "Request timeout connecting to X" alone does not tell an LLM whether to retry.
 */
export class CkanTransportError extends Error {
  /** The portal the request went to, as the caller wrote it. */
  readonly serverUrl: string | undefined;

  constructor(message: string, serverUrl?: string) {
    super(message);
    this.name = 'CkanTransportError';
    this.serverUrl = serverUrl;
  }
}

export function formatCkanError(error: unknown, _toolName: string): string {
  if (error instanceof CkanTransportError) {
    const migration = error.serverUrl ? getPortalMigration(error.serverUrl) : null;
    if (migration) {
      return `${error.message}\n→ ${migration.notice} See ${migration.docs_url}`;
    }
    // The request never arrived, so retrying is the first thing to try and the
    // status tool is how the caller finds out whether the portal is up at all. Its
    // own answer can be served from the cache for an hour (see `getTtlForAction`),
    // which is a deliberate TTL rather than an oversight, so the hint says so
    // instead of promising a live check.
    return `${error.message}\n→ Portal unreachable. Retry later, or call \`ckan_status_show\` to check portal health (its answer can come from the cache for up to an hour).`;
  }
  if (!(error instanceof CkanApiError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const { status, action, message, serverUrl } = error;

  // A portal that left CKAN answers every CKAN request the same way — catalog.data.gov
  // returns a bare 404 — so no status-based hint can be right for it. Say what happened
  // and where the data went, whatever the status.
  const migration = serverUrl ? getPortalMigration(serverUrl) : null;
  if (migration) {
    return `${message}\n→ ${migration.notice} See ${migration.docs_url}`;
  }

  // SQL access is optional in CKAN and many portals disable it, answering 404 or 400 on
  // the endpoint itself. The resource_id is usually fine, so pointing at
  // `ckan_package_show` sends the caller round a loop that ends on the same answer.
  const noSqlEndpoint = '→ This portal does not expose the SQL endpoint (optional in CKAN, often disabled). Use `ckan_datastore_search` with `filters`/`sort` instead; the resource_id is probably fine.';
  const actionUnknown = error.ckanReason === `Action name not known: ${action}`;

  let hint = '';
  if (status === 404) {
    if (action === 'datastore_search_sql') {
      hint = noSqlEndpoint;
    } else if (action.startsWith('datastore_search')) {
      hint = '→ Get a valid resource_id first: call `ckan_package_show` on a dataset, then pick a resource where `datastore_active` is true.';
    } else if (action === 'package_show') {
      hint = '→ Use `ckan_package_search` to find a valid dataset name or ID.';
    } else if (action === 'organization_show') {
      hint = '→ Use `ckan_organization_list` or `ckan_organization_search` to discover valid organization names.';
    } else if (action === 'group_show') {
      hint = '→ Use `ckan_group_list` or `ckan_group_search` to discover valid group names.';
    }
  } else if (status === 400 && actionUnknown && action === 'datastore_search_sql') {
    hint = noSqlEndpoint;
  } else if (status === 400 && actionUnknown && action === 'datastore_search') {
    hint = '→ This portal has no DataStore, so its tables cannot be queried here. Download the resource through its URL instead (`ckan_package_show` lists them).';
  } else if (status === 400) {
    if (action === 'datastore_search_sql') {
      hint = '→ Invalid SQL syntax or unknown column — check column names with `ckan_datastore_search` before writing SQL.';
    } else if (action.startsWith('datastore_search')) {
      hint = '→ Bad request — likely an invalid field name or filter syntax; check column names with a `SELECT *` query first.';
    }
  } else if (status === 403) {
    if (!error.ckanReason) {
      // No CKAN body: a firewall or bot-protection page (data.forest.go.th answers
      // "Just a moment...", gudang.lokadata.id "Permintaan Ditolak") refused the client.
      hint = '→ The portal\'s firewall or bot protection refused the request (no CKAN answer). It is not a parameter problem and retrying will not help; the portal may be usable only from a browser.';
    } else if (action === 'datastore_search_sql') {
      // CKAN allows a fixed list of SQL functions and no system tables.
      hint = '→ This SQL uses something not permitted on this portal (CKAN accepts a limited list of functions and no system tables such as information_schema). Rewrite the query without it, or use `ckan_datastore_search`. For a type conversion write `"col"::float` instead of `CAST(...)`: the `::` operator is not a function call.';
    }
  } else if (status === 409 && action === 'datastore_search_sql') {
    hint = '→ The portal rejected the SQL (reason above). Check table and column names with `ckan_datastore_search` (limit 1), then fix the query.';
  } else if (status === 409 || status === 422) {
    hint = '→ Portal rejected the request — parameters may conflict; simplify filters and retry.';
  } else if (status === 503 || status === 502 || status === 504) {
    hint = '→ Portal temporarily unavailable — retry in a few seconds, or call `ckan_status_show` to check portal health (cached up to an hour).';
  } else if (status === 500) {
    hint = '→ Portal internal error — try a different portal or retry later, and call `ckan_status_show` to check portal health (cached up to an hour).';
  } else if (status === undefined) {
    hint = '→ The portal may not support this action, or the endpoint is unavailable.';
  }
  return hint ? `${message}\n${hint}` : message;
}


const TTL_METADATA = new Set([
  "package_search",
  "package_show",
  "current_package_list_with_resources",
  "resource_show",
  "organization_show",
  "organization_list",
  "organization_search",
  "group_show",
  "group_list",
  "group_search",
  "tag_list",
  "tag_show",
  "tag_search"
]);
const TTL_STATUS = new Set(["status_show", "site_read"]);
const TTL_DATASTORE = new Set(["datastore_search", "datastore_search_sql"]);

/** ondata src/utils/cache.ts: metadata 5 min, status 1 h, DataStore 1 min, else the default. */
export function getTtlForAction(action: string, fallback: number): number {
  if (TTL_METADATA.has(action)) return 300;
  if (TTL_STATUS.has(action)) return 3600;
  if (TTL_DATASTORE.has(action)) return 60;
  return fallback;
}

function stderr(line: string): void {
  try {
    (globalThis as { process?: { stderr?: { write(s: string): void } } }).process?.stderr?.write(line);
  } catch { /* ignore */ }
}

/** One JSON line per request on stderr, on Node only (ondata's audit log). */
function auditLog(serverUrl: string, action: string, params: Record<string, any>, cacheHit: boolean): void {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (!proc?.versions?.node) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    server: serverUrl,
    action,
    cache_hit: cacheHit
  };
  if (params.q !== undefined)    entry.q    = params.q;
  if (params.fq !== undefined)   entry.fq   = params.fq;
  if (params.sql !== undefined)  entry.sql  = String(params.sql).slice(0, 200);
  if (params.id !== undefined)   entry.id   = params.id;
  if (params.rows !== undefined) entry.rows = params.rows;
  if (params.limit !== undefined) entry.limit = params.limit;
  stderr(JSON.stringify(entry) + '\n');
}

/** ondata's fallback identity; the core retries with it once when a 2xx answer is an Anubis page. */
export const HONEST_USER_AGENT = 'CKAN-MCP-Server/1.0';

/**
 * Make HTTP request to CKAN API
 */
export async function makeCkanRequest<T>(
  ctx: EngineContext,
  serverUrl: string,
  action: string,
  params: Record<string, any> = {},
  opts: MakeCkanRequestOptions = {}
): Promise<T> {
  // CKAN portals on a configured private host are allowed (ondata's validateServerUrl).
  ctx.http.validateUrl(serverUrl, { allowPrivateHosts: true });

  let resolvedServerUrl = serverUrl;
  try {
    const hostname = new URL(serverUrl).hostname;
    const portalApiUrl = getPortalApiUrlForHostname(hostname);
    if (portalApiUrl) {
      resolvedServerUrl = portalApiUrl;
    }
  } catch {
    // Keep provided URL if parsing fails
  }

  // Normalize server URL
  const baseUrl = resolvedServerUrl.replace(/\/$/, '');
  const apiPath = getPortalApiPath(resolvedServerUrl);
  const url = `${baseUrl}${apiPath}/${action}`;

  const ttl = getTtlForAction(action, ctx.cache.defaultTtlSeconds);
  const useCache = ctx.cache.enabled && opts.cache !== false && ttl > 0;
  const cacheKey = useCache ? await ctx.cache.key([baseUrl, action, params]) : "";

  if (useCache) {
    const cached = await ctx.cache.get(cacheKey);
    if (cached !== undefined) {
      ctx.telemetry.note({ cache_hit: true });
      auditLog(serverUrl, action, params, true);
      return cached as T;
    }
  }

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    searchParams.set(key, String(value));
  }
  const fetchUrl = !opts.post && searchParams.toString()
    ? `${url}?${searchParams.toString()}`
    : url;

  let response;
  try {
    response = await ctx.http.request(fetchUrl, {
      method: opts.post ? "POST" : "GET",
      ...(opts.post ? { body: JSON.stringify(params) } : {}),
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Encoding": "identity",
        ...(opts.post ? { "Content-Type": "application/json" } : {})
      }
    }, {
      allowPrivateHosts: true,
      // ondata checked the allowlist on the caller's host, not on the API host portals.json
      // rewrites it to (open.toronto.ca → ckan0.cf.opendata.inter.prod-toronto.ca).
      allowlistedAs: serverUrl,
      maxHops: 5,
      ...(opts.rateLimit === false ? { rateLimit: false } : {})
    });
  } catch (error) {
    throw ckanRequestError(error, action, serverUrl);
  }

  if (response.status < 200 || response.status >= 300) {
    // The body carries CKAN's reason (`Not authorized to call function NULLIF`);
    // the status text alone never said what to fix. The core reads it only when small.
    let body: unknown = null;
    try {
      if (response.text !== null) body = JSON.parse(response.text);
    } catch { /* not JSON: fall back to the status text */ }
    throw httpError(response.status, response.statusText, body, action, serverUrl);
  }

  let decodedData: unknown = response.text;
  try {
    decodedData = JSON.parse(response.text ?? "");
  } catch { /* not JSON: kept as text, so the success check below fails */ }

  if (decodedData && (decodedData as { success?: boolean }).success === true) {
    const result = (decodedData as { result: T }).result;
    if (useCache) {
      // The core skips entries over the configured maximum, as ondata did.
      await ctx.cache.set(cacheKey, result, ttl);
    }
    auditLog(serverUrl, action, params, false);
    return result;
  }
  // Do NOT reflect the full upstream body to the caller: if the server was
  // pointed/redirected at a non-CKAN host it could carry internal detail,
  // turning blind SSRF into a return-value channel (GHSA-6f9w). Log it
  // server-side only (truncated) and return a generic, action-scoped error.
  try {
    stderr(`[ckan] success=false action=${action}: ${JSON.stringify(decodedData).slice(0, 500)}\n`);
  } catch { /* ignore logging failures */ }
  throw new CkanApiError(
    `CKAN API returned success=false for action "${action}".`,
    undefined,
    action,
    serverUrl
  );
}

/**
 * The core's transport errors in ondata's words, naming the portal as the caller wrote it.
 * Guard refusals (SsrfGuardError) pass unchanged: their message is the verdict.
 */
function ckanRequestError(error: unknown, action: string, serverUrl: string): unknown {
  if (error instanceof ResponseTooLargeError) {
    return new CkanApiError(`Response too large (${error.bytes} bytes)`, undefined, action, serverUrl);
  }
  if (!(error instanceof TransportError)) return error;
  switch (error.kind) {
    case "timeout":
      return new CkanTransportError(`Request timeout connecting to ${serverUrl}`, serverUrl);
    case "not-found":
      return new CkanTransportError(`Server not found: ${serverUrl}`, serverUrl);
    case "too-many-redirects":
      // ondata threw a plain Error here: no retry hint, the loop will not go away.
      return new Error(error.message);
    default:
      return new CkanTransportError(error.message, serverUrl);
  }
}
