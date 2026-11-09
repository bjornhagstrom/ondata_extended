// Ported from ondata/ckan-mcp-server tests/integration/portal-discovery.test.ts at 09e8cdc (MIT).
// Reach (docs/test-parity.md, principle 1): the tool is called through the CKAN profile on the
// core (`ckanClient`). ondata's cache was module-level and reset with `__resetCacheForTests`;
// here it belongs to the engine, so calls that must share it go through one client (one engine),
// and a fresh client starts with an empty cache. DNS is stubbed to a public address (the core
// checks the first hop). Expectations unchanged.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { __setDnsResolverForTests } from "@ondata-extended/core";
import { ckanClient, stubPublicDns } from "./helpers.js";

const portal = (href: string, title: string, country: string) => ({
  Href: href,
  SiteInfo: { site_title: title, locale_default: "it" },
  Coordinates: { country_name: country },
  Version: "2.10",
  Plugins: ["datastore"],
  DatasetsNumber: 100,
  OrgNumber: 5,
  status: "active"
});

/** One client per test: its engine holds the cache, as ondata's module did until reset. */
let client: Awaited<ReturnType<typeof ckanClient>> | null = null;

async function callFindPortals(args: Record<string, unknown>) {
  client ??= await ckanClient();
  return client.callTool("ckan_find_portals", args);
}

describe("ckan_find_portals", () => {
  beforeEach(() => {
    client = null;
    stubPublicDns();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __setDnsResolverForTests(null);
  });

  // The Workers runtime has fetch but not axios's fetch adapter, so the registry is
  // read through fetch: stubbing it is enough to serve the tool.
  it("reads the datashades.info registry through fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ portals: [
        portal("https://dati.comune.milano.it", "Open Data Comune di Milano", "Italy"),
        portal("https://open.canada.ca/data", "Open Canada", "Canada")
      ] }), { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callFindPortals({ country: "Italy" });

    expect(result.isError).toBeFalsy();
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://datashades.info/api/portal/list");
    expect(result.content[0].text).toContain("dati.comune.milano.it");
    expect(result.content[0].text).not.toContain("open.canada.ca");
  });

  it("reports a non-2xx registry answer as an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));

    const result = await callFindPortals({ country: "Italy" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("503");
  });

  describe("registry cache", () => {
    const originalEnv = process.env.CKAN_CACHE_ENABLED;
    const registry = () => new Response(JSON.stringify({ portals: [
      portal("https://dati.comune.milano.it", "Open Data Comune di Milano", "Italy"),
      portal("https://open.canada.ca/data", "Open Canada", "Canada")
    ] }), { status: 200, headers: { "content-type": "application/json" } });

    beforeEach(() => {
      client = null; // a fresh engine: an empty cache
      process.env.CKAN_CACHE_ENABLED = "true";
    });

    afterEach(() => {
      if (originalEnv === undefined) delete process.env.CKAN_CACHE_ENABLED;
      else process.env.CKAN_CACHE_ENABLED = originalEnv;
      client = null;
    });

    // The registry is 22 MB: on the Worker every call paid 5 s median to download it
    // (telemetry 2026-10-04 to 2026-11-04). Filters change, the list does not.
    it("downloads the registry once for calls with different filters", async () => {
      const fetchMock = vi.fn().mockImplementation(async () => registry());
      vi.stubGlobal("fetch", fetchMock);

      const italy = await callFindPortals({ country: "Italy" });
      const canada = await callFindPortals({ country: "Canada" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(italy.content[0].text).toContain("dati.comune.milano.it");
      expect(canada.content[0].text).toContain("open.canada.ca");
      expect(canada.content[0].text).not.toContain("dati.comune.milano.it");
      expect(canada.content[0].text).toContain("| ✅ |");
    });

    it("downloads every time when the cache is disabled", async () => {
      process.env.CKAN_CACHE_ENABLED = "false";
      const fetchMock = vi.fn().mockImplementation(async () => registry());
      vi.stubGlobal("fetch", fetchMock);

      await callFindPortals({ country: "Italy" });
      await callFindPortals({ country: "Italy" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
