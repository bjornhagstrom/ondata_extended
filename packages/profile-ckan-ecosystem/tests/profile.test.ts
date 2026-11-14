/**
 * The profile end to end: real engine, real MCP client (in memory), the bundled index, and README answers recorded
 * from GitHub on 2026-11-14 (tests/fixtures/github). Every request still passes the core's guards; only `fetch` and
 * DNS are stubbed. Assertions use stable facts of the index (that ckanext-dcat provides the plugin dcat), not counts
 * that move with the weekly crawl.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { __setDnsResolverForTests, createEngine, createMcpServer, registerProfiles } from "@ondata-extended/core";
import { createEcosystemProfile } from "../src/index.js";

const FIX = join(import.meta.dirname, "fixtures", "github");
const recorded = new Map<string, { body: string; status: number; contentType: string }>();
for (const f of readdirSync(FIX).filter((n) => n.endsWith(".meta.json"))) {
  const meta = JSON.parse(readFileSync(join(FIX, f), "utf8")) as { url: string; status: number; contentType: string };
  recorded.set(meta.url, { body: readFileSync(join(FIX, f.replace(".meta.json", ".body")), "utf8"), status: meta.status, contentType: meta.contentType });
}

let requests: string[] = [];
beforeEach(() => {
  requests = [];
  __setDnsResolverForTests(async () => [{ address: "185.199.108.133", family: 4 }]);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push(url);
    const hit = recorded.get(url);
    if (!hit) return new Response(`no fixture for ${url}`, { status: 599 });
    return new Response(hit.body, { status: hit.status, headers: { "content-type": hit.contentType } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setDnsResolverForTests(null);
});

async function client(env: Record<string, string> = {}) {
  const engine = createEngine({ configPrefixes: ["ECOSYSTEM"], configSource: { ECOSYSTEM_RATE_LIMIT_ENABLED: "false", ...env }, cacheOrigin: "https://t.internal" });
  const server = createMcpServer({ name: "t", version: "0" });
  registerProfiles(server, [createEcosystemProfile()], engine);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
}

const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = await c.callTool({ name, arguments: args });
  return { text: (r.content as { text: string }[])[0].text, isError: r.isError === true, structured: r.structuredContent as Record<string, unknown> | undefined };
};
const jsonl = (text: string) => text.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

describe("the four tools", () => {
  it("are registered with the ecosystem_ prefix, read-only, with examples in the description", async () => {
    const tools = (await (await client()).listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["ecosystem_get_extension", "ecosystem_overview", "ecosystem_portals_using", "ecosystem_search_extensions"]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: t.name === "ecosystem_get_extension" });
      expect(t.description).toContain("Examples:");
    }
  });

  it("search finds ckanext-dcat for 'harvest dcat' and ckanext-scheming for its plugin name, with no request", async () => {
    const c = await client();
    const dcat = await call(c, "ecosystem_search_extensions", { query: "harvest dcat", limit: 5 });
    expect(jsonl(dcat.text).map((r) => r.repo)).toContain("ckan/ckanext-dcat");
    expect(dcat.structured).toMatchObject({ columns: ["repo", "plugins", "description", "portals", "stars", "upkeep", "last_push"] });
    const scheming = await call(c, "ecosystem_search_extensions", { query: "scheming_datasets", limit: 3 });
    expect(jsonl(scheming.text)[0].repo).toBe("ckan/ckanext-scheming");
    expect(requests).toEqual([]);
  });

  it("get_extension without the README makes no request and still shows ckanext-dcat's plugins", async () => {
    const r = await call(await client(), "ecosystem_get_extension", { extension: "ckan/ckanext-dcat", include_readme: false });
    expect(r.text).toMatch(/\*\*Plugins\*\*: .*dcat_rdf_harvester/);
    expect(requests).toEqual([]);
  });

  it("get_extension shows ckanext-qa with the README opening read from README.rst after a recorded 404, wrapped as untrusted", async () => {
    const r = await call(await client({ ECOSYSTEM_ALLOWED_DOMAINS: "raw.githubusercontent.com" }), "ecosystem_get_extension", { extension: "https://github.com/ckan/ckanext-qa" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^# ckan\/ckanext-qa/);
    expect(r.text).toMatch(/untrusted content from the extension repositories on GitHub[\s\S]*The ckanext-qa extension will check each of your dataset resources/);
    expect(r.text).toMatch(/Data: CKAN ecosystem crawl by datHere .*\.$/);
    expect(requests).toEqual(["https://raw.githubusercontent.com/ckan/ckanext-qa/HEAD/README.md", "https://raw.githubusercontent.com/ckan/ckanext-qa/HEAD/README.rst"]);
  });

  it("an unknown extension is an error with the profile's hint", async () => {
    const r = await call(await client(), "ecosystem_get_extension", { extension: "nope/nothing" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("is not in the CKAN ecosystem data");
    expect(r.text).toContain("Use ecosystem_search_extensions");
    expect(requests).toEqual([]);
  });

  it("portals_using lists portals that report the plugin dcat, with URLs", async () => {
    const r = await call(await client(), "ecosystem_portals_using", { plugin: "dcat", limit: 5 });
    const rows = jsonl(r.text);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.url).toMatch(/^https?:\/\//);
    expect(r.text).toMatch(/Showing 5 of \d+ portals/);
  });

  it("overview names the data date and the families", async () => {
    const r = await call(await client(), "ecosystem_overview", {});
    expect(r.text).toContain("# CKAN ecosystem overview");
    expect(r.text).toContain("ckanext-dcat");
    expect(r.text).toMatch(/extensions week \d{4}-\d{2}-\d{2}/);
  });
});
