// Ported from ondata/ckan-mcp-server tests/integration/portal-discovery.test.ts at 09e8cdc (MIT).
// Reach (docs/test-parity.md, principle 1): the tool is called through the CKAN profile on the
// core (`ckanClient`). ondata's cache was module-level and reset with `__resetCacheForTests`;
// here it belongs to the engine, so calls that must share it go through one client (one engine),
// and a fresh client starts with an empty cache. DNS is stubbed to a public address (the core
// checks the first hop). Expectations unchanged. Includes the tests added in ondata 9e52cfa (#598, D15)
// and 81fad15 (#600, D16).
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

  // datashades.info lists active portals with no default locale (3 of 945 on
  // 2026-11-15): the language filter crashed on them, for every language.
  it("filters by language when a portal has no locale", async () => {
    const noLocale = { ...portal("https://ckan.example.org", "No locale", "Italy"), SiteInfo: { site_title: "No locale", locale_default: null } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ portals: [
        noLocale,
        portal("https://dati.comune.milano.it", "Open Data Comune di Milano", "Italy")
      ] }), { status: 200, headers: { "content-type": "application/json" } })
    ));

    const result = await callFindPortals({ language: "it" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("dati.comune.milano.it");
    expect(result.content[0].text).not.toContain("ckan.example.org");
  });

  // New here (not in ondata 9e52cfa, which tests only the language filter): the other two
  // filters and the output read null registry fields as empty too.
  it("filters by country and title when a portal has null fields", async () => {
    const nulls = { ...portal("https://ckan.example.org", "x", "x"), SiteInfo: { site_title: null, locale_default: null }, Coordinates: { country_name: null } };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ portals: [
        nulls,
        portal("https://dati.comune.milano.it", "Open Data Comune di Milano", "Italy")
      ] }), { status: 200, headers: { "content-type": "application/json" } })
    ));

    for (const args of [{ country: "Italy" }, { query: "Milano" }]) {
      const result = await callFindPortals(args);
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("dati.comune.milano.it");
      expect(result.content[0].text).not.toContain("ckan.example.org");
    }
  });

  it("lists a portal with no locale with an empty cell in Markdown and null in JSON", async () => {
    const noLocale = { ...portal("https://ckan.example.org", "No locale", "Italy"), SiteInfo: { site_title: "No locale", locale_default: null } };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ portals: [noLocale] }), { status: 200, headers: { "content-type": "application/json" } })
    ));

    const md = await callFindPortals({ country: "Italy" });
    expect(md.isError).toBeFalsy();
    expect(md.content[0].text).toContain("| [No locale](https://ckan.example.org) | Italy | 2.10 | 100 |  | ✅ |");
    expect(md.content[0].text).not.toContain("null");

    const json = await callFindPortals({ country: "Italy", response_format: "json" });
    expect(JSON.parse(json.content[0].text).portals[0].locale).toBeNull();
  });

  it("reports a non-2xx registry answer as an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));

    const result = await callFindPortals({ country: "Italy" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("503");
  });

  // Every other tool takes response_format; clients sent it here too and the strict
  // schema rejected the call (2 events on 2026-11-17).
  describe("response_format", () => {
    const registry = () => new Response(JSON.stringify({ portals: [
      portal("https://dati.comune.milano.it", "Open Data Comune di Milano", "Italy")
    ] }), { status: 200, headers: { "content-type": "application/json" } });

    it("json returns the portal list as parseable JSON", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(registry()));

      const result = await callFindPortals({ country: "Italy", response_format: "json" }) as Awaited<ReturnType<typeof callFindPortals>> & { structuredContent?: unknown };

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.portals[0].url).toBe("https://dati.comune.milano.it");
      expect(parsed.portals[0].has_datastore).toBe(true);
      expect(result.structuredContent).toEqual(parsed);
    });

    it("markdown keeps the table", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(registry()));

      const result = await callFindPortals({ country: "Italy", response_format: "markdown" });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("| Portal |");
    });

    it("json errors stay JSON", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));

      const result = await callFindPortals({ country: "Italy", response_format: "json" });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._error).toBe(true);
      expect(parsed.error).toContain("503");
    });
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
