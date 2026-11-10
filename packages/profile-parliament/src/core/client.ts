/**
 * Ported from ondata/italianparliament-mcp src/core/client.ts at fd46810 (MIT, see NOTICE.md).
 *
 * Reach changed, behaviour kept:
 * - Requests go through the engine's HTTP client (`ctx.http`: SSRF guards, size cap, timeout that
 *   also covers the body) instead of the global `fetch`; the context is passed in, not held at
 *   module level. Same URL, same method, same `Accept` and `User-Agent` headers.
 * - Both endpoints are the profile's constant upstream (`fixedUpstream`): a deployment's domain
 *   allowlist does not block them; a redirect hop is still checked against it. (The original has
 *   no allowlist.)
 * - The Senato throttle (>= 2 s between the start of two requests, process-wide) is the profile's
 *   host policy (`hostPolicies` in ../index.ts), applied by the core to every request to that host,
 *   retries included (the original throttled once per logical query, before the first attempt).
 * - The retry loop is the original's and stays here: 5 attempts, backoff 250 ms doubling to 2 s,
 *   everything retried except a 4xx other than 429, including an unparsable 2xx body. The core's
 *   own retry is switched off for these requests (`retry: { attempts: 1 }`): its rule (network,
 *   5xx, 429 only) is narrower than the original's.
 * - Never retried, because repeating cannot help and the original had no such failure: a request
 *   the core's guards refuse, an answer over the size cap, a redirect loop, the deployment's own
 *   rate limit.
 * - `requestCounts` (the original's per-process request counter for its live test suite) is not
 *   ported: no test here talks to the live endpoints.
 */

import type { EngineContext } from "@ondata-extended/profile-contract";
import { RateLimitError, ResponseTooLargeError, SsrfGuardError, TransportError } from "@ondata-extended/core";
import { CAMERA_ENDPOINT, SENATO_ENDPOINT, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES } from "./endpoints.js";
import type { SparqlResults } from "./types.js";

/** The original's identity, sent unchanged (`src/core/client.ts:76`). */
export const USER_AGENT = "italianparliament-mcp/0.38.0";

export class SparqlError extends Error {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly status?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SparqlError";
  }
}

/** Failures of the core's guards: not transient, so not repeated. */
function neverRetried(err: unknown): boolean {
  return (
    err instanceof SsrfGuardError ||
    err instanceof ResponseTooLargeError ||
    err instanceof RateLimitError ||
    (err instanceof TransportError && !err.retryable)
  );
}

async function sparqlRequest(
  ctx: EngineContext,
  endpoint: string,
  query: string,
  timeoutMs: number,
  maxRetries: number,
): Promise<SparqlResults> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const params = new URLSearchParams({
        query,
        format: "application/json",
      });
      const url = `${endpoint}?${params.toString()}`;
      const res = await ctx.http.request(
        url,
        {
          method: "GET",
          headers: { Accept: "application/json" },
        },
        // The profile's own constant endpoint, not a URL from the caller: a deployment's domain
        // allowlist does not apply to the first hop (redirects are still checked).
        { userAgent: { fixed: USER_AGENT }, timeoutMs, retry: { attempts: 1 }, fixedUpstream: true },
      );
      if (res.status < 200 || res.status > 299) {
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new SparqlError(
            `SPARQL request failed with status ${res.status}`,
            endpoint,
            res.status,
          );
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return JSON.parse(res.text ?? "") as SparqlResults;
    } catch (err) {
      if (err instanceof SparqlError) throw err;
      if (neverRetried(err)) throw err;
      lastErr = err;
      if (attempt === maxRetries) break;
      // Backoff esponenziale con tetto a 2s: 250, 500, 1000, 2000ms (~4s totali
      // su 5 tentativi) per superare i flap transitori dell'endpoint Camera.
      const delayMs = Math.min(2000, 250 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new SparqlError(
    `SPARQL request failed after ${maxRetries} attempts`,
    endpoint,
    undefined,
    lastErr,
  );
}

export function cdQuery(
  ctx: EngineContext,
  query: string,
  opts: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<SparqlResults> {
  return sparqlRequest(
    ctx,
    CAMERA_ENDPOINT,
    query,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    opts.maxRetries ?? DEFAULT_MAX_RETRIES,
  );
}

export function snQuery(
  ctx: EngineContext,
  query: string,
  opts: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<SparqlResults> {
  // The original awaited its module-level throttleSenato() here; the core now applies the
  // profile's host policy for dati.senato.it to every request.
  return sparqlRequest(
    ctx,
    SENATO_ENDPOINT,
    query,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    opts.maxRetries ?? DEFAULT_MAX_RETRIES,
  );
}
