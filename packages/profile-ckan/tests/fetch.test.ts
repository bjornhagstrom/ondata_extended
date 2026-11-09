/**
 * `fetchAsResponse` (new in round 4): ondata's direct `safeFetch` calls sent through the core.
 * What ondata's callers relied on: the identity, Accept as fetch sends it, no rate token, no
 * honest retry, at most three redirects, https-only redirects when asked, the domain allowlist
 * not applied to the profile's own constant upstreams, and fetch-style errors.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { UpstreamRateLimiter, __setDnsResolverForTests } from "@ondata-extended/core";
import { fetchAsResponse } from "../src/utils/fetch.js";
import { ckanClient, ckanContext, ckanEngine, fetchedHeaders, mockFetch, stubPublicDns } from "./helpers.js";

const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });

beforeEach(stubPublicDns);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.CKAN_ALLOWED_DOMAINS;
  delete process.env.CKAN_RATE_LIMIT_ENABLED;
  __setDnsResolverForTests(null);
});

const base = { timeoutMs: 1000, userAgent: "honest" as const, timeoutStyle: "signal" as const };

describe("fetchAsResponse", () => {
  it("returns a Response with status, text and headers", async () => {
    mockFetch(async () => new Response('{"a":1}', { status: 404, statusText: "Not Found", headers: { "content-type": "application/json" } }));
    const r = await fetchAsResponse(ckanContext(), "https://data.europa.eu/x", {}, base);
    expect(r.status).toBe(404);
    expect(r.ok).toBe(false);
    expect(r.statusText).toBe("Not Found");
    expect(await r.json()).toEqual({ a: 1 });
  });

  it("sends the honest identity and Accept */* when none is given, and the caller's Accept otherwise", async () => {
    const fetch = mockFetch(async () => new Response("{}"));
    await fetchAsResponse(ckanContext(), "https://data.europa.eu/x", {}, base);
    expect(fetchedHeaders(fetch)).toMatchObject({ "user-agent": "CKAN-MCP-Server/1.0", accept: "*/*" });
    await fetchAsResponse(ckanContext(), "https://lod.example/sparql", { headers: { Accept: "application/sparql-results+json" } },
      { timeoutMs: 1000, userAgent: { fixed: "Mozilla/5.0 (compatible; CKAN-MCP-Server/1.0)" }, timeoutStyle: "controller" as const });
    expect(fetchedHeaders(fetch, 1)).toMatchObject({ "user-agent": "Mozilla/5.0 (compatible; CKAN-MCP-Server/1.0)", accept: "application/sparql-results+json" });
  });

  it("does not retry an Anubis page with another identity", async () => {
    const fetch = mockFetch(async () => new Response("<html>anubis_challenge</html>"));
    const r = await fetchAsResponse(ckanContext(), "https://data.europa.eu/x", {}, { timeoutMs: 1000, userAgent: { fixed: "X/1" }, timeoutStyle: "signal" as const });
    expect(await r.text()).toContain("anubis_challenge");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("takes no rate token, as ondata's safeFetch did not", async () => {
    process.env.CKAN_RATE_LIMIT_ENABLED = "true";
    const acquire = vi.spyOn(UpstreamRateLimiter.prototype, "acquire");
    mockFetch(async () => new Response("{}"));
    await fetchAsResponse(ckanContext(), "https://data.europa.eu/x", {}, base);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("follows at most three redirects (safeFetch's default)", async () => {
    const fetch = mockFetch(async () => redirectTo("https://data.europa.eu/again"));
    await expect(fetchAsResponse(ckanContext(), "https://data.europa.eu/x", {}, base)).rejects.toThrow("Too many redirects (>3)");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("refuses a redirect to http when httpsOnly", async () => {
    mockFetch(async () => redirectTo("http://data.europa.eu/plain"));
    await expect(fetchAsResponse(ckanContext(), "https://data.europa.eu/x", {}, { ...base, httpsOnly: true })).rejects.toThrow("non-HTTPS");
  });

  it("exempts the profile's own constant upstream from CKAN_ALLOWED_DOMAINS, and only that", async () => {
    process.env.CKAN_ALLOWED_DOMAINS = "www.dati.gov.it";
    mockFetch(async () => new Response("{}"));
    await expect(fetchAsResponse(ckanContext(), "https://data.europa.eu/x", {}, { ...base, fixedUpstream: true })).resolves.toMatchObject({ status: 200 });
    await expect(fetchAsResponse(ckanContext(), "https://data.europa.eu/x", {}, base)).rejects.toThrow("not in the allowed list");
  });

  it("reports transport failures as fetch did: TypeError for the network, TimeoutError for the timer", async () => {
    mockFetch(async () => { throw new TypeError("fetch failed"); });
    const network = await fetchAsResponse(ckanContext(), "https://data.europa.eu/x", {}, base).catch((e: unknown) => e);
    expect(network).toBeInstanceOf(TypeError);
    expect((network as Error).message).toBe("fetch failed");

    mockFetch((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const timeout = await fetchAsResponse(ckanContext(), "https://data.europa.eu/x", {}, { ...base, timeoutMs: 30 }).catch((e: unknown) => e);
    expect((timeout as Error).name).toBe("TimeoutError");
    expect((timeout as Error).message).toBe("The operation was aborted due to timeout");

    __setDnsResolverForTests(async () => { throw new Error("ENOTFOUND"); });
    const missing = await fetchAsResponse(ckanContext(), "https://no-such.example/x", {}, base).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(TypeError);
    expect((missing as Error).message).toBe("fetch failed");
  });
});

describe("sparql_query failures read as in ondata (its own DNS check, its AbortController timer)", () => {
  it("an unknown endpoint host: Cannot resolve ... (failing closed)", async () => {
    __setDnsResolverForTests(async () => { throw new Error("ENOTFOUND"); });
    const fetch = mockFetch(async () => new Response("{}"));
    const client = await ckanClient();
    const r = await client.callTool("sparql_query", { endpoint_url: "https://no-such.example/sparql", query: "SELECT ?s WHERE { ?s ?p ?o }" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('SPARQL query failed:\nCannot resolve "no-such.example" for SSRF validation (failing closed).');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a stalled endpoint: This operation was aborted", async () => {
    mockFetch((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const { querySparqlEndpoint } = await import("../src/tools/sparql.js");
    const ctx = ckanContext(ckanEngine({ CKAN_TIMEOUT_MS: "30" }));
    // the call's own 15 s timeout wins over CKAN_TIMEOUT_MS, so the clock is faked to reach it
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = querySparqlEndpoint(ctx, "https://lod.dati.gov.it/sparql", "SELECT ?s WHERE { ?s ?p ?o }").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15000);
    vi.useRealTimers();
    const error = await pending;
    expect((error as Error).name).toBe("AbortError");
    expect((error as Error).message).toBe("This operation was aborted");
  });
});
