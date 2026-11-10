/**
 * The engine's HTTP client. New code (it replaces the generic half of ondata's request
 * function), so these tests are new; each names the property it protects.
 *
 * A real HTTP server on 127.0.0.1 is reached by listing it as a private host and asking for
 * `allowPrivateHosts`. Node skips the dispatcher's DNS lookup for IP literals, so the
 * pinning dispatcher itself is exercised separately, through the hostname `localhost`.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import {
  HttpClient,
  HttpStatusError,
  MemoryLruCache,
  ResponseTooLargeError,
  SsrfGuardError,
  TransportError,
  UpstreamRateLimiter,
  __setDnsResolverForTests,
  type HttpClientSettings,
  type NetPolicy
} from "../src/index.js";

const policy = (over: Partial<NetPolicy> = {}): NetPolicy => ({
  allowedDomains: [],
  privateHosts: ["127.0.0.1"],
  names: { allowedDomains: "APP_ALLOWED_DOMAINS", privateHosts: "APP_PRIVATE_HOSTS", httpAllowAll: "APP_HTTP_ALLOW_ALL" },
  ...over
});

const settings = (over: Partial<HttpClientSettings> = {}): HttpClientSettings => ({
  policy: policy(),
  cache: null,
  maxCacheEntryBytes: 1024 * 1024,
  rateLimiter: null,
  maxResponseBytes: 1024 * 1024,
  maxDecompressedBytes: 1024 * 1024,
  maxErrorBodyBytes: 1024,
  timeoutMs: 2000,
  userAgents: { browser: "BrowserUA", honest: "HonestUA" },
  ...over
});

const PRIVATE = { allowPrivateHosts: true } as const;

let server: http.Server;
let base: string;
const hits: Record<string, number> = {};
const seenUserAgents: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    hits[path] = (hits[path] ?? 0) + 1;
    seenUserAgents.push(String(req.headers["user-agent"]));
    switch (path) {
      case "/json":
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, n: hits[path] }));
        return;
      case "/chunked-big":
        // no content-length: the cap must hold while streaming
        res.setHeader("content-type", "text/plain");
        for (let i = 0; i < 40; i++) res.write("x".repeat(1024));
        res.end();
        return;
      case "/declared-big":
        res.setHeader("content-length", String(10 * 1024 * 1024));
        res.write("x");
        // never finish; the client must refuse on the header
        return;
      case "/gzip-bomb": {
        const body = gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x61));
        res.setHeader("content-encoding", "gzip");
        res.setHeader("content-length", String(body.length));
        res.end(body);
        return;
      }
      case "/gzip-undeclared":
        // gzip bytes without Content-Encoding: the runtime passes them through packed
        res.setHeader("content-type", "application/json");
        res.end(gzipSync(Buffer.from(JSON.stringify({ unpacked: true }))));
        return;
      case "/gzip-identity":
        res.setHeader("content-encoding", "identity");
        res.end(gzipSync(Buffer.from(JSON.stringify({ unpacked: true }))));
        return;
      case "/gzip-undeclared-bomb":
        res.end(gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x61)));
        return;
      case "/gzip-magic-only":
        // starts like gzip, is not
        res.end(Buffer.from([0x1f, 0x8b, 0x41, 0x42]));
        return;
      case "/stall-body":
        res.setHeader("content-type", "text/plain");
        res.write("partial");
        // headers and a first chunk, then nothing
        return;
      case "/err-small":
        res.statusCode = 409;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { message: "conflict reason" } }));
        return;
      case "/err-big":
        res.statusCode = 500;
        res.end("e".repeat(10 * 1024));
        return;
      case "/edge-522":
        res.statusCode = 522;
        res.end();
        return;
      case "/anubis":
        if (String(req.headers["user-agent"]) === "HonestUA") {
          res.setHeader("content-type", "application/json");
          res.end('{"through":true}');
        } else {
          res.end("<html>anubis_challenge</html>");
        }
        return;
      case "/not-json":
        res.end("<html>hi</html>");
        return;
      default:
        res.statusCode = 404;
        res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("HttpClient against a live server", () => {
  it("returns status, lower-case headers and text", async () => {
    const res = await new HttpClient(settings()).request(`${base}/json`, {}, PRIVATE);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.text!)).toMatchObject({ ok: true });
    expect(res.fromCache).toBe(false);
  });

  it("serves the second identical request from the cache and does not reach the server", async () => {
    const client = new HttpClient(settings({ cache: new MemoryLruCache(10) }));
    const before = hits["/json"] ?? 0;
    const a = await client.json<{ n: number }>(`${base}/json`, {}, { ...PRIVATE, cache: { ttlSeconds: 60 } });
    const b = await client.request(`${base}/json`, {}, { ...PRIVATE, cache: { ttlSeconds: 60 } });
    expect(hits["/json"]).toBe(before + 1);
    expect(b.fromCache).toBe(true);
    expect(JSON.parse(b.text!).n).toBe(a.n);
  });

  it("does not cache when the request has no cache option", async () => {
    const client = new HttpClient(settings({ cache: new MemoryLruCache(10) }));
    const before = hits["/json"] ?? 0;
    await client.request(`${base}/json`, {}, PRIVATE);
    await client.request(`${base}/json`, {}, PRIVATE);
    expect(hits["/json"]).toBe(before + 2);
  });

  it("stops reading a body without Content-Length at the cap", async () => {
    const client = new HttpClient(settings({ maxDecompressedBytes: 8 * 1024 }));
    await expect(client.request(`${base}/chunked-big`, {}, PRIVATE)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("refuses a declared size over the wire cap before reading the body", async () => {
    const client = new HttpClient(settings({ maxResponseBytes: 1024 }));
    await expect(client.request(`${base}/declared-big`, {}, PRIVATE)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("counts decompressed bytes, so a small gzip body that inflates past the cap is refused", async () => {
    const client = new HttpClient(settings({ maxResponseBytes: 1024 * 1024, maxDecompressedBytes: 100 * 1024 }));
    await expect(client.request(`${base}/gzip-bomb`, {}, PRIVATE)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("unpacks a gzip body the server did not declare, as ondata did on Node", async () => {
    const res = await new HttpClient(settings()).request(`${base}/gzip-undeclared`, {}, PRIVATE);
    expect(JSON.parse(res.text!)).toEqual({ unpacked: true });
  });

  it("unpacks gzip bytes sent as Content-Encoding: identity, as ondata did", async () => {
    const res = await new HttpClient(settings()).request(`${base}/gzip-identity`, {}, PRIVATE);
    expect(JSON.parse(res.text!)).toEqual({ unpacked: true });
  });

  it("holds the decompressed cap for an undeclared gzip body too", async () => {
    const client = new HttpClient(settings({ maxResponseBytes: 1024 * 1024, maxDecompressedBytes: 100 * 1024 }));
    await expect(client.request(`${base}/gzip-undeclared-bomb`, {}, PRIVATE)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("keeps the bytes as they came when they only start like gzip", async () => {
    const res = await new HttpClient(settings()).request(`${base}/gzip-magic-only`, {}, PRIVATE);
    expect(res.text!.endsWith("AB")).toBe(true);
  });

  it("times out while the body is stalled, not only before the headers", async () => {
    const client = new HttpClient(settings({ timeoutMs: 300 }));
    const t0 = Date.now();
    const error = await client.request(`${base}/stall-body`, {}, PRIVATE).catch((e) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(String(error.message)).toContain("timeout");
    expect(error.kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("returns a small error body as text and json() throws HttpStatusError carrying it parsed", async () => {
    const client = new HttpClient(settings());
    const res = await client.request(`${base}/err-small`, {}, PRIVATE);
    expect(res.status).toBe(409);
    expect(res.text).toContain("conflict reason");
    const error = (await client.json(`${base}/err-small`, {}, PRIVATE).catch((e: unknown) => e)) as HttpStatusError;
    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error.status).toBe(409);
    expect(error.body).toEqual({ error: { message: "conflict reason" } });
    // the core never puts the upstream body into the message
    expect(error.message).not.toContain("conflict reason");
  });

  it("does not read an error body over the error cap", async () => {
    const res = await new HttpClient(settings({ maxErrorBodyBytes: 1024 })).request(`${base}/err-big`, {}, PRIVATE);
    expect(res.status).toBe(500);
    expect(res.text).toBeNull();
  });

  it("treats an edge 52x as a transport failure in json()", async () => {
    const error = await new HttpClient(settings()).json(`${base}/edge-522`, {}, PRIVATE).catch((e: unknown) => e) as TransportError;
    expect(error).toBeInstanceOf(TransportError);
    expect(error.kind).toBe("edge");
  });

  it("retries once with the honest user agent on an Anubis challenge", async () => {
    seenUserAgents.length = 0;
    const out = await new HttpClient(settings()).json<{ through: boolean }>(`${base}/anubis`, {}, PRIVATE);
    expect(out).toEqual({ through: true });
    expect(seenUserAgents).toEqual(["BrowserUA", "HonestUA"]);
  });

  it("does not retry when retryHonestIf is false", async () => {
    const res = await new HttpClient(settings()).request(`${base}/anubis`, {}, { ...PRIVATE, retryHonestIf: false });
    expect(res.text).toContain("anubis_challenge");
  });

  it("sends a fixed user agent exactly, and does not retry it with the honest one", async () => {
    seenUserAgents.length = 0;
    const res = await new HttpClient(settings()).request(`${base}/anubis`, { headers: { "User-Agent": "ignored" } }, { ...PRIVATE, userAgent: { fixed: "Fixed/1.0" } });
    expect(res.text).toContain("anubis_challenge");
    expect(seenUserAgents).toEqual(["Fixed/1.0"]);
  });

  it("json() refuses a body that is not JSON", async () => {
    await expect(new HttpClient(settings()).json(`${base}/not-json`, {}, PRIVATE)).rejects.toThrow("not JSON");
  });

  it("takes a rate token per upstream request and none for a cache hit", async () => {
    const limiter = new UpstreamRateLimiter({ enabled: true, rps: 0.001, burst: 2, maxWaitMs: 10 });
    const client = new HttpClient(settings({ cache: new MemoryLruCache(10), rateLimiter: limiter }));
    await client.request(`${base}/json`, {}, { ...PRIVATE, cache: { ttlSeconds: 60 } });
    await client.request(`${base}/json`, {}, { ...PRIVATE, cache: { ttlSeconds: 60 } }); // cache hit
    await client.request(`${base}/json?x=1`, {}, PRIVATE); // second token
    await expect(client.request(`${base}/json?x=2`, {}, PRIVATE)).rejects.toThrow("Rate limit exceeded");
  });
});

describe("HttpClient guards", () => {
  it("is strict by default: a listed private host is refused at connect time without allowPrivateHosts", async () => {
    const before = hits["/json"] ?? 0;
    await expect(new HttpClient(settings()).request(`${base}/json`)).rejects.toThrow();
    expect(hits["/json"] ?? 0).toBe(before);
  });

  it("refuses a host outside the allowlist before any request", async () => {
    const client = new HttpClient(settings({ policy: policy({ allowedDomains: ["example.org"] }) }));
    const before = hits["/json"] ?? 0;
    await expect(client.request(`${base}/json`, {}, PRIVATE)).rejects.toThrow("not in the allowed list (APP_ALLOWED_DOMAINS)");
    expect(hits["/json"] ?? 0).toBe(before);
  });

  it("refuses non-http protocols and internal literals", async () => {
    const client = new HttpClient(settings());
    await expect(client.request("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfGuardError);
    await expect(client.request("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(SsrfGuardError);
  });
});

describe("HttpClient redirects (stubbed fetch)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __setDnsResolverForTests(null);
  });

  const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });

  it("allowlistedAs checks the stand-in host on the first hop only; redirects are checked as usual", async () => {
    __setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    const listed = settings({ policy: policy({ allowedDomains: ["caller.example"] }) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(new HttpClient(listed).request("https://api.example/x")).rejects.toThrow('Domain "api.example" is not in the allowed list');
    await expect(new HttpClient(listed).request("https://api.example/x", {}, { allowlistedAs: "https://caller.example/" })).resolves.toMatchObject({ status: 200 });
    vi.stubGlobal("fetch", vi.fn(async () => redirectTo("https://elsewhere.example/")));
    await expect(new HttpClient(listed).request("https://api.example/x", {}, { allowlistedAs: "https://caller.example/" }))
      .rejects.toThrow('Domain "elsewhere.example" is not in the allowed list');
  });

  it("fixedUpstream skips the allowlist on the first hop only and keeps the literal guards", async () => {
    __setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    const listed = settings({ policy: policy({ allowedDomains: ["caller.example"], privateHosts: [] }) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(new HttpClient(listed).request("https://registry.example/x", {}, { fixedUpstream: true })).resolves.toMatchObject({ status: 200 });
    vi.stubGlobal("fetch", vi.fn(async () => redirectTo("https://elsewhere.example/")));
    await expect(new HttpClient(listed).request("https://registry.example/x", {}, { fixedUpstream: true }))
      .rejects.toThrow('Domain "elsewhere.example" is not in the allowed list');
    await expect(new HttpClient(listed).request("http://169.254.169.254/x", {}, { fixedUpstream: true })).rejects.toThrow("private/internal");
  });

  it("allowlistedAs does not lift the literal guards on the real URL", async () => {
    const listed = settings({ policy: policy({ allowedDomains: ["caller.example"], privateHosts: [] }) });
    await expect(new HttpClient(listed).request("http://169.254.169.254/x", {}, { allowlistedAs: "https://caller.example/" }))
      .rejects.toThrow("private/internal");
  });

  it("re-validates each hop and refuses a redirect to cloud metadata", async () => {
    __setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async () => redirectTo("http://169.254.169.254/latest/meta-data/")));
    await expect(new HttpClient(settings({ policy: policy({ privateHosts: [] }) })).request("https://public.example/x"))
      .rejects.toBeInstanceOf(SsrfGuardError);
  });

  it("refuses a redirect from a public host into a listed private host", async () => {
    __setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async () => redirectTo("http://127.0.0.1:5003/"));
    vi.stubGlobal("fetch", fetchMock);
    const error = await new HttpClient(settings()).request("https://public.example/x", {}, PRIVATE).catch((e) => e);
    expect(error).toBeInstanceOf(SsrfGuardError);
    expect(error.message).toContain("APP_PRIVATE_HOSTS");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a hop whose hostname resolves to an internal address", async () => {
    __setDnsResolverForTests(async (h) => [{ address: h === "evil.example" ? "10.0.0.1" : "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async () => redirectTo("https://evil.example/")));
    await expect(new HttpClient(settings()).request("https://public.example/x")).rejects.toThrow("private/internal");
  });

  it("drops credentials on a redirect to another origin, and keeps them on the same origin", async () => {
    __setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    const seen: { url: string; auth: string | null; cookie: string | null; accept: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ url, auth: h.get("authorization"), cookie: h.get("cookie"), accept: h.get("accept") });
      if (url === "https://api.example/a") return redirectTo("https://api.example/b");
      if (url === "https://api.example/b") return redirectTo("https://other.example/c");
      return new Response("ok", { status: 200 });
    }));
    const headers = { Authorization: "Bearer s3cret", Cookie: "k=v", Accept: "application/json" };
    const res = await new HttpClient(settings()).request("https://api.example/a", { headers });
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { url: "https://api.example/a", auth: "Bearer s3cret", cookie: "k=v", accept: "application/json" },
      { url: "https://api.example/b", auth: "Bearer s3cret", cookie: "k=v", accept: "application/json" },
      { url: "https://other.example/c", auth: null, cookie: null, accept: "application/json" }
    ]);
  });

  it("stops after maxHops", async () => {
    __setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async () => redirectTo("https://public.example/again")));
    const error = await new HttpClient(settings()).request("https://public.example/x", {}, { maxHops: 2 }).catch((e) => e);
    expect(error.message).toBe("Too many redirects (>2)");
    expect(error.kind).toBe("too-many-redirects");
    expect(error.retryable).toBe(false);
  });

  it("refuses a downgrade to http when httpsOnly", async () => {
    __setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async () => redirectTo("http://public.example/plain")));
    await expect(new HttpClient(settings()).request("https://public.example/x", {}, { httpsOnly: true }))
      .rejects.toThrow("non-HTTPS");
  });

  it("classifies a network TypeError as a TransportError", async () => {
    __setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const error = await new HttpClient(settings()).request("https://public.example/x").catch((e) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.message).toBe("Network error: fetch failed");
    expect(error.kind).toBe("network");
  });
});

describe("private-host exemption is per request", () => {
  it("validateUrl refuses a listed private literal unless the request asks for the exemption", async () => {
    const { validateUrl } = await import("../src/index.js");
    expect(() => validateUrl("http://127.0.0.1:5003/", policy())).toThrow(SsrfGuardError);
    expect(() => validateUrl("http://127.0.0.1:5003/", policy(), { allowPrivateHosts: true })).not.toThrow();
  });
});

describe("first-hop DNS check (independent of the pinning dispatcher)", () => {
  it("reports an unresolvable first host as a missing server, without fetching", async () => {
    __setDnsResolverForTests(async () => { throw new Error("ENOTFOUND"); });
    const fetchMock = vi.fn(async () => new Response("reached"));
    vi.stubGlobal("fetch", fetchMock);
    const error = await new HttpClient(settings()).request("https://no-such-host.example/").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toBe("Server not found: https://no-such-host.example/");
    expect((error as TransportError).kind).toBe("not-found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __setDnsResolverForTests(null);
  });

  it("refuses a hostname that resolves to an internal address before any fetch", async () => {
    __setDnsResolverForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
    const fetchMock = vi.fn(async () => new Response("reached"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new HttpClient(settings({ policy: policy({ privateHosts: [] }) })).request("http://internal.test/"))
      .rejects.toThrow("private/internal");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a listed private IP literal on a strict request before any fetch", async () => {
    const fetchMock = vi.fn(async () => new Response("reached"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new HttpClient(settings()).request("http://127.0.0.1:5003/")).rejects.toBeInstanceOf(SsrfGuardError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the pinning dispatcher, end to end through a hostname", () => {
  let dual: http.Server;
  let port: number;
  let dualHits = 0;
  beforeAll(async () => {
    dual = http.createServer((_req, res) => { dualHits++; res.setHeader("content-type", "application/json"); res.end("{}"); });
    // both stacks, since localhost may resolve to ::1 or 127.0.0.1
    await new Promise<void>((resolve) => dual.listen({ port: 0, host: "::", ipv6Only: false }, () => resolve()));
    port = (dual.address() as AddressInfo).port;
  });
  afterAll(async () => {
    dual.closeAllConnections();
    await new Promise<void>((resolve) => dual.close(() => resolve()));
  });

  it("the strict dispatcher refuses a hostname resolving to loopback, with a live listener there", async () => {
    const { getSafeDispatcher } = await import("../src/index.js");
    const dispatcher = await getSafeDispatcher();
    const before = dualHits;
    await expect(fetch(`http://localhost:${port}/`, { dispatcher } as unknown as RequestInit)).rejects.toThrow();
    expect(dualHits).toBe(before);
  });

  it("the private-host dispatcher connects only for a listed hostname", async () => {
    const { getSafeDispatcher } = await import("../src/index.js");
    const listed = await getSafeDispatcher({ allowPrivateHosts: true, policy: policy({ privateHosts: ["localhost"] }) });
    const before = dualHits;
    const res = await fetch(`http://localhost:${port}/`, { dispatcher: listed } as unknown as RequestInit);
    expect(res.status).toBe(200);
    expect(dualHits).toBe(before + 1);
    const other = await getSafeDispatcher({ allowPrivateHosts: true, policy: policy({ privateHosts: ["other.intra.test"] }) });
    await expect(fetch(`http://localhost:${port}/`, { dispatcher: other } as unknown as RequestInit)).rejects.toThrow();
    expect(dualHits).toBe(before + 1);
  });

  it("HttpClient reaches a listed private hostname only when the request asks for it", async () => {
    const client = new HttpClient(settings({ policy: policy({ privateHosts: ["localhost"] }) }));
    const before = dualHits;
    await expect(client.request(`http://localhost:${port}/`)).rejects.toBeInstanceOf(SsrfGuardError);
    expect(dualHits).toBe(before);
    const res = await client.request(`http://localhost:${port}/`, {}, { allowPrivateHosts: true });
    expect(res.status).toBe(200);
    expect(dualHits).toBe(before + 1);
  });
});

describe("caps and telemetry classification (review fixes)", () => {
  it("caps an undeclared body at the wire cap even when the decompressed cap is higher", async () => {
    const client = new HttpClient(settings({ maxResponseBytes: 8 * 1024, maxDecompressedBytes: 1024 * 1024 }));
    await expect(client.request(`${base}/chunked-big`, {}, PRIVATE)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("classifies the core's edge-52x transport error as unreachable, as ondata did", async () => {
    const { summarizeToolError } = await import("../src/index.js");
    const error = await new HttpClient(settings()).json(`${base}/edge-522`, {}, PRIVATE).catch((e: unknown) => e);
    expect(summarizeToolError((error as Error).message).error_kind).toBe("unreachable");
    expect(summarizeToolError("Network error: Cloudflare could not reach the portal (HTTP 522)").error_kind).toBe("unreachable");
  });

  it("does not retry with the honest identity when a 2xx answer is JSON or the status is an error", async () => {
    seenUserAgents.length = 0;
    await new HttpClient(settings()).request(`${base}/err-small`, {}, PRIVATE);
    expect(seenUserAgents).toEqual(["BrowserUA"]);
  });
});
