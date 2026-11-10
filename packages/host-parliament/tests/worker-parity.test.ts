/**
 * The parliament Worker against the original's (ondata/italianparliament-mcp src/worker.ts at
 * fd46810, loaded in-process from the reference copy): the same requests must give the same status,
 * headers and body. Every difference allowed here is a numbered deviation (docs/parliament-port.md,
 * "Round 4: host") and is checked to be exactly that. No request leaves the process: tool calls are
 * refused before the network, or answered from a parity recording (dati.camera.it, recorded
 * 2026-11-10) with `fetch` stubbed; any request not in the recording fails the test.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { PARLIAMENT_REPO, originalAvailable } from "../../profile-parliament/tests/parity/original.js";
import { replayingFetch, unusedExchanges } from "../../profile-parliament/tests/parity/replay.js";
import { recordedExchanges } from "../../profile-parliament/tests/helpers.js";
import { SERVER_VERSION } from "../src/server.js";

const THEIR_VERSION = "0.38.0";
const OURS = ["deputies", "search", "legislatures", "bill-progress", "camera-amendments", "sparql"];

type Fetcher = { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };

async function load(): Promise<{ theirs: Fetcher; ours: Fetcher }> {
  vi.resetModules();
  const theirs = (await import(`${PARLIAMENT_REPO}/src/worker.ts`)).default as Fetcher;
  const ours = (await import("../src/worker.js")).default as Fetcher;
  // The same core instance as the Worker's (after the reset): stand-in DNS, since the recording
  // stands in for the network.
  (await import("@ondata-extended/core")).__setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
  return { theirs, ours };
}

interface Observation { status: number; headers: Record<string, string>; body: string }

async function observe(res: Response): Promise<Observation> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { if (k !== "date") headers[k] = v; });
  return { status: res.status, headers, body: await res.text() };
}

const URL_BASE = "https://parliament.example";
const rpc = (body: unknown) => new Request(`${URL_BASE}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify(body)
});
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

/** The JSON-RPC message of an SSE answer (one `data:` line), or the body itself when it is JSON. */
function message(body: string): any {
  const data = body.split("\n").filter((l) => l.startsWith("data: "));
  if (data.length === 0) return JSON.parse(body);
  expect(data).toHaveLength(1);
  return JSON.parse(data[0].slice(6));
}

/**
 * P9 (as D13 for CKAN): our version where the original says 0.38.0 (the info document at `/` and
 * the serverInfo of `initialize`). Ours must carry exactly our version there; the rest must be equal.
 */
function ourVersionAsTheirs(body: string): string {
  expect(body).toContain(`"version":"${SERVER_VERSION}"`);
  return body.replace(`"version":"${SERVER_VERSION}"`, `"version":"${THEIR_VERSION}"`);
}

/**
 * P11: the SSE headers of SDK 1.32.2 (here) where the original's 1.27.1 sends `Cache-Control:
 * no-cache` only. Ours must carry exactly these two; mapped back, the rest must be equal.
 */
function sdkSseHeadersAsTheirs(o: Observation): Observation {
  if (o.headers["content-type"] !== "text/event-stream") return o;
  expect(o.headers["cache-control"]).toBe("no-cache, no-transform");
  expect(o.headers["x-accel-buffering"]).toBe("no");
  const { "x-accel-buffering": _, ...headers } = o.headers;
  return { ...o, headers: { ...headers, "cache-control": "no-cache" } };
}

/** Our Worker's answer, with P11 mapped back to the original's headers. */
async function observeOurs(res: Response): Promise<Observation> {
  return sdkSseHeadersAsTheirs(await observe(res));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.runIf(originalAvailable())("parliament Worker = the original's Worker", () => {
  const same: [string, () => Request, ((ours: Observation) => Observation)?][] = [
    ["GET /health", () => new Request(`${URL_BASE}/health`)],
    ["GET /mcp (the original's 404)", () => new Request(`${URL_BASE}/mcp`)],
    ["OPTIONS /mcp", () => new Request(`${URL_BASE}/mcp`, { method: "OPTIONS" })],
    ["DELETE /mcp (404)", () => new Request(`${URL_BASE}/mcp`, { method: "DELETE" })],
    ["OPTIONS / (404)", () => new Request(`${URL_BASE}/`, { method: "OPTIONS" })],
    ["GET /other (404)", () => new Request(`${URL_BASE}/other`)],
    ["POST / (404)", () => new Request(`${URL_BASE}/`, { method: "POST", body: "{}" })],
    ["POST /mcp initialize", () => rpc(initialize), (o) => ({ ...o, body: ourVersionAsTheirs(o.body) })],
    ["POST /mcp not JSON", () => new Request(`${URL_BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{" })],
    ["POST /mcp without the SSE Accept", () => new Request(`${URL_BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(initialize) })],
    ["POST /mcp notification (202)", () => rpc({ jsonrpc: "2.0", method: "notifications/initialized" })],
    ["POST /mcp unknown method", () => rpc({ jsonrpc: "2.0", id: 3, method: "no/such" })]
  ];
  for (const [label, make, adjust] of same) {
    it(label, async () => {
      const { theirs, ours } = await load();
      const a = await observe(await theirs.fetch(make(), {}));
      let b = await observeOurs(await ours.fetch(make(), {}));
      if (adjust) b = adjust(b);
      expect(b).toEqual(a);
    });
  }

  it("GET /: the original's document with our version (P9) and the number of tools served (P10)", async () => {
    const { theirs, ours } = await load();
    const a = await observe(await theirs.fetch(new Request(`${URL_BASE}/`), {}));
    const b = await observe(await ours.fetch(new Request(`${URL_BASE}/`), {}));
    expect(JSON.parse(a.body)).toMatchObject({ version: THEIR_VERSION, tools: 43 });
    expect(JSON.parse(b.body)).toMatchObject({ version: SERVER_VERSION, tools: OURS.length });
    const theirsBody = { ...JSON.parse(a.body), version: SERVER_VERSION, tools: OURS.length };
    // Same key order and bytes once the two values are ours.
    expect(b).toEqual({ ...a, body: JSON.stringify(theirsBody) });
  });

  it("tools/list: our six tools as the original lists them, in its order; the other 37 not served (P10)", async () => {
    const { theirs, ours } = await load();
    const a = await observe(await theirs.fetch(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), {}));
    const b = await observeOurs(await ours.fetch(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), {}));
    expect({ status: b.status, headers: b.headers }).toEqual({ status: a.status, headers: a.headers });
    const theirTools = message(a.body).result.tools as { name: string }[];
    const ourTools = message(b.body).result.tools as { name: string }[];
    expect(theirTools).toHaveLength(43);
    expect(ourTools.map((t) => t.name)).toEqual(theirTools.map((t) => t.name).filter((n) => OURS.includes(n)));
    expect(ourTools).toEqual(theirTools.filter((t) => OURS.includes(t.name)));
    // Everything around the list is the same.
    const strip = (m: any) => ({ ...m, result: { ...m.result, tools: [] } });
    expect(strip(message(b.body))).toEqual(strip(message(a.body)));
  });

  // Refused by the tool before any request: the stubbed fetch would record a miss.
  const offline: [string, Record<string, unknown>][] = [
    ["sparql", { query: "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }", endpoint: "camera", limit: 10 }],
    ["sparql", { query: "SELECT ?s WHERE { ?s ?p ?o } ; DROP GRAPH <http://x/g>", endpoint: "senato" }],
    ["bill-progress", { uri: "https://example.com/ddl/123", limit: 3, offset: 0 }],
    ["camera-amendments", { billUri: "http://dati.camera.it/ocd/attocamera.rdf/ac19_" }],
    ["bill-progress", { uri: "https://dati.camera.it.example.org/ocd/attocamera.rdf/ac19_302", limit: 3, offset: 0 }],
    ["no-such-tool", {}]
  ];
  for (const [tool, args] of offline) {
    it(`tools/call ${tool} ${JSON.stringify(args).slice(0, 60)}: same answer, no request`, async () => {
      const { theirs, ours } = await load();
      const misses: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = replayingFetch([], misses);
      try {
        const call = () => rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: tool, arguments: args } });
        const a = await observe(await theirs.fetch(call(), {}));
        const b = await observeOurs(await ours.fetch(call(), {}));
        expect(b).toEqual(a);
        expect(message(a.body).result?.isError ?? message(a.body).error).toBeTruthy();
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(misses).toEqual([]);
    });
  }

  it("tools/call legislatures answered from the parity recording: same answer, same requests", async () => {
    const { theirs, ours } = await load();
    const exchanges = recordedExchanges("legislatures");
    const run = async (w: Fetcher, see: (r: Response) => Promise<Observation>) => {
      const misses: string[] = [];
      const keys: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = replayingFetch(exchanges, misses, keys);
      try {
        const res = await see(await w.fetch(rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "legislatures", arguments: {} } }), {}));
        return { res, misses: [...misses, ...unusedExchanges(exchanges, keys)] };
      } finally {
        globalThis.fetch = realFetch;
      }
    };
    const a = await run(theirs, observe);
    const b = await run(ours, observeOurs);
    expect(a.misses).toEqual([]);
    expect(b.misses).toEqual([]);
    expect(message(a.res.body).result.isError).toBeUndefined();
    expect(message(a.res.body).result.content[0].text).toContain("legislatura");
    expect(b.res).toEqual(a.res);
  });
});
