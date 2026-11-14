/**
 * The CKAN request layer: `makeCkanRequest`, its cache and audit log, `formatCkanError` and the TTL table.
 *
 * Ported from ondata/ckan-mcp-server at 09e8cdc (MIT, see NOTICE.md):
 *  - tests/unit/http.test.ts 364-946 (makeCkanRequest, redirect validation, CKAN_PRIVATE_HOSTS,
 *    Anubis retry), 947-1024 (cache integration), 1054-1111 (audit logging), 1112-1473 (formatCkanError);
 *  - tests/unit/cache.test.ts 64-84 (getTtlForAction).
 *
 * How the reach changed (docs/test-parity.md, principle 1): ondata mocked axios and, for its Workers
 * path, stubbed `fetch` and hid `process.versions.node`. There is one path here, through the core
 * client, so every test fakes `fetch` (or, where the point is a real connection, uses a loopback
 * server). DNS is stubbed to a public address. ondata's axios `beforeRedirect` hook, tested on its
 * own, is tested here as a redirect chain answered by the fake `fetch`. Config is read from
 * `process.env` when the engine is built (`ckanEngine`), and the module-level cache and rate
 * limiter of ondata are the engine's: one engine per test where calls must share them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import {
  SsrfGuardError,
  UpstreamRateLimiter,
  createSsrfSafeLookup,
  isAnubisChallenge,
  summarizeToolError,
  __setDnsResolverForTests
} from "@ondata-extended/core";
import { makeCkanRequest, CkanApiError, CkanTransportError, formatCkanError, getTtlForAction } from "../src/utils/http.js";
import { ckanContext, ckanEngine, fetchedHeaders, fetchedUrl, jsonResponse, mockFetch, stubPublicDns } from "./helpers.js";
import successResponse from "./fixtures/responses/status-success.json";

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** A fake `fetch` that answers each call with the next response; the last one repeats. */
function sequence(...responses: (() => Response)[]) {
  let n = 0;
  return mockFetch(async () => responses[Math.min(n++, responses.length - 1)]());
}

const redirectTo = (location: string) => () => new Response(null, { status: 302, headers: { Location: location } });
const ok = () => jsonResponse(successResponse);

/** Keep `process.env` as it was before each test. */
const ENV_KEYS = ["CKAN_ALLOWED_DOMAINS", "CKAN_PRIVATE_HOSTS", "CKAN_CACHE_ENABLED", "CKAN_RATE_LIMIT_ENABLED"];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  stubPublicDns();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  __setDnsResolverForTests(null);
});

describe("makeCkanRequest", () => {
  describe("redirect validation (GHSA-279h-fmcr-4rwv)", () => {
    // Two loopback listeners: `target` counts hits, `redirector` 302s to `location(port)`.
    async function withRedirector(
      location: (targetPort: number) => string,
      run: (redirectorPort: number, hits: () => number) => Promise<void>
    ): Promise<void> {
      const http = await import("node:http");
      let hits = 0;
      const target = http.createServer((_req, res) => { hits++; res.end('{"success":true,"result":"INTERNAL"}'); });
      await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
      const targetPort = (target.address() as AddressInfo).port;
      const redirector = http.createServer((_req, res) => {
        res.writeHead(302, { Location: location(targetPort) });
        res.end();
      });
      await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", () => resolve()));
      try {
        await run((redirector.address() as AddressInfo).port, () => hits);
      } finally {
        await new Promise<void>((resolve) => redirector.close(() => resolve()));
        await new Promise<void>((resolve) => target.close(() => resolve()));
      }
    }

    // ondata drove real axios at a loopback redirector, bypassing makeCkanRequest's own first-hop
    // check. Here the first hop is a public name, so the redirect is answered by the fake fetch;
    // "nothing fetched" is that the target is never requested.
    it("real axios with the built config refuses a live redirect to a loopback IP literal", async () => {
      delete process.env.CKAN_ALLOWED_DOMAINS;
      const fetch = sequence(redirectTo("http://127.0.0.1:8080/secret"), ok);
      await expect(
        makeCkanRequest<any>(ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false })
      ).rejects.toThrow(/private|internal/i);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("real axios with the built config refuses a live redirect outside CKAN_ALLOWED_DOMAINS", async () => {
      process.env.CKAN_ALLOWED_DOMAINS = "www.dati.gov.it";
      const fetch = sequence(redirectTo("http://outside.example.invalid/"), ok);
      await expect(
        makeCkanRequest<any>(ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false })
      ).rejects.toThrow(/allowed list/);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("Workers (fetch) path refuses a redirect to a private IP literal without following it", async () => {
      delete process.env.CKAN_ALLOWED_DOMAINS;
      const fetchMock = mockFetch(async () => new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest/meta-data/" }
      }));
      await expect(
        makeCkanRequest<any>(ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false, rateLimit: false })
      ).rejects.toThrow(/private|internal/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    describe("with CKAN_PRIVATE_HOSTS", () => {
      beforeEach(() => { delete process.env.CKAN_ALLOWED_DOMAINS; });

      it("refuses a redirect from a public portal to a listed private host", async () => {
        process.env.CKAN_PRIVATE_HOSTS = "localhost,ckan.intra.example";
        for (const href of ["http://localhost:5003/", "https://ckan.intra.example/"]) {
          const fetch = sequence(redirectTo(href), ok);
          await expect(
            makeCkanRequest<any>(ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false })
          ).rejects.toThrow(/not allowed/);
          expect(fetch).toHaveBeenCalledTimes(1);
        }
      });

      it("follows a redirect between listed hosts but not to an unlisted private one", async () => {
        process.env.CKAN_PRIVATE_HOSTS = "localhost,ckan.intra.example";
        let fetch = sequence(redirectTo("https://ckan.intra.example/"), ok);
        await expect(
          makeCkanRequest<any>(ckanContext(), "http://localhost:5003", "status_show", {}, { cache: false })
        ).resolves.toEqual(successResponse.result);
        expect(fetchedUrl(fetch, 1)).toBe("https://ckan.intra.example/");

        fetch = sequence(redirectTo("http://192.168.1.99/"), ok);
        await expect(
          makeCkanRequest<any>(ckanContext(), "http://localhost:5003", "status_show", {}, { cache: false })
        ).rejects.toThrow(/private|internal/i);
        expect(fetch).toHaveBeenCalledTimes(1);
      });

      it("tracks the chain: public, then listed, is refused even if the first hop was listed", async () => {
        process.env.CKAN_PRIVATE_HOSTS = "localhost";
        const fetch = sequence(redirectTo("https://www.dati.gov.it/x"), redirectTo("http://localhost:5003/secret"), ok);
        await expect(
          makeCkanRequest<any>(ckanContext(), "http://localhost:5003", "status_show", {}, { cache: false })
        ).rejects.toThrow(/not allowed/);
        // The public hop was followed; the way back to the listed host was not.
        expect(fetchedUrl(fetch, 1)).toBe("https://www.dati.gov.it/x");
        expect(fetch).toHaveBeenCalledTimes(2);
      });

      it("real axios: a listed host that redirects to an unlisted private name is refused, nothing is fetched", async () => {
        process.env.CKAN_PRIVATE_HOSTS = "127.0.0.1";
        __setDnsResolverForTests(null); // real connections to the loopback listeners
        await withRedirector((port) => `http://localhost:${port}/secret`, async (redirectorPort, hits) => {
          await expect(
            makeCkanRequest<any>(ckanContext(), `http://127.0.0.1:${redirectorPort}`, "status_show", {}, { cache: false })
          ).rejects.toThrow(/not allowed|private|internal/i);
          expect(hits()).toBe(0);
        });
      });

      it("real axios: a listed host that redirects to the metadata address is refused", async () => {
        process.env.CKAN_PRIVATE_HOSTS = "127.0.0.1,169.254.169.254";
        __setDnsResolverForTests(null);
        await withRedirector(() => "http://169.254.169.254/latest/meta-data/", async (redirectorPort) => {
          await expect(
            makeCkanRequest<any>(ckanContext(), `http://127.0.0.1:${redirectorPort}`, "status_show", {}, { cache: false })
          ).rejects.toThrow(/private|internal/i);
        });
      });
    });

    it("rejects redirects to private IP literals", async () => {
      delete process.env.CKAN_ALLOWED_DOMAINS;
      for (const href of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8080/", "http://[::1]/"]) {
        const fetch = sequence(redirectTo(href), ok);
        await expect(
          makeCkanRequest<any>(ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false })
        ).rejects.toThrow(/private|internal/i);
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    });

    it("rejects redirects to hosts outside CKAN_ALLOWED_DOMAINS", async () => {
      process.env.CKAN_ALLOWED_DOMAINS = "www.dati.gov.it";
      sequence(redirectTo("https://evil.example.com/api/3/action/status_show"), ok);
      await expect(
        makeCkanRequest<any>(ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false })
      ).rejects.toThrow(/allowed list/);

      sequence(redirectTo("https://www.dati.gov.it/opendata/api/3/action/status_show"), ok);
      await expect(
        makeCkanRequest<any>(ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false })
      ).resolves.toEqual(successResponse.result);
    });

    it("allows redirects to public hosts when no allowlist is set", async () => {
      delete process.env.CKAN_ALLOWED_DOMAINS;
      sequence(redirectTo("https://open.canada.ca/data/api/3/action/status_show"), ok);
      await expect(
        makeCkanRequest<any>(ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false })
      ).resolves.toEqual(successResponse.result);
    });
  });

  // ondata's axios path sent a Chrome-like header set (Accept-Language, Connection, Sec-CH-UA*,
  // Accept-Encoding gzip/deflate/br) and `params: {}`; its fetch path, the only one here, sends
  // Accept, identity encoding and the browser User-Agent, and no query string without params.
  it("makes successful request and returns result", async () => {
    const fetch = mockFetch(async () => jsonResponse(successResponse));

    const result = await makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "ckan_status_show");

    expect(fetchedUrl(fetch)).toBe("http://demo.ckan.org/api/3/action/ckan_status_show");
    expect(fetchedHeaders(fetch)).toEqual({
      accept: "application/json, text/plain, */*",
      "accept-encoding": "identity",
      "user-agent": BROWSER_UA
    });
    expect(fetch.mock.calls[0][1]?.method).toBe("GET");
    expect(result).toEqual(successResponse.result);
  });

  it("makes request with parameters", async () => {
    const fetch = mockFetch(async () => jsonResponse(successResponse));

    await makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "package_search", { q: "test", rows: 10 });

    expect(fetchedUrl(fetch)).toBe("http://demo.ckan.org/api/3/action/package_search?q=test&rows=10");
  });

  it("normalizes URL with trailing slash", async () => {
    const fetch = mockFetch(async () => jsonResponse(successResponse));

    await makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org/", "ckan_status_show");

    expect(fetchedUrl(fetch)).toBe("http://demo.ckan.org/api/3/action/ckan_status_show");
  });

  it("resolves portal hostname to api url", async () => {
    const fetch = mockFetch(async () => jsonResponse(successResponse));

    await makeCkanRequest<any>(ckanContext(), "https://dati.anticorruzione.it", "ckan_status_show");

    expect(fetchedUrl(fetch)).toBe("https://dati.anticorruzione.it/opendata/api/3/action/ckan_status_show");
  });

  it("includes User-Agent header", async () => {
    const fetch = mockFetch(async () => jsonResponse(successResponse));

    await makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "ckan_status_show");

    expect(fetchedHeaders(fetch)["user-agent"]).toBe(BROWSER_UA);
  });

  describe("Anubis challenge retry (issue #7)", () => {
    const challengePage =
      "<!doctype html><html><head><title>Making sure you&#39;re not a bot!</title></head>" +
      '<body><script id="anubis_challenge" type="application/json">{}</script></body></html>';
    const challenge = () => new Response(challengePage, { status: 200, headers: { "Content-Type": "text/html" } });

    it("detects the challenge page, not ordinary HTML or JSON", () => {
      expect(isAnubisChallenge(challengePage)).toBe(true);
      expect(isAnubisChallenge("<html><body>Request Rejected</body></html>")).toBe(false);
      expect(isAnubisChallenge(successResponse)).toBe(false);
    });

    it("retries once with the honest UA and no Sec-CH-UA headers", async () => {
      const fetch = sequence(challenge, ok);

      const result = await makeCkanRequest<any>(
        ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false, rateLimit: false }
      );

      expect(result).toEqual(successResponse.result);
      expect(fetch).toHaveBeenCalledTimes(2);
      const first = fetchedHeaders(fetch, 0);
      const retry = fetchedHeaders(fetch, 1);
      expect(first["user-agent"]).toContain("Chrome/120");
      expect(retry["user-agent"]).toBe("CKAN-MCP-Server/1.0");
      expect(retry).not.toHaveProperty("sec-ch-ua");
      expect(retry).not.toHaveProperty("sec-ch-ua-mobile");
      expect(retry).not.toHaveProperty("sec-ch-ua-platform");
    });

    it("does not retry when there is no challenge", async () => {
      const fetch = mockFetch(async () => jsonResponse(successResponse));

      await makeCkanRequest<any>(ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false, rateLimit: false });

      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("retries only once: a second challenge fails as success=false", async () => {
      const fetch = sequence(challenge);

      await expect(
        makeCkanRequest<any>(ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false, rateLimit: false })
      ).rejects.toThrow("CKAN API returned success=false");
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("Workers (fetch) path retries with the honest UA too", async () => {
      delete process.env.CKAN_ALLOWED_DOMAINS;
      const fetchMock = sequence(challenge, () => new Response(JSON.stringify(successResponse), { status: 200 }));
      const result = await makeCkanRequest<any>(
        ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false, rateLimit: false }
      );
      expect(result).toEqual(successResponse.result);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const retryHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
      expect(retryHeaders.get("User-Agent")).toBe("CKAN-MCP-Server/1.0");
    });

    it("the retry acquires its own rate-limit token", async () => {
      vi.stubEnv("CKAN_RATE_LIMIT_ENABLED", "true");
      const acquire = vi.spyOn(UpstreamRateLimiter.prototype, "acquire").mockResolvedValue(undefined);
      sequence(challenge, ok);
      await makeCkanRequest<any>(ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false });
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(acquire).toHaveBeenNthCalledWith(2, "www.dati.gov.it");
    });
  });

  // ondata asserted `proxy: false` in the axios config: no environment proxy, so the SSRF-safe
  // lookup pins the real target. Here the same guarantee is that the request carries the core's
  // pinning dispatcher (global fetch never reads HTTP_PROXY on its own).
  it("disables environment proxies so the SSRF-safe lookup pins the real target", async () => {
    const fetch = mockFetch(async () => jsonResponse(successResponse));

    await makeCkanRequest<any>(ckanContext(), "https://www.dati.gov.it/opendata", "ckan_status_show");

    expect((fetch.mock.calls[0][1] as { dispatcher?: unknown }).dispatcher).toBeDefined();
  });

  it("throws error when success=false in response", async () => {
    mockFetch(async () => jsonResponse({ success: false, error: { message: "Invalid request" } }));

    await expect(
      makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "ckan_status_show")
    ).rejects.toThrow("CKAN API returned success=false");
  });

  it("does NOT reflect the upstream body in the success=false error (GHSA-6f9w)", async () => {
    mockFetch(async () => jsonResponse({ success: false, error: { message: "SECRET_INTERNAL_DETAIL_10.0.0.5" } }));

    let caught: unknown;
    try {
      await makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "ckan_status_show");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("SECRET_INTERNAL_DETAIL");
  });

  // ondata decoded compressed axios buffers itself. With fetch the runtime decodes a declared
  // Content-Encoding, so these go through a real loopback server to reach that decoder.
  async function withCompressedServer(body: Buffer, headers: Record<string, string>, run: (url: string) => Promise<void>) {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => { res.writeHead(200, headers); res.end(body); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    process.env.CKAN_PRIVATE_HOSTS = "127.0.0.1";
    __setDnsResolverForTests(null);
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // A gzip body without Content-Encoding, recognised by its magic bytes (core client).
  it("decodes gzip-compressed buffer payload", async () => {
    const payload = gzipSync(Buffer.from(JSON.stringify(successResponse), "utf-8"));
    await withCompressedServer(payload, {}, async (url) => {
      const result = await makeCkanRequest<any>(ckanContext(), url, "ckan_status_show");
      expect(result).toEqual(successResponse.result);
    });
  });

  it("decodes brotli-compressed buffer payload", async () => {
    const payload = brotliCompressSync(Buffer.from(JSON.stringify(successResponse), "utf-8"));
    await withCompressedServer(payload, { "content-encoding": "br" }, async (url) => {
      const result = await makeCkanRequest<any>(ckanContext(), url, "ckan_status_show");
      expect(result).toEqual(successResponse.result);
    });
  });

  it("decodes deflate-compressed buffer payload", async () => {
    const payload = deflateSync(Buffer.from(JSON.stringify(successResponse), "utf-8"));
    await withCompressedServer(payload, { "content-encoding": "deflate" }, async (url) => {
      const result = await makeCkanRequest<any>(ckanContext(), url, "ckan_status_show");
      expect(result).toEqual(successResponse.result);
    });
  });

  it("throws CkanApiError with status and action from HTTP 4xx response", async () => {
    mockFetch(async () => jsonResponse({ error: { message: "Bad request" } }, { status: 400 }));

    const err = await makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "datastore_search").catch((e) => e);
    expect(err).toBeInstanceOf(CkanApiError);
    expect((err as CkanApiError).status).toBe(400);
    expect((err as CkanApiError).action).toBe("datastore_search");
    expect(err.message).toContain("CKAN API error (400)");
  });

  it("throws CkanApiError with status=undefined for success=false response", async () => {
    mockFetch(async () => jsonResponse({ success: false, error: { message: "not found" } }));

    const err = await makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "package_show").catch((e) => e);
    expect(err).toBeInstanceOf(CkanApiError);
    expect((err as CkanApiError).status).toBeUndefined();
    expect((err as CkanApiError).action).toBe("package_show");
  });

  it('Node: a CKAN validation error reaches the message, not "Unknown error"', async () => {
    const body = { success: false, error: { __type: "Validation Error", query: ['column "anno" does not exist'] } };
    mockFetch(async () => jsonResponse(body, { status: 409 }));

    const err = await makeCkanRequest<any>(
      ckanContext(), "https://dati.comune.messina.it", "datastore_search_sql", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CkanApiError);
    expect(err.message).toBe('CKAN API error (409): query: column "anno" does not exist');
    expect(err.ckanReason).toBe('query: column "anno" does not exist');
  });

  // ondata: axios ECONNABORTED. Here: the 30 s abort.
  it("throws plain Error (not CkanApiError) for timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockFetch((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));

    const pending = makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "ckan_status_show").catch((e) => e);
    await vi.advanceTimersByTimeAsync(30000);
    const err = await pending;
    expect(err).not.toBeInstanceOf(CkanApiError);
    expect(err.message).toContain("Request timeout connecting to http://demo.ckan.org");
  });

  // ondata: axios ENOTFOUND. Here: the first-hop DNS lookup fails.
  it("throws plain Error (not CkanApiError) for ENOTFOUND", async () => {
    __setDnsResolverForTests(async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND demo.ckan.org"), { code: "ENOTFOUND" }); });
    const fetch = mockFetch();

    const err = await makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "ckan_status_show").catch((e) => e);
    expect(err).not.toBeInstanceOf(CkanApiError);
    expect(err.message).toContain("Server not found: http://demo.ckan.org");
    expect(fetch).not.toHaveBeenCalled();
  });

  // ondata: any other axios error. Here: fetch rejects with a TypeError, as undici does.
  it("throws network error for other axios errors", async () => {
    mockFetch(async () => { throw new TypeError("Socket hang up"); });

    await expect(
      makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "ckan_status_show")
    ).rejects.toThrow("Network error: Socket hang up");
  });

  it("rethrows non-axios errors", async () => {
    mockFetch(async () => { throw new Error("Unexpected failure"); });

    await expect(
      makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "ckan_status_show")
    ).rejects.toThrow("Unexpected failure");
  });

  it("Node: a connection-time SSRF refusal keeps its own message, not the unreachable hint", async () => {
    const lookup = createSsrfSafeLookup({
      lookup: (_h: string, _o: any, cb: any) => cb(null, [{ address: "127.0.0.1", family: 4 }])
    } as any, { policy: ckanEngine().policy });
    const guardError = await new Promise<Error>((resolve) =>
      lookup("metadata.evil", {}, (err: any) => resolve(err)));
    expect(guardError).toBeInstanceOf(SsrfGuardError);

    // The host resolves to a loopback address: refused before any connection.
    __setDnsResolverForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
    const fetch = mockFetch();

    const err = await makeCkanRequest<any>(
      ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);

    expect(err).toBeInstanceOf(SsrfGuardError);
    expect(err.message).toContain("private/internal");
    expect(formatCkanError(err, "ckan_package_search")).not.toContain("Portal unreachable");
    expect(formatCkanError(err, "ckan_package_search")).not.toContain("Network error");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Node: a redirect hop refused by the SSRF guard keeps its own message, not the unreachable hint", async () => {
    sequence(redirectTo("http://169.254.169.254/latest/meta-data/"), ok);

    const err = await makeCkanRequest<any>(
      ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);

    expect(err).toBeInstanceOf(SsrfGuardError);
    expect(err.message).toContain("private/internal");
    expect(formatCkanError(err, "ckan_package_search")).not.toContain("Portal unreachable");
    expect(formatCkanError(err, "ckan_package_search")).not.toContain("Redirected request failed");
  });

  // ondata asserted `timeout: 30000` in the axios config. Here: the abort fires at 30 s, not before.
  it("uses correct timeout setting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockFetch((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    let settled = false;
    const pending = makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "ckan_status_show")
      .catch((e) => e)
      .finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(29999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).message).toContain("Request timeout");
  });
});

describe("makeCkanRequest cache integration", () => {
  // ondata reset its module-level cache before each test; here each test builds one engine.
  let ctx: ReturnType<typeof ckanContext>;
  beforeEach(() => {
    process.env.CKAN_CACHE_ENABLED = "true";
    ctx = ckanContext();
  });

  it("serves identical calls from cache after first miss", async () => {
    const fetch = mockFetch(async () => jsonResponse(successResponse));

    await makeCkanRequest<any>(ctx, "http://demo.ckan.org", "status_show");
    await makeCkanRequest<any>(ctx, "http://demo.ckan.org", "status_show");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shares the cache entry between a server URL with and without trailing slash", async () => {
    const fetch = mockFetch(async () => jsonResponse(successResponse));

    await makeCkanRequest<any>(ctx, "https://dati.comune.messina.it/", "status_show");
    await makeCkanRequest<any>(ctx, "https://dati.comune.messina.it", "status_show");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats different params as separate entries", async () => {
    const fetch = mockFetch(async () => jsonResponse(successResponse));

    await makeCkanRequest<any>(ctx, "http://demo.ckan.org", "package_search", { q: "a" });
    await makeCkanRequest<any>(ctx, "http://demo.ckan.org", "package_search", { q: "b" });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache success=false responses", async () => {
    const fetch = mockFetch(async () => jsonResponse({ success: false, error: { message: "bad" } }));

    await expect(makeCkanRequest<any>(ctx, "http://demo.ckan.org", "status_show")).rejects.toThrow();
    await expect(makeCkanRequest<any>(ctx, "http://demo.ckan.org", "status_show")).rejects.toThrow();

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache when opts.cache=false", async () => {
    const fetch = mockFetch(async () => jsonResponse(successResponse));

    await makeCkanRequest<any>(ctx, "http://demo.ckan.org", "status_show", {}, { cache: false });
    await makeCkanRequest<any>(ctx, "http://demo.ckan.org", "status_show", {}, { cache: false });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bypasses cache read when opts.cache=false even if entry exists", async () => {
    const fetch = mockFetch(async () => jsonResponse(successResponse));

    await makeCkanRequest<any>(ctx, "http://demo.ckan.org", "status_show");
    await makeCkanRequest<any>(ctx, "http://demo.ckan.org", "status_show", {}, { cache: false });

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("audit logging", () => {
  it("writes JSON log to stderr after successful HTTP request", async () => {
    mockFetch(async () => jsonResponse(successResponse));
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "package_search", { q: "test", rows: 5 });

    expect(writeSpy).toHaveBeenCalledOnce();
    const line = String(writeSpy.mock.calls[0][0]).trim();
    const log = JSON.parse(line);
    expect(log).toMatchObject({
      server: "http://demo.ckan.org",
      action: "package_search",
      q: "test",
      rows: 5,
      cache_hit: false
    });
    expect(typeof log.ts).toBe("string");
    writeSpy.mockRestore();
  });

  it("logs cache_hit=true when served from cache", async () => {
    process.env.CKAN_CACHE_ENABLED = "true";
    const ctx = ckanContext();
    mockFetch(async () => jsonResponse(successResponse));

    // First call — cache miss
    await makeCkanRequest<any>(ctx, "http://demo.ckan.org", "status_show");

    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // Second call — cache hit
    await makeCkanRequest<any>(ctx, "http://demo.ckan.org", "status_show");

    expect(writeSpy).toHaveBeenCalledOnce();
    const log = JSON.parse(String(writeSpy.mock.calls[0][0]).trim());
    expect(log.cache_hit).toBe(true);
    writeSpy.mockRestore();
  });

  it("truncates sql field to 200 chars in log", async () => {
    mockFetch(async () => jsonResponse(successResponse));
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const longSql = 'SELECT * FROM "abc" WHERE ' + "x=1 AND ".repeat(30);
    await makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "datastore_search_sql", { sql: longSql });

    const log = JSON.parse(String(writeSpy.mock.calls[0][0]).trim());
    expect((log.sql as string).length).toBeLessThanOrEqual(200);
    writeSpy.mockRestore();
  });
});

describe("formatCkanError", () => {
  it("a migrated portal gets the migration notice, whatever the status", () => {
    for (const status of [404, 500, undefined]) {
      const err = new CkanApiError("CKAN API error (404): Not Found", status, "package_search", "https://catalog.data.gov");
      const result = formatCkanError(err, "ckan_package_search");
      expect(result).toContain("stopped being a CKAN portal");
      expect(result).toContain("https://resources.data.gov/catalog-api/");
      expect(result).not.toContain("retry later");
      expect(result).not.toContain("ckan_package_search");
    }
  });

  it("a working portal keeps the status-based hint", () => {
    const err = new CkanApiError("CKAN API error (500): Internal Server Error", 500, "package_search", "https://open.canada.ca/data");
    const result = formatCkanError(err, "ckan_package_search");
    expect(result).toContain("internal error");
    expect(result).not.toContain("stopped being");
  });

  it("an error without a portal URL behaves as before", () => {
    const err = new CkanApiError("CKAN API error (404): Not Found", 404, "package_show");
    expect(err.serverUrl).toBeUndefined();
    expect(formatCkanError(err, "ckan_package_show")).toContain("ckan_package_search");
  });

  it("404 on datastore_search mentions ckan_package_show and datastore_active", () => {
    const err = new CkanApiError("CKAN API error (404): Not Found", 404, "datastore_search");
    const result = formatCkanError(err, "ckan_datastore_search");
    expect(result).toContain("ckan_package_show");
    expect(result).toContain("datastore_active");
  });

  it("404 on datastore_search_sql says the portal lacks the SQL endpoint, not that the resource_id is wrong", () => {
    const err = new CkanApiError("CKAN API error (404): Not Found", 404, "datastore_search_sql");
    const result = formatCkanError(err, "ckan_datastore_search_sql");
    expect(result).toContain("does not expose the SQL endpoint");
    expect(result).toContain("ckan_datastore_search");
    expect(result).not.toContain("ckan_package_show");
  });

  it("404 on package_show mentions ckan_package_search", () => {
    const err = new CkanApiError("CKAN API error (404): Not Found", 404, "package_show");
    expect(formatCkanError(err, "ckan_package_show")).toContain("ckan_package_search");
  });

  it("404 on organization_show mentions ckan_organization_list", () => {
    const err = new CkanApiError("CKAN API error (404): Not Found", 404, "organization_show");
    expect(formatCkanError(err, "ckan_organization_show")).toContain("ckan_organization_list");
  });

  it("404 on group_show mentions ckan_group_list", () => {
    const err = new CkanApiError("CKAN API error (404): Not Found", 404, "group_show");
    const result = formatCkanError(err, "ckan_group_show");
    expect(result).toContain("ckan_group_list");
    expect(result).toContain("ckan_group_search");
  });

  it("a portal that answered success=false keeps the generic hint, not the unreachable one", () => {
    const err = new CkanApiError('CKAN API returned success=false for action "group_list".', undefined, "group_list");
    expect(formatCkanError(err, "ckan_group_list")).not.toContain("ckan_status_show");
  });

  it("400 on datastore_search_sql mentions ckan_datastore_search", () => {
    const err = new CkanApiError("CKAN API error (400): Bad Request", 400, "datastore_search_sql");
    expect(formatCkanError(err, "ckan_datastore_search_sql")).toContain("ckan_datastore_search");
  });

  it("503 mentions retry", () => {
    const err = new CkanApiError("CKAN API error (503): Service Unavailable", 503, "package_search");
    expect(formatCkanError(err, "ckan_package_search")).toContain("retry");
  });

  it("5xx mentions ckan_status_show", () => {
    for (const status of [500, 502, 503, 504]) {
      const err = new CkanApiError(`CKAN API error (${status}): upstream trouble`, status, "package_search");
      expect(formatCkanError(err, "ckan_package_search")).toContain("ckan_status_show");
    }
  });

  it("a transport error gets the unreachable hint, and stays a plain Error", () => {
    const err = new CkanTransportError("Request timeout connecting to https://www.dati.gov.it/opendata", "https://www.dati.gov.it/opendata");
    const result = formatCkanError(err, "ckan_package_search");
    expect(result).toContain("Request timeout connecting to https://www.dati.gov.it/opendata");
    expect(result).toContain("Portal unreachable");
    expect(result).toContain("ckan_status_show");
    expect(result).toContain("can come from the cache for up to an hour");
    expect(err).not.toBeInstanceOf(CkanApiError);
  });

  it.each([
    [522, "<none>"],
    [530, ""],
    [520, "<none>"]
  ])("Workers: a Cloudflare %i is a transport failure, with the unreachable hint", async (status, statusText) => {
    mockFetch(async () => new Response("", { status, statusText }));
    const err = await makeCkanRequest<any>(
      ckanContext(), "https://www.dati.gov.it/opendata", "package_search", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);

    expect(err).toBeInstanceOf(CkanTransportError);
    expect(err.message).toContain(`HTTP ${status}`);
    expect(err.message).not.toContain("<none>");
    expect(formatCkanError(err, "ckan_package_search")).toContain("Portal unreachable");
    expect(summarizeToolError(formatCkanError(err, "ckan_package_search")).error_kind).toBe("unreachable");
  });

  it("Node: a Cloudflare 522 from a portal behind it is a transport failure too", async () => {
    mockFetch(async () => new Response("", { status: 522, statusText: "" }));
    const err = await makeCkanRequest<any>(
      ckanContext(), "https://www.dati.gov.it/opendata", "package_search", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CkanTransportError);
  });

  it("keeps other 5xx as CKAN API errors", async () => {
    mockFetch(async () => new Response("", { status: 529, statusText: "" }));
    const err = await makeCkanRequest<any>(
      ckanContext(), "https://www.dati.gov.it/opendata", "package_search", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CkanApiError);
  });

  it("Workers: a fetch network failure becomes a CkanTransportError with the unreachable hint", async () => {
    mockFetch(async () => { throw new TypeError("fetch failed"); });
    const err = await makeCkanRequest<any>(
      ckanContext(), "https://www.dati.gov.it/opendata", "package_search", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);

    expect(err).toBeInstanceOf(CkanTransportError);
    expect(err.message).toContain("Network error: fetch failed");
    expect(formatCkanError(err, "ckan_package_search")).toContain("ckan_status_show");
  });

  it("Workers: the 30s abort becomes the same timeout error the Node path raises", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockFetch((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      });
    }));
    const pending = makeCkanRequest<any>(
      ckanContext(), "https://www.dati.gov.it/opendata", "package_search", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);
    await vi.advanceTimersByTimeAsync(30000);

    const err = await pending;
    expect(err).toBeInstanceOf(CkanTransportError);
    expect(err.message).toBe("Request timeout connecting to https://www.dati.gov.it/opendata");
    expect(formatCkanError(err, "ckan_package_search")).toContain("Portal unreachable");
  });

  it("Workers: the 30s abort also covers a body that stalls after the headers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockFetch(async (_url, init) => new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          });
        }
      }),
      { status: 200 }
    ));
    const pending = makeCkanRequest<any>(
      ckanContext(), "https://www.dati.gov.it/opendata", "package_search", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);
    await vi.advanceTimersByTimeAsync(30000);

    const err = await pending;
    expect(err).toBeInstanceOf(CkanTransportError);
    expect(err.message).toBe("Request timeout connecting to https://www.dati.gov.it/opendata");
  });

  it("Workers: a connection dropped while reading the body gets the unreachable hint", async () => {
    mockFetch(async () => new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("Network connection lost."));
        }
      }),
      { status: 200 }
    ));
    const err = await makeCkanRequest<any>(
      ckanContext(), "https://www.dati.gov.it/opendata", "package_search", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);

    expect(err).toBeInstanceOf(CkanTransportError);
    expect(err.message).toBe("Network error: Network connection lost.");
    expect(formatCkanError(err, "ckan_package_search")).toContain("Portal unreachable");
  });

  it("Workers: a CKAN error body reaches the message instead of the status text", async () => {
    const body = { success: false, error: { __type: "Authorization Error", message: "Not authorized to call function NULLIF" } };
    mockFetch(async () => new Response(JSON.stringify(body), { status: 403, statusText: "Forbidden" }));
    const err = await makeCkanRequest<any>(
      ckanContext(), "https://www.donneesquebec.ca/recherche", "datastore_search_sql", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CkanApiError);
    expect(err.message).toBe("CKAN API error (403): Not authorized to call function NULLIF");
    expect(formatCkanError(err, "ckan_datastore_search_sql")).toContain("not permitted on this portal");
    // ondata 3369eac: CAST is the function agents hit most (their telemetry 2026-11-10); `::` is not a call.
    expect(formatCkanError(err, "ckan_datastore_search_sql")).toContain('"col"::float');
    expect(summarizeToolError(formatCkanError(err, "ckan_datastore_search_sql")).error_kind).toBe("upstream_http");
  });

  it("Workers: an error body without Content-Length is read only up to 64 KB", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(16 * 1024).fill(120);
    mockFetch(async () => new Response(
      new ReadableStream({ pull(controller) { pulls++; controller.enqueue(chunk); } }),
      { status: 500, statusText: "Internal Server Error" }
    ));
    const err = await makeCkanRequest<any>(
      ckanContext(), "https://www.dati.gov.it/opendata", "package_search", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);
    expect(err.message).toBe("CKAN API error (500): Internal Server Error");
    expect(pulls).toBeLessThan(10);
  });

  it("Workers: a 403 HTML page is reported as bot protection, body not reflected", async () => {
    mockFetch(async () => new Response("<!DOCTYPE html><title>Just a moment...</title>", { status: 403, statusText: "Forbidden" }));
    const err = await makeCkanRequest<any>(
      ckanContext(), "https://data.forest.go.th", "package_search", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);
    expect(err.message).toBe("CKAN API error (403): Forbidden");
    const text = formatCkanError(err, "ckan_package_search");
    expect(text).toContain("bot protection");
    expect(text).not.toContain("Just a moment");
    expect(summarizeToolError(text).error_kind).toBe("upstream_http");
  });

  it("Workers: an SSRF guard failure keeps its own message, not the unreachable hint", async () => {
    mockFetch(async () => new Response(null, {
      status: 302,
      headers: { Location: "http://169.254.169.254/latest/meta-data/" }
    }));
    const err = await makeCkanRequest<any>(
      ckanContext(), "https://www.dati.gov.it/opendata", "status_show", {}, { cache: false, rateLimit: false }
    ).catch((e) => e);

    expect(err).not.toBeInstanceOf(CkanTransportError);
    expect(formatCkanError(err, "ckan_package_search")).not.toContain("Portal unreachable");
  });

  it("a transport error to a portal that moved gets the migration notice instead", () => {
    const err = new CkanTransportError("Request timeout connecting to https://catalog.data.gov", "https://catalog.data.gov");
    const result = formatCkanError(err, "ckan_package_search");
    expect(result).toContain("stopped being a CKAN portal");
    expect(result).not.toContain("Portal unreachable");
  });

  it("409 on datastore_search_sql points at the SQL, not at conflicting parameters", () => {
    const err = new CkanApiError('CKAN API error (409): query: column "anno" does not exist', 409, "datastore_search_sql", undefined, 'query: column "anno" does not exist');
    const text = formatCkanError(err, "ckan_datastore_search_sql");
    expect(text).toContain("SQL");
    expect(text).not.toContain("parameters may conflict");
  });

  it("500 mentions portal internal error", () => {
    const err = new CkanApiError("CKAN API error (500): Internal Server Error", 500, "package_search");
    expect(formatCkanError(err, "ckan_package_search")).toContain("internal error");
  });

  it("status=undefined mentions success=false", () => {
    const err = new CkanApiError("CKAN API returned success=false: {}", undefined, "organization_list");
    expect(formatCkanError(err, "ckan_organization_list")).toContain("success=false");
  });

  it("plain Error returns original message unchanged", () => {
    expect(formatCkanError(new Error("network failure"), "any_tool")).toBe("network failure");
  });

  it("non-Error value returns String()", () => {
    expect(formatCkanError("something went wrong", "any_tool")).toBe("something went wrong");
  });
});

describe("getTtlForAction", () => {
  it("returns 300s for metadata actions", () => {
    expect(getTtlForAction("package_search", 999)).toBe(300);
    expect(getTtlForAction("organization_show", 999)).toBe(300);
    expect(getTtlForAction("tag_list", 999)).toBe(300);
  });

  it("returns 3600s for status actions", () => {
    expect(getTtlForAction("status_show", 999)).toBe(3600);
    expect(getTtlForAction("site_read", 999)).toBe(3600);
  });

  it("returns 60s for datastore actions", () => {
    expect(getTtlForAction("datastore_search", 999)).toBe(60);
    expect(getTtlForAction("datastore_search_sql", 999)).toBe(60);
  });

  it("returns fallback for unknown actions", () => {
    expect(getTtlForAction("unknown_action", 123)).toBe(123);
  });
});

// New in round 2 (not in ondata's tests): branches of the request layer that map core errors.
describe("makeCkanRequest: CKAN-specific handling of core errors and the portals.json rewrite", () => {
  it("checks CKAN_ALLOWED_DOMAINS on the host the caller named, not on the API host portals.json rewrites it to", async () => {
    process.env.CKAN_ALLOWED_DOMAINS = "open.toronto.ca";
    const fetch = mockFetch(async () => jsonResponse(successResponse));
    await expect(makeCkanRequest<any>(ckanContext(), "https://open.toronto.ca", "status_show")).resolves.toEqual(successResponse.result);
    expect(fetchedUrl(fetch)).toContain("ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/status_show");
  });

  it("still refuses a caller host outside CKAN_ALLOWED_DOMAINS", async () => {
    process.env.CKAN_ALLOWED_DOMAINS = "open.toronto.ca";
    const fetch = mockFetch(async () => jsonResponse(successResponse));
    await expect(makeCkanRequest<any>(ckanContext(), "https://demo.ckan.org", "status_show")).rejects.toBeInstanceOf(SsrfGuardError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a redirect loop as a plain error with no retry hint, as ondata's safeFetch did", async () => {
    sequence(redirectTo("http://demo.ckan.org/loop"));
    const error = await makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "status_show").catch((e: unknown) => e);
    expect((error as Error).message).toBe("Too many redirects (>5)");
    expect(error).not.toBeInstanceOf(CkanTransportError);
    expect(formatCkanError(error, "ckan_status_show")).not.toContain("Portal unreachable");
  });

  it("maps a body over the size cap to CkanApiError(\"Response too large\")", async () => {
    mockFetch(async () => new Response("{}", { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } }));
    const error = await makeCkanRequest<any>(ckanContext(), "http://demo.ckan.org", "status_show").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CkanApiError);
    expect((error as CkanApiError).message).toBe(`Response too large (${64 * 1024 * 1024} bytes)`);
    expect((error as CkanApiError).status).toBeUndefined();
    expect((error as CkanApiError).action).toBe("status_show");
  });
});

