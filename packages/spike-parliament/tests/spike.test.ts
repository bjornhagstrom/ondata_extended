/**
 * The parliament spike through a real MCP client. Camera answers were recorded from
 * dati.camera.it on 2026-11-09 (tests/fixtures/camera-recorded.json, three queries); Senato
 * answers are synthetic, because Senato blocks an IP after a burst of queries and the block
 * does not decay (original src/core/client.ts). Only `fetch` and DNS are stubbed: the core's
 * guards, host policies and output shaping run for real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { __setDnsResolverForTests, createEngine, createMcpServer, registerProfiles } from "@ondata-extended/core";
import { createSkosProfile } from "@ondata-extended/profile-skos";
import { createParliamentSpikeProfile } from "../src/index.js";

const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "camera-recorded.json"), "utf8")) as {
  answers: { name: string; query: string; status: number; body: string }[];
};
const answer = (name: string) => recorded.answers.find((a) => a.name === name)!;

type Handler = (url: URL) => Response | Promise<Response>;
let handler: Handler;
let calls: { host: string; query: string; at: number }[] = [];
const sparqlJson = (vars: string[], rows: Record<string, string>[]) => new Response(JSON.stringify({
  head: { vars },
  results: { bindings: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { type: "literal", value: v }]))) }
}), { status: 200, headers: { "content-type": "application/sparql-results+json" } });
const byRecordedQuery: Handler = (url) => {
  const hit = recorded.answers.find((a) => a.query === url.searchParams.get("query"));
  return hit ? new Response(hit.body, { status: hit.status, headers: { "content-type": "application/sparql-results+json" } }) : new Response("no fixture", { status: 599 });
};

beforeEach(() => {
  calls = [];
  handler = byRecordedQuery;
  __setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    calls.push({ host: url.hostname, query: url.searchParams.get("query") ?? "", at: Date.now() });
    return handler(url);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setDnsResolverForTests(null);
});

async function client(withSkos = false) {
  const engine = createEngine({ configPrefixes: ["SPIKE"], configSource: {}, cacheOrigin: "https://t.internal" });
  const server = createMcpServer({ name: "t", version: "0" });
  registerProfiles(server, withSkos ? [createParliamentSpikeProfile(), createSkosProfile()] : [createParliamentSpikeProfile()], engine);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = await c.callTool({ name, arguments: args });
  return { text: (r.content as { text: string }[])[0].text, isError: r.isError === true, structured: r.structuredContent as Record<string, unknown> | undefined };
};

describe("contract: unprefixed names and examples", () => {
  it("registers the original names without a prefix, next to a prefixed profile", async () => {
    const tools = (await (await client(true)).listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["legislatures", "deputies", "search", "sparql", "vocab_get_concept"]));
    expect(tools.find((t) => t.name === "search")!.description).toContain('Examples:\n  italianparliament search find --name "rossi"');
  });
});

describe("tools on recorded Camera answers", () => {
  it("legislatures: every legislature as a JSONL row, oldest first", async () => {
    const r = await call(await client(), "legislatures", {});
    const rows = r.text.split("\n").map((l) => JSON.parse(l));
    expect(rows.length).toBeGreaterThan(30);
    expect(rows[0]).toMatchObject({ uri: "http://dati.camera.it/ocd/legislatura.rdf/regno_01" });
    expect(r.structured).toMatchObject({ truncated: false, columns: ["uri", "label", "title", "date"] });
  });

  it("deputies: rows that fill the limit get the truncation notice after them", async () => {
    const r = await call(await client(), "deputies", { legislature: 19, gender: "female", limit: 3 });
    const lines = r.text.split("\n");
    expect(lines.slice(0, 3).every((l) => JSON.parse(l).gender === "female")).toBe(true);
    expect(lines[3]).toContain("troncato dal limite di 3 righe");
  });

  it("search on Camera finds Boschi in legislature 19", async () => {
    const r = await call(await client(), "search", { name: "boschi", chamber: "camera", legislature: 19, limit: 5 });
    expect(r.text).toContain('"label":"MARIA ELENA BOSCHI, XIX Legislatura della Repubblica"');
    expect(calls.every((c) => c.host === "dati.camera.it")).toBe(true);
  });

  it("an empty answer gives the anti-confabulation text, not an empty string", async () => {
    handler = () => sparqlJson(["s"], []);
    const r = await call(await client(), "legislatures", {});
    expect(r.text).toContain("NON dedurre né inventare il valore");
  });
});

describe("search over both chambers (review fix)", () => {
  it("is cut per chamber: 30 + 25 rows under limit 50 carry no truncation notice", async () => {
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ s: `${prefix}${i}`, label: `L${i}`, fn: "A", ln: `B${i}`, leg: "19" }));
    handler = (url) => url.hostname === "dati.senato.it"
      ? sparqlJson(["s", "fn", "ln", "leg"], many(25, "http://dati.senato.it/senatore/"))
      : sparqlJson(["s", "label"], many(30, "http://dati.camera.it/d/"));
    const r = await call(await client(), "search", { name: "b", chamber: "both", limit: 50 });
    expect(r.text.split("\n").filter((l) => l.startsWith("{"))).toHaveLength(55);
    expect(r.text).not.toContain("troncato");
  }, 10000);
});

describe("host policies from the profile", () => {
  it("Senato: the start of two requests is at least 2 s apart (one search over both chambers twice)", async () => {
    handler = (url) => url.hostname === "dati.senato.it"
      ? sparqlJson(["s", "fn", "ln", "leg"], [{ s: "http://dati.senato.it/senatore/1", fn: "MARIO", ln: "ROSSI", leg: "19" }])
      : sparqlJson(["s", "label"], []);
    const c = await client();
    await call(c, "search", { name: "rossi", chamber: "senato" });
    const r = await call(c, "search", { name: "rossi", chamber: "senato" });
    expect(r.text).toContain('"chamber":"senato"');
    const senato = calls.filter((x) => x.host === "dati.senato.it");
    expect(senato).toHaveLength(2);
    expect(senato[1].at - senato[0].at).toBeGreaterThanOrEqual(1950);
  }, 10000);

  it("Camera: a flapping endpoint (503, 503, 200) is retried and the call succeeds", async () => {
    let n = 0;
    handler = (url) => (++n <= 2 ? new Response("down", { status: 503 }) : byRecordedQuery(url));
    const r = await call(await client(), "legislatures", {});
    expect(r.isError).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it("Senato 403 is not retried, and the hint says not to repeat at once", async () => {
    handler = () => new Response("forbidden", { status: 403 });
    const r = await call(await client(), "sparql", { endpoint: "senato", query: "SELECT ?s WHERE { ?s ?p ?o }" });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect(r.text).toContain("HTTP 403");
    expect(r.text).toContain("Non ripetere subito");
  });
});

describe("sparql tool on the core's shared SPARQL module", () => {
  it("refuses an update hidden before a SELECT, without any request", async () => {
    const r = await call(await client(), "sparql", { endpoint: "camera", query: "INSERT DATA { <http://x/a> <http://x/b> 1 } ; SELECT ?s WHERE { ?s ?p ?o }" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Only SELECT queries are supported");
    expect(calls).toEqual([]);
  });

  it("injects the LIMIT and says the result was cut only when the limit was ours", async () => {
    handler = () => sparqlJson(["n"], [{ n: "1" }, { n: "2" }]);
    const c = await client();
    const injected = await call(c, "sparql", { endpoint: "camera", query: "SELECT ?n WHERE { ?s ?p ?n }", limit: 2 });
    expect(calls[0].query).toMatch(/\nLIMIT 2$/);
    expect(injected.text).toContain("troncato dal limite di 2 righe");
    const own = await call(c, "sparql", { endpoint: "camera", query: "SELECT ?n WHERE { ?s ?p ?n } LIMIT 2", limit: 2 });
    expect(own.text).not.toContain("troncato");
  });

  it("escapes user text interpolated into a query", async () => {
    handler = () => sparqlJson(["s"], []);
    await call(await client(), "search", { name: 'x") } DROP GRAPH <g> #', chamber: "camera" });
    expect(calls[0].query).toContain('LCASE("x\\")")');
    expect(calls[0].query).not.toMatch(/LCASE\("x"\)/);
  });
});

describe("CLI parity through runRowsTool", () => {
  it("applies schema defaults, drops unknown keys and resolves the empty text, like the MCP path", async () => {
    const { runRowsTool } = await import("@ondata-extended/core");
    handler = () => sparqlJson(["s"], []);
    const engine = createEngine({ configPrefixes: ["SPIKE"], configSource: {}, cacheOrigin: "https://t.internal" });
    const result = await runRowsTool(createParliamentSpikeProfile(), "deputies", { unknown: "x" }, engine);
    expect(calls[0].query).toMatch(/LIMIT 100\nOFFSET 0$/);
    expect(result.rows).toEqual([]);
    expect(result.emptyText).toContain("NON dedurre né inventare il valore");
  });

  it("the same tool definition gives a CLI the rows of the recorded answer", async () => {
    const { runRowsTool, formatTable } = await import("@ondata-extended/core");
    const engine = createEngine({ configPrefixes: ["SPIKE"], configSource: {}, cacheOrigin: "https://t.internal" });
    const result = await runRowsTool(createParliamentSpikeProfile(), "legislatures", {}, engine);
    expect(result.rows[0]).toMatchObject({ uri: "http://dati.camera.it/ocd/legislatura.rdf/regno_01" });
    const csv = formatTable(result.rows, { columns: result.columns, emptyText: "-", format: "csv" }, 1e6).text;
    expect(csv.split("\n")[0]).toBe("uri,label,title,date");
  });
});
