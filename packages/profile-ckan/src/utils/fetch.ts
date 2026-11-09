/**
 * ondata's direct `safeFetch` calls (MQA, SPARQL, the portal registry), sent through the core.
 *
 * ondata called `safeFetch` (src/utils/http.ts:857) and used the `Response`: these calls had no
 * rate limit, no honest retry, at most three redirects, no size cap, and their own identity and
 * timeout. `fetchAsResponse` asks the core for the same (the size cap is the core's: D11 in
 * docs/test-parity.md) and returns a `Response` built from the answer, so the ported code reads
 * it as before. Transport failures keep the messages ondata's callers saw from `fetch`.
 */

import type { EngineContext, FetchOptions } from "@ondata-extended/profile-contract";
import { DnsResolutionError, TransportError } from "@ondata-extended/core";

export interface DirectFetchOptions {
  /** ondata's `AbortSignal.timeout(...)` / timer for this call. */
  timeoutMs: number;
  /** The identity ondata set on this call. */
  userAgent: FetchOptions["userAgent"];
  httpsOnly?: boolean;
  /** A constant URL of the profile's (registry, MQA): exempt from the domain allowlist, as in ondata. */
  fixedUpstream?: boolean;
  /**
   * How ondata's call timed out, which decides the error text: `AbortSignal.timeout()` (MQA, the
   * registry: "The operation was aborted due to timeout") or an `AbortController` and a timer
   * (SPARQL: "This operation was aborted").
   */
  timeoutStyle: "signal" | "controller";
  /**
   * ondata checked DNS itself before fetching (SPARQL), so an unknown host read `Cannot resolve
   * "<host>" for SSRF validation (failing closed).`; otherwise the connection failed inside fetch.
   */
  checksDnsFirst?: boolean;
}

export async function fetchAsResponse(ctx: EngineContext, url: string, init: RequestInit, opts: DirectFetchOptions): Promise<Response> {
  // fetch sends `Accept: */*` when none is set; the core would set its JSON default instead
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "*/*");
  let r;
  try {
    r = await ctx.http.request(url, { ...init, headers }, {
      timeoutMs: opts.timeoutMs,
      userAgent: opts.userAgent,
      retryHonestIf: false,
      rateLimit: false,
      maxHops: 3,
      ...(opts.httpsOnly ? { httpsOnly: true } : {}),
      ...(opts.fixedUpstream ? { fixedUpstream: true } : {})
    });
  } catch (error) {
    throw asFetchError(error, url, opts);
  }
  const noBody = r.text === null || r.status === 204 || r.status === 205 || r.status === 304;
  return new Response(noBody ? null : r.text, { status: r.status, statusText: r.statusText, headers: r.headers });
}

/** The error ondata's caller saw, from fetch or from its own DNS check. */
function asFetchError(error: unknown, url: string, opts: DirectFetchOptions): unknown {
  if (!(error instanceof TransportError)) return error;
  switch (error.kind) {
    case "timeout": {
      if (opts.timeoutStyle === "controller") return new DOMException("This operation was aborted", "AbortError");
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      return e;
    }
    case "network":
      return new TypeError(error.message.replace(/^Network error: /, ""));
    case "not-found":
      if (opts.checksDnsFirst) return new DnsResolutionError(new URL(url).hostname);
      // ondata made no DNS check of its own here; the connection failed inside fetch
      return new TypeError("fetch failed");
    default:
      return new Error(error.message);
  }
}
