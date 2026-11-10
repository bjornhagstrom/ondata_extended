/**
 * Record and replay of upstream HTTP at the `fetch` boundary, shared by both servers.
 * Copied from packages/profile-ckan/tests/parity/replay.ts (profiles do not import each other),
 * with the `synthetic` mark added, and `accept-language` among the compared request headers
 * (camera-amendments sends one; the SPARQL requests send none, so their recordings are unchanged).
 *
 * Key: method, URL and body. The request headers a server chooses (identity, encoding, content
 * type) are recorded too and must match on replay: a port that dropped the browser User-Agent
 * would otherwise pass here and fail against the firewalls it exists for. Redirects are recorded
 * as they come (both servers fetch with `redirect: "manual"`). A request with no recording, a
 * request asked more often than in the recording, and a header difference are all reported as
 * misses, so a test that asserts no misses sees every difference in what is sent.
 */

export interface RecordedExchange {
  key: string;
  /** The request headers that matter (lower-case names). */
  requestHeaders: Record<string, string>;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** UTF-8 body as text, or `bodyBase64` when it is not valid UTF-8. */
  bodyText?: string;
  bodyBase64?: string;
  /** Not from the live upstream: made up for the case (all Senato answers, Camera failures). */
  synthetic?: boolean;
}

export const KEPT_RESPONSE_HEADERS = ["content-type", "location"];
const COMPARED_REQUEST_HEADERS = ["user-agent", "accept", "accept-encoding", "accept-language", "content-type"];

export function bodyOf(bytes: Uint8Array): { bodyText: string } | { bodyBase64: string } {
  try {
    return { bodyText: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { bodyBase64: Buffer.from(bytes).toString("base64") };
  }
}

export function exchangeKey(input: string | URL | Request, init?: RequestInit): string {
  if (input instanceof Request) throw new Error("parity harness: a Request object as fetch input is not supported (its body would not be keyed)");
  const url = typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? "GET").toUpperCase();
  if (init?.body !== undefined && init.body !== null && typeof init.body !== "string") {
    throw new Error("parity harness: only string request bodies can be keyed");
  }
  const body = init?.body ?? "";
  return `${method} ${url}${body ? ` ${body}` : ""}`;
}

export function requestHeaders(init?: RequestInit): Record<string, string> {
  const h = new Headers(init?.headers);
  const out: Record<string, string> = {};
  for (const name of COMPARED_REQUEST_HEADERS) {
    const v = h.get(name);
    if (v !== null) out[name] = v;
  }
  // A request without Accept goes out as `Accept: */*` (Fetch standard, "fetch" step 12), so
  // the two are the same request on the wire.
  out.accept ??= "*/*";
  return out;
}

/** Sorted, with the Accept a request without one goes out with (recordings made before that rule). */
function canonicalHeaders(h: Record<string, string>): string {
  const all: Record<string, string> = { accept: "*/*", ...h };
  return JSON.stringify(Object.keys(all).sort().map((k) => [k, all[k]]));
}

/** Answer from recordings; every difference in what is sent lands in `misses`. */
export function replayingFetch(exchanges: RecordedExchange[], misses: string[], replayedKeys: string[] = []): typeof fetch {
  const byKey = new Map<string, RecordedExchange[]>();
  for (const e of exchanges) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  const used = new Map<string, number>();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const key = exchangeKey(input, init);
    replayedKeys.push(key);
    const list = byKey.get(key);
    if (!list) {
      misses.push(`NOT RECORDED: ${key}`);
      return new Response("no recording", { status: 599 });
    }
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    if (n >= list.length) {
      misses.push(`EXTRA CALL #${n + 1} (recorded ${list.length}): ${key}`);
      return new Response("no recording", { status: 599 });
    }
    const e = list[n];
    const sent = requestHeaders(init);
    if (canonicalHeaders(sent) !== canonicalHeaders(e.requestHeaders)) {
      misses.push(`HEADERS DIFFER: ${key}: sent ${JSON.stringify(sent)}, recorded ${JSON.stringify(e.requestHeaders)}`);
    }
    const body = e.status === 204 || e.status === 304 ? null
      : e.bodyText !== undefined ? new TextEncoder().encode(e.bodyText) : Buffer.from(e.bodyBase64 ?? "", "base64");
    return new Response(body, { status: e.status, statusText: e.statusText, headers: e.headers });
  }) as typeof fetch;
}

/** Calls recorded but never made on replay (a port that skips a request). */
export function unusedExchanges(exchanges: RecordedExchange[], replayedKeys: string[]): string[] {
  const left = new Map<string, number>();
  for (const e of exchanges) left.set(e.key, (left.get(e.key) ?? 0) + 1);
  for (const k of replayedKeys) left.set(k, (left.get(k) ?? 0) - 1);
  return [...left].filter(([, n]) => n > 0).map(([k, n]) => `NOT CALLED (${n}x): ${k}`);
}
