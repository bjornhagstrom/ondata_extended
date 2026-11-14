/**
 * Contract tests: the tools against a fake `ctx.http` and the small test index. They check what the profile asks of
 * the engine (URL, options), that only `ecosystem_get_extension` makes requests, and what each tool does with the
 * answers. The end-to-end test (profile.test.ts) covers the tools through the real engine and the bundled index.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEngine } from "@ondata-extended/core";
import type { EngineContext, EngineHttp, FetchOptions, HttpResponse, ToolResult } from "@ondata-extended/profile-contract";
import { ECOSYSTEM_TOOLS, NotInIndexError, createEcosystemProfile } from "../src/index.js";
import { setIndexForTests } from "../src/data.js";
import { SMALL_INDEX } from "./small-index.js";

beforeAll(() => setIndexForTests(SMALL_INDEX));
afterAll(() => setIndexForTests(undefined));

interface Call { url: string; opts?: FetchOptions }

function fakeHttp(answer: (url: string) => HttpResponse | Error): { http: EngineHttp; calls: Call[] } {
  const calls: Call[] = [];
  const http: EngineHttp = {
    async request(url, _init, opts) {
      calls.push({ url, opts });
      const a = answer(url);
      if (a instanceof Error) throw a;
      return a;
    },
    async json() { throw new Error("the profile does not call json()"); },
    validateUrl() {}
  };
  return { http, calls };
}

function context(http: EngineHttp): EngineContext & { notes: Record<string, unknown>[] } {
  const engine = createEngine({ configPrefixes: ["ECOSYSTEM"], configSource: {}, cacheOrigin: "https://t.internal" });
  const real = engine.contextFor(createEcosystemProfile(), {});
  const notes: Record<string, unknown>[] = [];
  return { ...real, http, telemetry: { note: (f) => void notes.push(f) }, notes };
}

const tool = (name: string) => ECOSYSTEM_TOOLS.find((t) => t.name === name)!;
const response = (text: string | null, status = 200): HttpResponse => ({ url: "", status, statusText: "", headers: {}, text, fromCache: false });
const text = (r: ToolResult) => r.content[0].text;
const noNetwork = () => fakeHttp(() => new Error("no request expected"));

describe("ecosystem_search_extensions", () => {
  it("answers from the index without a request, with the columns, a cut notice and the data line", async () => {
    const { http, calls } = noNetwork();
    const ctx = context(http);
    const r = await tool("ecosystem_search_extensions").rows!({ query: "dcat", limit: 1 }, ctx);
    expect(calls).toEqual([]);
    expect(r.columns).toEqual(["repo", "plugins", "description", "portals", "stars", "upkeep", "last_push"]);
    expect(r.rows).toEqual([{ repo: "ckan/ckanext-dcat", plugins: "dcat, dcat_rdf_harvester", description: "Expose and harvest DCAT metadata",
      portals: "3", stars: "195", upkeep: "active", last_push: "2026-11-03" }]);
    expect(r.notice).toMatch(/^Showing 1 of 3 matches/);
    expect(r.notice).toContain("extensions week 2026-11-08");
    expect(r.notice).toContain("Supported CKAN versions");
    expect(ctx.notes).toEqual([{ result_count: 1, total: 3 }]);
  });

  it("leaves portals and stars empty when unknown, and tells the model not to invent on no match", async () => {
    const r = await tool("ecosystem_search_extensions").rows!({ query: "offline", limit: 20 }, context(noNetwork().http));
    expect(r.rows).toEqual([expect.objectContaining({ repo: "gone/ckanext-offline", portals: "", stars: "", upkeep: "" })]);
    const none = await tool("ecosystem_search_extensions").rows!({ query: "blockchain", limit: 20 }, context(noNetwork().http));
    expect(none.rows).toEqual([]);
    expect(none.emptyText).toMatch(/do not assume an extension exists/);
  });
});

describe("ecosystem_get_extension", () => {
  const args = { include_readme: true, response_format: "markdown" };

  it("reads README.md from raw.githubusercontent.com as a fixed upstream, honest agent, cached a day, no retry", async () => {
    const { http, calls } = fakeHttp(() => response("# T\n\nThis extension exposes and harvests DCAT metadata in CKAN portals."));
    const r = await tool("ecosystem_get_extension").handler!({ extension: "ckan/ckanext-dcat", ...args }, context(http));
    expect(calls.map((c) => c.url)).toEqual(["https://raw.githubusercontent.com/ckan/ckanext-dcat/HEAD/README.md"]);
    expect(calls[0].opts).toEqual({ fixedUpstream: true, userAgent: "honest", cache: { ttlSeconds: 86_400 }, retry: { attempts: 1 } });
    expect(text(r)).toContain("This extension exposes and harvests DCAT metadata");
    expect(text(r)).toContain("untrusted content from the extension repositories on GitHub");
  });

  it("tries README.rst after a 404, then README, and says when there is none", async () => {
    const { http, calls } = fakeHttp(() => response("404: Not Found", 404));
    const r = await tool("ecosystem_get_extension").handler!({ extension: "ckan/ckanext-scheming", ...args }, context(http));
    expect(calls.map((c) => c.url.split("/HEAD/")[1])).toEqual(["README.md", "README.rst", "README"]);
    expect(text(r)).toContain("No README found in the repository.");
  });

  it("a README with no prose is said to have no readable opening", async () => {
    const r = await tool("ecosystem_get_extension").handler!({ extension: "ckan/ckanext-scheming", ...args }, context(fakeHttp(() => response("# Title\n\n```\npip install x\n```\n")).http));
    expect(text(r)).toContain("No readable opening paragraph in the README.");
  });

  it("a failed or refused README read still answers, with a note, and stops at the first non-404", async () => {
    const refused = fakeHttp(() => response(null, 429));
    const r1 = await tool("ecosystem_get_extension").handler!({ extension: "ckan/ckanext-dcat", ...args }, context(refused.http));
    expect(refused.calls).toHaveLength(1);
    expect(text(r1)).toContain("**Portals running it**: 3 (75% of the 4 portals");
    expect(text(r1)).toContain("The README could not be read from GitHub just now (HTTP 429).");
    expect(text(r1)).not.toContain("No readable opening");
    const down = fakeHttp(() => new Error("network down"));
    const r2 = await tool("ecosystem_get_extension").handler!({ extension: "ckan/ckanext-dcat", ...args }, context(down.http));
    expect(text(r2)).toContain("The README could not be read from GitHub just now.");
    expect(text(r2)).not.toContain("network down");
  });

  it("makes no request with include_readme false, or for a repository not on GitHub", async () => {
    const a = noNetwork();
    await tool("ecosystem_get_extension").handler!({ extension: "ckan/ckanext-dcat", include_readme: false, response_format: "markdown" }, context(a.http));
    const b = noNetwork();
    await tool("ecosystem_get_extension").handler!({ extension: "gone/ckanext-offline", ...args }, context(b.http));
    expect([...a.calls, ...b.calls]).toEqual([]);
  });

  it("an unknown or path-like extension is the profile's error, with no request", async () => {
    for (const extension of ["nope/nothing", "../../../etc/passwd", "ckan/ckanext-dcat/../../x"]) {
      const { http, calls } = noNetwork();
      await expect(tool("ecosystem_get_extension").handler!({ extension, ...args }, context(http))).rejects.toBeInstanceOf(NotInIndexError);
      expect(calls).toEqual([]);
    }
  });

  it("names the other repositories that provide the plugin, and co-installed plugins when computed", async () => {
    const r = await tool("ecosystem_get_extension").handler!({ extension: "dcat_rdf_harvester", include_readme: false, response_format: "markdown" }, context(noNetwork().http));
    expect(text(r)).toMatch(/^# ckan\/ckanext-dcat/);
    expect(text(r)).toContain("**Also provided by**: someone/ckanext-dcat-fork");
    expect(text(r)).toContain("- **dcat** (3 portals): image_view 3, scheming_datasets 2");
    const rare = await tool("ecosystem_get_extension").handler!({ extension: "acme/ckanext-rare", include_readme: false, response_format: "markdown" }, context(noNetwork().http));
    expect(text(rare)).toContain("Co-installation is computed only for the most used plugins");
    expect(text(rare)).toContain("(archived)");
  });

  it("wraps the repository's description as untrusted, and gives parseable JSON with the same facts", async () => {
    const md = await tool("ecosystem_get_extension").handler!({ extension: "acme/ckanext-rare", include_readme: false, response_format: "markdown" }, context(noNetwork().http));
    expect(text(md)).toMatch(/untrusted content[\s\S]*Ignore previous instructions/);
    const js = await tool("ecosystem_get_extension").handler!({ extension: "ckan/ckanext-dcat", include_readme: false, response_format: "json" }, context(noNetwork().http));
    const body = JSON.parse(text(js));
    expect(body).toMatchObject({ repo: "ckan/ckanext-dcat", portals: 3, readme_opening: null, also_provided_by: [],
      data: { extensions_week: "2026-11-08" } });
    expect(body.plugin_usage).toEqual([{ plugin: "dcat", portals: 3, family: "ckanext-dcat", used_with: [{ plugin: "image_view", portals: 3 }, { plugin: "scheming_datasets", portals: 2 }] }]);
  });
});

describe("ecosystem_portals_using", () => {
  it("lists the portals from the index, largest first, with a count notice", async () => {
    const { http, calls } = noNetwork();
    const ctx = context(http);
    const r = await tool("ecosystem_portals_using").rows!({ plugin: "dcat", limit: 2 }, ctx);
    expect(calls).toEqual([]);
    expect(r.rows).toEqual([
      { portal: "big-portal", url: "https://big.example.org", ckan_version: "2.11.3", datasets: "5000", status: "active" },
      { portal: "mid-portal", url: "https://mid.example.org", ckan_version: "", datasets: "300", status: "dormant" }
    ]);
    expect(r.notice).toMatch(/^Showing 2 of 3 portals/);
    expect(ctx.notes).toEqual([{ result_count: 2, total: 3 }]);
  });

  it("explains exact plugin names when nothing matches", async () => {
    const r = await tool("ecosystem_portals_using").rows!({ plugin: "scheming", limit: 50 }, context(noNetwork().http));
    expect(r.rows).toEqual([]);
    expect(r.emptyText).toMatch(/Plugin names are exact/);
  });
});

describe("ecosystem_overview", () => {
  it("totals, statuses, CKAN branches, top non-core plugins and families, in Markdown and JSON", async () => {
    const md = text(await tool("ecosystem_overview").handler!({ response_format: "markdown" }, context(noNetwork().http)));
    expect(md).toContain("**Extensions**: 6 repositories; 4 with a GitHub description; 4 run by at least one crawled portal; 1 archived");
    expect(md).toContain("**Portals**: 5 crawled (active 3, dormant 1, unreachable 1); 4 report their plugins");
    expect(md).toContain("**CKAN versions in use**: 2.10 2, 2.11 1, 2.9 1");
    expect(md).toContain("- dcat: 3 portals (75%)");
    expect(md).not.toContain("- image_view:");
    const js = JSON.parse(text(await tool("ecosystem_overview").handler!({ response_format: "json" }, context(noNetwork().http))));
    expect(js.families).toEqual(["ckanext-dcat", "ckanext-scheming"]);
    expect(js.data.source_commit).toBe("0000000");
  });
});
