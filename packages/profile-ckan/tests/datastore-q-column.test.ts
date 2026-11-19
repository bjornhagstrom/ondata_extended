// Ported from ondata/ckan-mcp-server tests/integration/datastore-q-column.test.ts at bbb4a26 (#603, MIT; D17).
// Reach (docs/test-parity.md, principle 1): the tool is called through the whole CKAN profile on the
// core (ckanClient) instead of a server with only the DataStore tools; ondata's axios mock becomes a
// fake `fetch`, the `q` sent is read from the URL the portal receives, and ondata's axios rejection
// with a 409 response becomes a 409 response with the same body. Expectations unchanged.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __setDnsResolverForTests } from "@ondata-extended/core";
import { ckanClient, fetchedUrl, jsonResponse, mockFetch, stubPublicDns } from "./helpers.js";

const SERVER = "https://open.canada.ca/data";
const OK = { success: true, result: { records: [{ n: 1 }], fields: [{ id: "n", type: "int8" }], total: 1 } };

// Real body, open.canada.ca 2026-10-31 (HTTP 409, resource with 354,153 rows).
const FTS_LIMIT = {
  success: false,
  error: { message: "Invalid request. Full text search is not supported for data with more than 100000 rows.", __type: "Validation Error" }
};

let fetch: ReturnType<typeof mockFetch>;

function sentQ(): unknown {
  return new URL(fetchedUrl(fetch)).searchParams.get("q") ?? undefined;
}

async function search(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const client = await ckanClient();
  const res = await client.callTool("ckan_datastore_search", { server_url: SERVER, resource_id: "big-1", ...args });
  const first = res.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") throw new Error("expected a text content item");
  return { text: first.text, isError: Boolean(res.isError) };
}

describe("ckan_datastore_search q (issue #574)", () => {
  beforeEach(() => {
    stubPublicDns();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __setDnsResolverForTests(null);
  });

  it("keeps a string q as is", async () => {
    fetch = mockFetch(async () => jsonResponse(OK));
    await search({ q: "loan" });
    expect(sentQ()).toBe("loan");
  });

  it("accepts a column-scoped q object and sends it to CKAN as JSON", async () => {
    fetch = mockFetch(async () => jsonResponse(OK));
    const { isError } = await search({ q: { "Data Point Address Label": "loan" } });
    expect(isError).toBe(false);
    expect(sentQ()).toBe('{"Data Point Address Label":"loan"}');
  });

  // New here (not in ondata): an empty object sends no q, as an empty string does.
  it("sends no q for an empty object", async () => {
    fetch = mockFetch(async () => jsonResponse(OK));
    const { isError } = await search({ q: {} });
    expect(isError).toBe(false);
    expect(new URL(fetchedUrl(fetch)).searchParams.has("q")).toBe(false);
  });

  it("on the full-text row limit, suggests column-scoped q first, then filters or SQL ILIKE", async () => {
    fetch = mockFetch(async () => jsonResponse(FTS_LIMIT, { status: 409 }));
    const { text, isError } = await search({ q: "loan" });
    expect(isError).toBe(true);
    expect(text).toContain("Full text search is not supported");
    expect(text).not.toContain("parameters may conflict");
    const col = text.indexOf('{"column":');
    const filters = text.indexOf("`filters`");
    const ilike = text.indexOf("ILIKE");
    expect(col).toBeGreaterThan(-1);
    expect(filters).toBeGreaterThan(col);
    expect(ilike).toBeGreaterThan(col);
  });
});
