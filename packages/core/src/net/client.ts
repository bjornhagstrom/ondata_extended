/**
 * The engine's HTTP client: every outbound request from a profile goes through here.
 *
 * Derived from ondata/ckan-mcp-server src/utils/http.ts (commit 09e8cdc): `safeFetch`
 * (lines 845-890), the bounded error-body read (87-113), the size caps (259-264) and the
 * generic half of ondata's `makeCkanRequest` (927-1192: cache, rate limit, timeout covering the body,
 * Anubis retry, network-error classification). The backend half (URL schema, response
 * envelope, error hints) belongs to the profiles.
 *
 * Differences from the original, on purpose:
 * - One code path (fetch) on Node and Workers. The original used axios on Node and fetch on
 *   Workers; on Node the fetch path gets the same DNS pinning through the undici dispatcher.
 * - The success body is read as a stream and stopped at the cap, so a decompression bomb or
 *   a lying Content-Length cannot buffer more than `maxDecompressedBytes` (the original read
 *   the whole body, then compared its size).
 * - Redirect hops check the private-host exemption on the fetch path too (the original did
 *   it only on the axios path).
 * - `request` never throws on an HTTP status; the profile decides what a status means.
 */

import type { FetchOptions, HostPolicy, HttpResponse, RetryPolicy } from "@ondata-extended/profile-contract";
import type { Cache } from "../cache.js";
import { buildCacheKey } from "../cache.js";
import type { UpstreamRateLimiter } from "../rate-limiter.js";
import {
  DnsResolutionError,
  SsrfGuardError,
  assertHostnameResolvesSafe,
  assertRedirectKeepsPrivateExemption,
  getSafeDispatcher,
  validateUrl,
  type NetPolicy
} from "./guards.js";

/** What kind of transport failure: lets a profile word it in its own terms. */
export type TransportErrorKind = "timeout" | "network" | "not-found" | "too-many-redirects" | "edge";

/** The request never got an answer: DNS, socket, timeout, or an edge that could not reach the origin. */
export class TransportError extends Error {
  /** `retryable: false` for failures that repeating cannot fix (a redirect loop). */
  constructor(message: string, readonly url: string, readonly retryable = true, readonly kind: TransportErrorKind = "network") {
    super(message);
    this.name = "TransportError";
  }
}

/** A non-2xx answer. `body` is the small error body parsed as JSON when it was JSON; never echoed by the core. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly url: string,
    readonly body: unknown
  ) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
    this.name = "HttpStatusError";
  }
}

export class ResponseTooLargeError extends Error {
  constructor(readonly bytes: number, readonly url: string) {
    super(`Response too large (${bytes} bytes)`);
    this.name = "ResponseTooLargeError";
  }
}

export class InvalidJsonError extends Error {
  constructor(readonly url: string) {
    super("The upstream answered with something that is not JSON");
    this.name = "InvalidJsonError";
  }
}

export interface HttpClientSettings {
  policy: NetPolicy;
  cache: Cache | null;
  maxCacheEntryBytes: number;
  rateLimiter: UpstreamRateLimiter | null;
  /** Cap on the declared (wire) size. */
  maxResponseBytes: number;
  /** Cap on the bytes actually read, after any decompression the runtime does. */
  maxDecompressedBytes: number;
  maxErrorBodyBytes: number;
  timeoutMs: number;
  userAgents: { browser: string; honest: string };
  /** Observes each completed request (cache hit or not); used for per-call telemetry. */
  onRequest?: (info: { url: string; fromCache: boolean; status: number }) => void;
  /** The profile's policy for a host, if any. */
  hostPolicy?: (hostname: string) => HostPolicy | undefined;
  /** Waits until a request to `hostname` may start; shared across all clients of an engine. */
  throttle?: (hostname: string, minIntervalMs: number) => Promise<void>;
}

/**
 * A process-wide send-to-send throttle per host: the start of two requests to the same host is
 * at least `minIntervalMs` apart, whoever sends them. Requests queue in order.
 * (After ondata's italianparliament-mcp src/core/client.ts throttleSenato, MIT, generalized from
 * one hard-coded host to any host a profile names.)
 */
export function createHostThrottle(): (hostname: string, minIntervalMs: number) => Promise<void> {
  const state = new Map<string, { chain: Promise<void>; last: number }>();
  return (hostname, minIntervalMs) => {
    const s = state.get(hostname) ?? { chain: Promise.resolve(), last: 0 };
    const next = s.chain.then(async () => {
      const wait = s.last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      s.last = Date.now();
    });
    s.chain = next;
    state.set(hostname, s);
    return next;
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry only what can be transient: no answer at all, 5xx, 429. Never another 4xx. */
function retryable(outcome: { error?: unknown; status?: number }): boolean {
  if (outcome.error !== undefined) return outcome.error instanceof TransportError && outcome.error.retryable;
  const status = outcome.status ?? 0;
  return status >= 500 || status === 429;
}

export const DEFAULT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * True when the body is an Anubis proof-of-work challenge page (https://anubis.techaro.lol/)
 * instead of data. No single User-Agent satisfies both Anubis and Chrome-only firewalls,
 * so the client retries once with the honest identity when it sees one.
 */
export function isAnubisChallenge(body: unknown): boolean {
  return typeof body === "string" && body.includes("anubis_challenge");
}

/** Read a body, stopping at `maxBytes`. Throws ResponseTooLargeError past the cap. */
export async function readBoundedBytes(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(total, url);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Fetch that does NOT blindly follow redirects: each hop is re-validated (literal guards,
 * allowlist, private-host exemption, DNS) before it is followed, closing redirect-based
 * SSRF (a public host 302-ing to 169.254.169.254). The caller validates the first URL.
 * On Node every hop goes through the pinning dispatcher.
 */
export async function safeFetch(
  url: string,
  init: RequestInit,
  opts: { maxHops?: number; httpsOnly?: boolean; policy: NetPolicy; allowPrivateHosts?: boolean }
): Promise<{ response: Response; url: string }> {
  const maxHops = opts.maxHops ?? 5;
  const guardSettings = { allowPrivateHosts: opts.allowPrivateHosts === true, policy: opts.policy };
  const dispatcher = await getSafeDispatcher(guardSettings);
  // First hop too, not only redirects: with the pinning dispatcher this is defence in
  // depth; without it (undici failed to load) it is the only DNS check. A literal resolves
  // to itself, so a strict request also refuses a listed private IP literal here.
  // ondata did this on its strict path (src/tools/sparql.ts:55).
  try {
    await assertHostnameResolvesSafe(new URL(url).hostname, guardSettings);
  } catch (error) {
    // Still fail closed (no request is made), but an unknown host on the first hop is a
    // missing server, as ondata reported it ("Server not found"), not a refused destination.
    if (error instanceof DnsResolutionError) throw new TransportError(`Server not found: ${url}`, url, true, "not-found");
    throw error;
  }
  let current = url;
  for (let hop = 0; ; hop++) {
    const response = await fetch(current, {
      ...init,
      redirect: "manual",
      ...(dispatcher ? { dispatcher } : {})
    } as RequestInit);
    const status = response.status;
    const location = response.headers.get("location");
    const isRedirect = [301, 302, 303, 307, 308].includes(status) && !!location;
    if (!isRedirect) return { response, url: current };

    await response.body?.cancel().catch(() => undefined);
    if (hop >= maxHops) throw new TransportError(`Too many redirects (>${maxHops})`, url, false, "too-many-redirects");
    const next = new URL(location as string, current).toString();
    if (opts.httpsOnly && new URL(next).protocol !== "https:") {
      throw new SsrfGuardError("Redirect to a non-HTTPS URL is not allowed");
    }
    assertRedirectKeepsPrivateExemption(new URL(current).hostname, next, opts.policy);
    validateUrl(next, opts.policy, guardSettings);
    await assertHostnameResolvesSafe(new URL(next).hostname, guardSettings);
    current = next;
  }
}

/**
 * A gzip body the server did not declare (no Content-Encoding, or `identity`, so the runtime left it packed),
 * recognised by its magic bytes, as ondata's decoder did on Node.
 */
function isUndeclaredGzip(bytes: Uint8Array, headers: Record<string, string>): boolean {
  // As ondata: unpack by magic bytes unless the header named a coding the runtime already undid.
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b && !/gzip|br|deflate/i.test(headers["content-encoding"] ?? "");
}

/** Unpack it within the decompressed-size cap; if it is not valid gzip, keep the bytes as they came. */
async function gunzipBounded(bytes: Uint8Array, maxBytes: number, url: string): Promise<Uint8Array> {
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await readBoundedBytes(new Response(stream), maxBytes, url);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw error;
    return bytes;
  }
}

/** ondata retried only when a 2xx answer was not JSON (a challenge page, not data). */
function isRetryCandidate(result: HttpResponse): boolean {
  if (result.status < 200 || result.status >= 300 || result.text === null) return false;
  try {
    JSON.parse(result.text);
    return false;
  } catch {
    return true;
  }
}

type CachedBody = { status: number; statusText: string; headers: Record<string, string>; text: string; url: string };

export class HttpClient {
  constructor(private readonly settings: HttpClientSettings) {}

  validateUrl(url: string, opts: { allowPrivateHosts?: boolean } = {}): void {
    validateUrl(url, this.settings.policy, opts);
  }

  async request(url: string, init: RequestInit = {}, opts: FetchOptions = {}): Promise<HttpResponse> {
    const s = this.settings;
    validateUrl(url, s.policy, {
      allowPrivateHosts: opts.allowPrivateHosts === true,
      ...(opts.allowlistedAs ? { allowlistHostname: new URL(opts.allowlistedAs).hostname } : {})
    });

    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body == null ? null : undefined;
    // Only string or empty bodies are cacheable: a stream cannot be part of a key.
    const cache = opts.cache && opts.cache.ttlSeconds > 0 && s.cache && body !== undefined ? s.cache : null;
    const cacheKey = cache ? await buildCacheKey([method, url, body, opts.cache?.key ?? null]) : "";

    if (cache) {
      const hit = (await cache.get(cacheKey)) as CachedBody | undefined;
      if (hit && typeof hit === "object" && typeof hit.text === "string") {
        s.onRequest?.({ url, fromCache: true, status: hit.status });
        return { ...hit, fromCache: true };
      }
    }

    const hostname = new URL(url).hostname;
    const policy = s.hostPolicy?.(hostname);
    const useLimiter = opts.rateLimit !== false && s.rateLimiter;
    // Every request that reaches the host pays a rate token and waits for the host's throttle,
    // retries included: that total is what the host sees.
    const beforeSend = async () => {
      if (useLimiter) await s.rateLimiter!.acquire(hostname);
      if (policy?.minIntervalMs && s.throttle) await s.throttle(hostname, policy.minIntervalMs);
    };
    const effective: FetchOptions = { ...opts, timeoutMs: opts.timeoutMs ?? policy?.timeoutMs };
    const retry: RetryPolicy = opts.retry ?? policy?.retry ?? { attempts: 1 };
    // A policy is profile input: bound it, so a bad value cannot retry forever.
    const maxAttempts = Math.min(10, Math.max(1, Number.isFinite(retry.attempts) ? Math.floor(retry.attempts) : 1));

    const attempt = async (honest: boolean, attempts: number): Promise<HttpResponse> => {
      for (let n = 1; ; n++) {
        await beforeSend();
        let outcome: { result?: HttpResponse; error?: unknown };
        try {
          outcome = { result: await this.fetchOnce(url, init, effective, honest) };
        } catch (error) {
          outcome = { error };
        }
        const last = n >= attempts;
        if (last || !retryable({ error: outcome.error, status: outcome.result?.status })) {
          if (outcome.error !== undefined) throw outcome.error;
          return outcome.result!;
        }
        await sleep(Math.min(retry.maxDelayMs ?? 2000, (retry.baseDelayMs ?? 250) * 2 ** (n - 1)));
      }
    };

    const retryIf = opts.retryHonestIf === false ? null : (opts.retryHonestIf ?? isAnubisChallenge);
    let result = await attempt(opts.userAgent === "honest", maxAttempts);
    if (retryIf && opts.userAgent !== "honest" && isRetryCandidate(result) && retryIf(result.text!)) {
      // One honest request, not a second retry loop: `attempts` counts the whole call.
      result = await attempt(true, 1);
    }

    if (cache && result.status >= 200 && result.status < 300 && result.text !== null) {
      const entry: CachedBody = {
        status: result.status, statusText: result.statusText, headers: result.headers, text: result.text, url: result.url
      };
      if (JSON.stringify(entry).length <= s.maxCacheEntryBytes) {
        await cache.set(cacheKey, entry, opts.cache!.ttlSeconds);
      }
    }
    s.onRequest?.({ url, fromCache: false, status: result.status });
    return result;
  }

  async json<T = unknown>(url: string, init: RequestInit = {}, opts: FetchOptions = {}): Promise<T> {
    const res = await this.request(url, init, opts);
    if (res.status < 200 || res.status >= 300) {
      // An edge (Cloudflare) answers these itself when it cannot reach the origin: the
      // upstream was never reached, so this is a transport failure, not an answer.
      if ((res.status >= 520 && res.status <= 527) || res.status === 530) {
        throw new TransportError(`Network error: the upstream could not be reached (HTTP ${res.status})`, url, true, "edge");
      }
      let parsed: unknown = null;
      try {
        if (res.text !== null) parsed = JSON.parse(res.text);
      } catch { /* not JSON */ }
      throw new HttpStatusError(res.status, res.statusText, url, parsed);
    }
    try {
      return JSON.parse(res.text ?? "") as T;
    } catch {
      throw new InvalidJsonError(url);
    }
  }

  private async fetchOnce(url: string, init: RequestInit, opts: FetchOptions, honest: boolean): Promise<HttpResponse> {
    const s = this.settings;
    const timeoutMs = opts.timeoutMs ?? s.timeoutMs;
    // The timer runs until the body is read, not just the headers: an upstream that sent
    // headers and then stalled kept a call open for minutes in the original.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timeoutError = () => new TransportError(`Request timeout connecting to ${url}`, url, true, "timeout");
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json, text/plain, */*");
    headers.set("User-Agent", honest ? s.userAgents.honest : s.userAgents.browser);
    try {
      let response: Response;
      let finalUrl: string;
      try {
        ({ response, url: finalUrl } = await safeFetch(url, { ...init, headers, signal: controller.signal }, {
          maxHops: opts.maxHops,
          httpsOnly: opts.httpsOnly,
          policy: s.policy,
          allowPrivateHosts: opts.allowPrivateHosts
        }));
      } catch (error) {
        if (controller.signal.aborted) throw timeoutError();
        if (error instanceof SsrfGuardError || error instanceof TransportError) throw error;
        const guard = (error as { cause?: unknown })?.cause;
        if (guard instanceof SsrfGuardError) throw guard;
        if (error instanceof TypeError) throw new TransportError(`Network error: ${error.message}`, url);
        throw error;
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key.toLowerCase()] = value; });
      const ok = response.status >= 200 && response.status < 300;

      if (!ok) {
        // Read the error body only when small; it may carry the upstream's reason.
        let text: string | null = null;
        const declared = Number(response.headers.get("content-length"));
        if (!(Number.isFinite(declared) && declared > s.maxErrorBodyBytes)) {
          try {
            text = new TextDecoder().decode(await readBoundedBytes(response, s.maxErrorBodyBytes, url));
          } catch {
            text = null;
          }
        } else {
          await response.body?.cancel().catch(() => undefined);
        }
        return { url: finalUrl, status: response.status, statusText: response.statusText, headers: responseHeaders, text, fromCache: false };
      }

      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > s.maxResponseBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(declared, url);
      }
      let bytes: Uint8Array;
      try {
        // ondata refused more than 32 MiB however the body arrived (axios counts after its
        // own decompression; the Workers path asked for identity encoding), so the read cap is
        // the smaller of the two caps.
        bytes = await readBoundedBytes(response, Math.min(s.maxResponseBytes, s.maxDecompressedBytes), url);
      } catch (error) {
        if (error instanceof ResponseTooLargeError) throw error;
        if (controller.signal.aborted) throw timeoutError();
        throw new TransportError(`Network error: ${error instanceof Error ? error.message : String(error)}`, url);
      }
      if (isUndeclaredGzip(bytes, responseHeaders)) bytes = await gunzipBounded(bytes, s.maxDecompressedBytes, url);
      return {
        url: finalUrl,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        text: new TextDecoder("utf-8").decode(bytes),
        fromCache: false
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
