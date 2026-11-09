// Ported from ondata/ckan-mcp-server tests/integration/relevant-zero-hint.test.ts at 09e8cdc (MIT).
// Reach: the tool is called through the whole CKAN profile on the core (ckanClient) instead of
// ondata's registerPackageTools; the fake network moved from axios to fetch. Expectations unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { __setDnsResolverForTests } from "@ondata-extended/core";
import { ckanClient, jsonResponse, mockFetch, stubPublicDns } from "./helpers.js";

const SERVER_URL = "https://www.dati.gov.it/opendata";

async function callRelevant(query: string): Promise<string> {
  const client = await ckanClient();
  const result = await client.callTool("ckan_find_relevant_datasets", { server_url: SERVER_URL, query });
  return result.content[0].text;
}

// From the worker telemetry (2026-11-03, dati.comune.milano.it): the query below
// returned 0 because two of its five terms are in no dataset, while the first three
// alone returned 142. ckan_package_search already suggested the OR rewrite.
describe("ckan_find_relevant_datasets zero-result hint", () => {
  beforeEach(() => {
    stubPublicDns();
    mockFetch(async () => jsonResponse({ success: true, result: { count: 0, results: [], facets: {} } }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __setDnsResolverForTests(null);
  });

  it("suggests the OR rewrite for a plain multi-term query", async () => {
    const text = await callRelevant("popolazione residente cittadinanza cinese Cina");
    expect(text).toContain("No datasets matched the query terms.");
    expect(text).toContain('`query: "popolazione OR residente OR cittadinanza OR cinese OR Cina"`');
  });

  it("keeps a quoted phrase whole and escapes its quotes", async () => {
    const text = await callRelevant('"made in Italy" fondo');
    expect(text).toContain('`query: "\\"made in Italy\\" OR fondo"`');
  });

  it("gives no tip for a single term", async () => {
    const text = await callRelevant("zzqxnonesiste");
    expect(text).not.toContain("Tip");
  });
});
