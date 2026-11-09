/**
 * The CKAN deployment without the reference clone: routes, health counts, and ondata's log
 * fields (src/worker.ts:280-309 at 09e8cdc). worker-parity.test.ts compares all of it with ondata.
 */
import { describe, it, expect } from "vitest";
import worker, { ckanLogEntry } from "../src/worker.js";
import { profile, SERVER_NAME, SERVER_VERSION } from "../src/server.js";

describe("CKAN Worker routes", () => {
  it("/health is ondata's body with counts from the profile", async () => {
    const res = await worker.fetch(new Request("https://c.example/health"), {});
    expect(await res.json()).toEqual({ status: "ok", version: SERVER_VERSION, tools: 20, resources: 7, prompts: 6, runtime: "cloudflare-workers" });
    expect(profile.tools).toHaveLength(20);
  });

  it("/ is ondata's page with this origin's endpoint", async () => {
    const page = await (await worker.fetch(new Request("https://c.example/"), {})).text();
    expect(page).toContain("<title>CKAN MCP Server</title>");
    expect(page).toContain('"url": "https://c.example/mcp"');
  });

  it("names the server as ondata does", () => {
    expect(SERVER_NAME).toBe("ckan-mcp-server");
  });
});

describe("service notices (deployment settings, ondata's texts by default)", () => {
  const listTools = () => new Request("https://c.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });

  it("/mcp headers come from CKAN_SERVICE_NOTICE and CKAN_SERVICE_RECOMMENDATION", async () => {
    const res = await worker.fetch(listTools(), { CKAN_SERVICE_NOTICE: "Test instance", CKAN_SERVICE_RECOMMENDATION: "https://r.example" });
    expect(res.headers.get("X-Service-Notice")).toBe("Test instance");
    expect(res.headers.get("X-Recommendation")).toBe("https://r.example");
  });

  it("without them, ondata's headers", async () => {
    const res = await worker.fetch(listTools(), {});
    expect(res.headers.get("X-Service-Notice")).toBe("Demo instance - 100k requests/day shared quota");
    expect(res.headers.get("X-Recommendation")).toBe("https://github.com/ondata/ckan-mcp-server#installation");
  });

  it("the test deployment's wrangler.toml sets all three, and not to ondata's texts", async () => {
    const { readFileSync } = await import("node:fs");
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    for (const name of ["CKAN_SERVICE_NOTICE", "CKAN_SERVICE_RECOMMENDATION", "CKAN_DEMO_NOTICE"]) {
      expect(toml).toMatch(new RegExp(`^${name} = "`, "m"));
    }
    expect(toml).toContain("not ondata's service");
    expect(toml).not.toContain("Demo instance");
    expect(toml).toMatch(/^send_metrics = false$/m);
  });
});

describe("ckanLogEntry", () => {
  it("logs server_url or endpoint_url as server, the listed arguments, sql and objects capped at 200", () => {
    const entry = ckanLogEntry("ckan_datastore_search_sql", {
      server_url: "https://p.example", sql: "x".repeat(300), filters: { a: "y".repeat(300) }, q: "z".repeat(300), unlisted: 1
    });
    expect(entry.tool).toBe("ckan_datastore_search_sql");
    expect(entry.server).toBe("https://p.example");
    expect(entry.sql).toHaveLength(200);
    expect(entry.filters).toHaveLength(200);
    expect(entry.q).toHaveLength(300); // ondata does not cap q
    expect(entry).not.toHaveProperty("unlisted");
    expect(ckanLogEntry("sparql_query", { endpoint_url: "https://s.example/sparql" }).server).toBe("https://s.example/sparql");
    expect(ckanLogEntry("ckan_find_portals", {}).server).toBe("");
  });

  it("keeps ondata's key order (sql right after limit)", () => {
    const entry = ckanLogEntry("t", { country: "Italy", sql: "s", limit: 1, q: "a", page: 2, fields: ["f"] });
    expect(Object.keys(entry)).toEqual(["tool", "server", "q", "limit", "sql", "country", "page", "fields"]);
  });
});
