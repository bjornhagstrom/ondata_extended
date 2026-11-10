/**
 * The profile through a real MCP client, on the core. Moved from the contract spike
 * (packages/spike-parliament/tests/spike.test.ts, deleted in round 1) and adjusted where the spike
 * had departed from the original (each change is listed in docs/parliament-port.md, "Spike tests
 * moved"); plus tests of this port's own request layer (src/core/client.ts) and of the cached
 * current legislature.
 *
 * Camera answers are the parity recordings (dati.camera.it, 2026-11-10) or synthetic; Senato
 * answers are always synthetic (Senato blocks an IP after a burst and the block does not decay).
 * Only `fetch` and DNS are stubbed: the core's guards, host policies and the profile's handler run
 * for real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Profile } from "@ondata-extended/profile-contract";
import { __setDnsResolverForTests, createEngine, createMcpServer, registerProfiles } from "@ondata-extended/core";
import { createParliamentProfile } from "../src/index.js";
import { deputiesTool } from "../src/tools/deputies.js";
import { legislaturesTool } from "../src/tools/legislatures.js";
import { DEFAULT_EMPTY, formatResult } from "../src/server.js";
import { toCsv } from "../src/core/format.js";
import { __resetCurrentLegislatureForTests } from "../src/core/current-legislature.js";
import { recordedExchanges, testContext } from "./helpers.js";

type Handler = (url: URL) => Response | Promise<Response>;
let handler: Handler;
let calls: { host: string; query: string; at: number; headers: Headers }[] = [];

const sparqlJson = (vars: string[], rows: Record<string, string>[]) => new Response(JSON.stringify({
  head: { vars },
  results: { bindings: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { type: "literal", value: v }]))) }
}), { status: 200, headers: { "content-type": "application/sparql-results+json" } });

/** Answers from the parity recordings, by URL. */
const recorded = (...caseIds: string[]): Handler => {
  const all = caseIds.flatMap((id) => recordedExchanges(id));
  return (url) => {
    const hit = all.find((e) => e.key === `GET ${url.toString()}`);
    return hit ? new Response(hit.bodyText ?? "", { status: hit.status, headers: hit.headers }) : new Response("no fixture", { status: 599 });
  };
};

beforeEach(() => {
  calls = [];
  handler = recorded("legislatures");
  __resetCurrentLegislatureForTests();
  __setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    calls.push({ host: url.hostname, query: url.searchParams.get("query") ?? "", at: Date.now(), headers: new Headers(init?.headers) });
    return handler(url);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setDnsResolverForTests(null);
});

/** A prefixed profile next to ours (the spike used the SKOS profile; profiles do not import each other). */
const prefixedProfile: Profile = {
  id: "other", version: "0", toolPrefix: "other_", shrinkableKeys: [], telemetryFields: [], untrustedSourceLabel: "x", honestUserAgent: "x",
  tools: [{ name: "other_echo", description: "Echo", inputSchema: { q: z.string() }, handler: async (a, ctx) => ctx.output.text(String(a.q)) }]
};

async function client(withOther = false, configSource: Record<string, string> = {}) {
  const engine = createEngine({ configPrefixes: ["PARLIAMENT"], configSource: { VITEST: "true", ...configSource }, cacheOrigin: "https://t.internal" });
  const server = createMcpServer({ name: "t", version: "0" });
  registerProfiles(server, withOther ? [createParliamentProfile(), prefixedProfile] : [createParliamentProfile()], engine);
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
    expect(names).toEqual(expect.arrayContaining(["legislatures", "deputies", "search", "sparql", "other_echo"]));
    expect(tools.find((t) => t.name === "search")!.description).toContain('Examples:\n  italianparliament search find --name "rossi"');
  });
});

describe("tools on recorded Camera answers", () => {
  it("legislatures: every legislature as a JSONL row, oldest first, text only", async () => {
    const r = await call(await client(), "legislatures", {});
    const rows = r.text.split("\n").map((l) => JSON.parse(l));
    expect(rows.length).toBeGreaterThan(30);
    expect(rows[0]).toMatchObject({ uri: "http://dati.camera.it/ocd/legislatura.rdf/regno_01" });
    expect(Object.keys(rows[0])).toEqual(["uri", "label", "title", "date"]);
    // The original answers with text only; no structured channel.
    expect(r.structured).toBeUndefined();
  });

  it("deputies: rows that fill the limit get the truncation notice after them", async () => {
    handler = recorded("deputies-female-limit3");
    const r = await call(await client(), "deputies", { legislature: 19, gender: "female", limit: 3 });
    const lines = r.text.split("\n");
    expect(lines.slice(0, 3).every((l) => JSON.parse(l).gender === "female")).toBe(true);
    expect(lines[3]).toContain("troncato da un limite di 3 righe");
  });

  it("search on Camera finds Boschi in legislature 19", async () => {
    handler = recorded("search-boschi-leg19");
    const r = await call(await client(), "search", { name: "boschi", chamber: "camera", legislature: 19, limit: 5 });
    expect(r.text).toContain('"label":"Maria Elena Boschi"');
    expect(r.text).toContain('"legislature_uri":"http://dati.camera.it/ocd/legislatura.rdf/repubblica_19"');
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
      : sparqlJson(["s"], [{ s: "http://dati.camera.it/ocd/legislatura.rdf/repubblica_19" }]);
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
    const answer = recorded("legislatures");
    handler = (url) => (++n <= 2 ? new Response("down", { status: 503 }) : answer(url));
    const r = await call(await client(), "legislatures", {});
    expect(r.isError).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it("Senato 403 is not retried, and the error is the original's", async () => {
    handler = () => new Response("forbidden", { status: 403 });
    const r = await call(await client(), "sparql", { endpoint: "senato", query: "SELECT ?s WHERE { ?s ?p ?o }" });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect(r.text).toBe("Error: SPARQL error on https://dati.senato.it/sparql (HTTP 403): SPARQL request failed with status 403");
  });
});

describe("sparql tool", () => {
  it("refuses an update hidden before a SELECT, without any request", async () => {
    const r = await call(await client(), "sparql", { endpoint: "camera", query: "INSERT DATA { <http://x/a> <http://x/b> 1 } ; SELECT ?s WHERE { ?s ?p ?o }" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Solo query SELECT supportate");
    expect(calls).toEqual([]);
  });

  it("injects the LIMIT and says the result was cut only when the limit was ours", async () => {
    handler = () => sparqlJson(["n"], [{ n: "1" }, { n: "2" }]);
    const c = await client();
    const injected = await call(c, "sparql", { endpoint: "camera", query: "SELECT ?n WHERE { ?s ?p ?n }", limit: 2 });
    expect(calls[0].query).toMatch(/\nLIMIT 2$/);
    expect(injected.text).toContain("troncato da un limite di 2 righe");
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

describe("CLI path: the tool definitions serve a CLI as the original's Tool.execute does", () => {
  it("applies schema defaults, drops unknown keys and resolves the empty text, like the MCP path", async () => {
    handler = () => sparqlJson(["s"], []);
    const input = deputiesTool.inputSchema.parse({ unknown: "x" });
    const result = await deputiesTool.execute(input, testContext());
    expect(calls[0].query).toMatch(/LIMIT 100\nOFFSET 0$/);
    expect(result.rows).toEqual([]);
    expect(formatResult(result, deputiesTool.emptyHint)).toBe(DEFAULT_EMPTY);
    expect(DEFAULT_EMPTY).toContain("NON dedurre né inventare il valore");
  });

  it("the same tool definition gives a CLI the rows of the recorded answer", async () => {
    const result = await legislaturesTool.execute({}, testContext());
    expect(result.rows[0]).toMatchObject({ uri: "http://dati.camera.it/ocd/legislatura.rdf/regno_01" });
    expect(toCsv(result.rows, result.columns).split("\n")[0]).toBe("uri,label,title,date");
  });
});

describe("request layer (src/core/client.ts) on the core", () => {
  it("sends the original's request: GET, query then format, Accept application/json, its User-Agent", async () => {
    await call(await client(), "legislatures", {});
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get("accept")).toBe("application/json");
    expect(calls[0].headers.get("user-agent")).toBe("italianparliament-mcp/0.38.0");
  });

  it("retries an unparsable 2xx body, as the original does, and gives up after 5 attempts", async () => {
    handler = () => new Response("<html>maintenance</html>", { status: 200, headers: { "content-type": "text/html" } });
    const r = await call(await client(), "sparql", { endpoint: "camera", query: "SELECT ?s WHERE { ?s ?p ?o }" });
    expect(calls).toHaveLength(5);
    expect(r).toMatchObject({ isError: true, text: "Error: SPARQL error on https://dati.camera.it/sparql: SPARQL request failed after 5 attempts" });
  }, 15000);

  it("does not repeat an answer over the core's size cap (a guard, not a transient failure)", async () => {
    handler = () => sparqlJson(["n"], Array.from({ length: 200 }, (_, i) => ({ n: String(i) })));
    const r = await call(await client(false, { PARLIAMENT_MAX_RESPONSE_BYTES: "1000" }), "sparql", { endpoint: "camera", query: "SELECT ?n WHERE { ?s ?p ?n }" });
    expect(calls).toHaveLength(1);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Error: Response too large/);
  });

  it("does not repeat a redirect loop", async () => {
    handler = (url) => new Response(null, { status: 302, headers: { location: url.toString() } });
    const r = await call(await client(), "sparql", { endpoint: "camera", query: "SELECT ?s WHERE { ?s ?p ?o }" });
    expect(calls).toHaveLength(6); // the first request and five redirects, once
    expect(r.text).toBe("Error: Too many redirects (>5)");
  });
});

describe("current legislature for the search ranking", () => {
  it("is asked once per process and then cached", async () => {
    handler = (url) => (url.searchParams.get("query")!.includes('"repubblica_"')
      ? sparqlJson(["s"], [{ s: "http://dati.camera.it/ocd/legislatura.rdf/repubblica_19" }])
      : sparqlJson(["s", "label"], []));
    const c = await client();
    await call(c, "search", { name: "rossi", chamber: "camera" });
    await call(c, "search", { name: "bianchi", chamber: "camera" });
    expect(calls.filter((x) => x.query.includes('"repubblica_"'))).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });
});
