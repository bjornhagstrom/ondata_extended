// Ported from ondata/ckan-mcp-server tests/integration/status-hint.test.ts at 09e8cdc (MIT).
// Reach: the fake network moved from axios to fetch (helpers.ts) and the tool is called through
// the CKAN profile on the core; ondata's axios timeout (ECONNABORTED) becomes a fetch that never
// answers until the 50 ms CKAN_TIMEOUT_MS aborts it, its 404 rejection a 404 response.
// Expectations unchanged.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __setDnsResolverForTests } from "@ondata-extended/core";
import { ckanClient, fetchedUrl, jsonResponse, mockFetch, stubPublicDns } from "./helpers.js";

const hang = (_input: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

async function callStatus(serverUrl: string) {
  const client = await ckanClient({ CKAN_TIMEOUT_MS: "50" });
  return client.callTool("ckan_status_show", { server_url: serverUrl });
}

describe("ckan_status_show on a site that is not the CKAN API", () => {
  beforeEach(() => {
    stubPublicDns();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __setDnsResolverForTests(null);
  });

  it.each([
    ["timeout", hang, "Request timeout"],
    ["404", async () => jsonResponse({}, { status: 404 }), "CKAN API error (404)"]
  ])("on %s points at discovery, not at itself", async (_label, impl, message) => {
    mockFetch(impl as never);

    const result = await callStatus("https://open.ottawa.ca");
    const text = result.content[0].text;

    expect(result.isError).toBe(true);
    expect(text).toContain(message);
    expect(text).toContain("ckan_find_portals");
    expect(text).not.toContain("call `ckan_status_show`");
  });

  it("keeps the migration notice when a migrated portal times out", async () => {
    mockFetch(hang as never);

    const result = await callStatus("https://catalog.data.gov");
    const text = result.content[0].text;

    expect(result.isError).toBe(true);
    expect(text).toContain("stopped being a CKAN portal");
    expect(text).not.toContain("ckan_find_portals");
  });

  it("routes open.toronto.ca to its CKAN API host", async () => {
    const fetch = mockFetch(async () =>
      jsonResponse({ success: true, result: { ckan_version: "2.10", site_title: "Toronto", site_url: "https://open.toronto.ca" } })
    );

    const result = await callStatus("https://open.toronto.ca");

    expect(result.isError).toBeFalsy();
    expect(fetchedUrl(fetch)).toContain("ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/status_show");
  });
});
