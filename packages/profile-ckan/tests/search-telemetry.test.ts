// Ported from ondata/ckan-mcp-server tests/integration/search-telemetry.test.ts at 09e8cdc (MIT).
// Reach: ondata keyed the side channel by any object through `recordSearchResults(key, ...)`;
// here a tool records through its engine context, which the core keys by the server instance,
// so the unit tests build a context for that key (`ckanContext(engine, key)`) and read it back
// with `takeSearchResults` from helpers.ts (the core's takeTelemetry, search fields picked).
// Tools are called through the whole CKAN profile (ckanClient), the fake network is fetch.
// Expectations unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { __setDnsResolverForTests } from "@ondata-extended/core";
import { recordSearchResults, SEARCH_TELEMETRY_MAX_RESULTS } from "../src/utils/search-telemetry.js";
import packageSearchFixture from "./fixtures/responses/package-search-success.json";
import { ckanClient, ckanContext, ckanEngine, jsonResponse, mockFetch, stubPublicDns, takeSearchResults } from "./helpers.js";

const SERVER_URL = "https://www.dati.gov.it/opendata";
const engine = ckanEngine();
const ctxFor = (key: object) => ckanContext(engine, key);

async function connect() {
  return ckanClient();
}

describe("search telemetry side channel", () => {
  it("caps results and clears after take", () => {
    const key = {};
    const datasets = Array.from({ length: 30 }, (_, i) => ({ id: `id-${i}`, name: `name-${i}` }));
    recordSearchResults(ctxFor(key), 30, 10, datasets, datasets.map((d) => d.id).join(" "));

    const taken = takeSearchResults(key) as any;
    expect(taken?.result_count).toBe(30);
    expect(taken?.result_start).toBe(10);
    expect(taken?.result_ids).toHaveLength(SEARCH_TELEMETRY_MAX_RESULTS);
    expect(taken?.result_names[0]).toBe("name-0");
    expect(takeSearchResults(key)).toBeNull();
  });

  it("keeps instances separate", () => {
    const a = {};
    const b = {};
    recordSearchResults(ctxFor(a), 1, 0, [{ id: "a", name: "a" }], "a");
    expect(takeSearchResults(b)).toBeNull();
    expect((takeSearchResults(a) as any)?.result_ids).toEqual(["a"]);
  });

  it("skips datasets missing from the reply and falls back to the id for names", () => {
    const key = {};
    recordSearchResults(
      ctxFor(key),
      3,
      0,
      [{ id: "kept-id", name: "kept-name" }, { id: "no-name" }, { id: "cut-id", name: "cut-name" }],
      "kept-name no-name"
    );
    expect(takeSearchResults(key)).toEqual({
      result_count: 3,
      result_start: 0,
      result_ids: ["kept-id", "no-name"],
      result_names: ["kept-name", "no-name"]
    });
  });
});

describe("search tools record returned datasets", () => {
  beforeEach(() => {
    stubPublicDns();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __setDnsResolverForTests(null);
  });

  it("ckan_package_search records ids, names, count and start", async () => {
    mockFetch(async () => jsonResponse(packageSearchFixture));
    const { server, callTool } = await connect();

    await callTool("ckan_package_search", { server_url: SERVER_URL, q: "example", page: 2, page_size: 2 });

    expect(takeSearchResults(server)).toEqual({
      result_count: 100,
      result_start: 2,
      result_ids: ["pkg-1", "pkg-2"],
      result_names: ["example-dataset", "another-dataset"]
    });
  });

  it("ckan_package_search records zero results", async () => {
    mockFetch(async () => jsonResponse({ success: true, result: { count: 0, results: [], facets: {} } }));
    const { server, callTool } = await connect();

    await callTool("ckan_package_search", { server_url: SERVER_URL, q: "zzqxnonesiste" });

    expect(takeSearchResults(server)).toMatchObject({ result_count: 0, result_ids: [], result_names: [] });
  });

  it("ckan_find_relevant_datasets records the ranked datasets", async () => {
    mockFetch(async () => jsonResponse(packageSearchFixture));
    const { server, callTool } = await connect();

    await callTool("ckan_find_relevant_datasets", { server_url: SERVER_URL, query: "example dataset", limit: 5 });

    const taken = takeSearchResults(server) as any;
    expect(taken?.result_count).toBe(100);
    expect(taken?.result_start).toBe(0);
    expect([...(taken?.result_ids ?? [])].sort()).toEqual(["pkg-1", "pkg-2"]);
    expect(taken?.result_names).toHaveLength(2);
  });
});
