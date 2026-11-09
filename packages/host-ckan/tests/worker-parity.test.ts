/**
 * The CKAN Worker against ondata's (src/worker.ts at 09e8cdc, loaded from the reference clone):
 * the same requests must give the same status, headers and body, and a tool call the same log
 * line and Analytics Engine data point (apart from its duration). Calls here need no network.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { ONDATA_REPO, ondataAvailable } from "../../profile-ckan/tests/parity/ondata.js";
import { SERVER_VERSION } from "../src/server.js";

/**
 * D13: the deployment reports its own version where ondata reports 0.4.138 (`/health`, and the
 * serverInfo of `initialize`). Ours must carry exactly our version there; the rest must be equal.
 */
function ourVersionAsTheirs(body: string, theirs: string): string {
  const v = theirs.match(/"version":\s*"([^"]+)"/)?.[1];
  if (!v) return body;
  expect(body).toContain(`"version":"${SERVER_VERSION}"`);
  return body.replace(`"version":"${SERVER_VERSION}"`, `"version":"${v}"`);
}

type Fetcher = { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };

async function load(): Promise<{ theirs: Fetcher; ours: Fetcher }> {
  vi.resetModules();
  const theirs = (await import(`${ONDATA_REPO}/src/worker.ts`)).default as Fetcher;
  const ours = (await import("../src/worker.js")).default as Fetcher;
  return { theirs, ours };
}

async function observe(res: Response) {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { if (k !== "date") headers[k] = v; });
  return { status: res.status, headers, body: await res.text() };
}

const rpc = (body: unknown) => new Request("https://ckan.example/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify(body)
});

/** ondata's fetch path hides process.versions.node; without it ondata would take its axios path. */
async function onFetchPath<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.versions, "node")!;
  Object.defineProperty(process.versions, "node", { value: undefined, configurable: true });
  try { return await fn(); } finally { Object.defineProperty(process.versions, "node", original); }
}

afterEach(() => vi.restoreAllMocks());

describe.runIf(ondataAvailable())("CKAN Worker = ondata's Worker", () => {
  const requests: [string, () => Request][] = [
    ["GET /", () => new Request("https://ckan.example/")],
    ["GET /health", () => new Request("https://ckan.example/health")],
    ["GET /mcp (405)", () => new Request("https://ckan.example/mcp")],
    ["OPTIONS /mcp", () => new Request("https://ckan.example/mcp", { method: "OPTIONS" })],
    ["GET /other (404)", () => new Request("https://ckan.example/other")],
    ["POST /mcp initialize", () => rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })],
    ["POST /mcp not JSON-RPC", () => new Request("https://ckan.example/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{" })]
  ];
  for (const [label, make] of requests) {
    it(label, async () => {
      const { theirs, ours } = await load();
      const a = await observe(await onFetchPath(() => theirs.fetch(make(), {})));
      const b = await observe(await ours.fetch(make(), {}));
      if (label === "GET /health" || label === "POST /mcp initialize") b.body = ourVersionAsTheirs(b.body, a.body);
      expect(b).toEqual(a);
    });
  }

  // A private host is refused before any request, so these calls need no network but still go
  // through the tool, the log line (with capped `sql`, objects as JSON) and the error summary.
  const calls: [string, Record<string, unknown>][] = [
    ["ckan_datastore_search", { server_url: "http://127.0.0.1", resource_id: "r1", q: "x", filters: { a: 1 }, fields: ["a", "b"], sort: "a desc", limit: 5, offset: 10, distinct: true }],
    ["ckan_datastore_search_sql", { server_url: "http://127.0.0.1", sql: `SELECT ${"s".repeat(300)} FROM "r1"` }],
    ["ckan_package_search", { server_url: "http://127.0.0.1", q: "aria", fq: "res_format:CSV", rows: 3, page: 2, page_size: 3 }],
    ["sparql_query", { endpoint_url: "http://lod.example/sparql", query: "SELECT ?s WHERE { ?s ?p ?o }" }]
  ];
  for (const [tool, args] of calls) it(`tools/call ${tool}: same answer, log line and data point (duration aside)`, async () => {
    const { theirs, ours } = await load();
    const call = () => rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
    const run = async (w: Fetcher, wrap: (f: () => Promise<Response>) => Promise<Response>) => {
      const logs: unknown[] = [];
      const points: unknown[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { logs.push(JSON.parse(String(line))); });
      const res = await wrap(() => w.fetch(call(), { ANALYTICS: { writeDataPoint: (p: unknown) => points.push(p) } }));
      spy.mockRestore();
      const strip = (o: any) => { delete o.duration_ms; return o; };
      const stripPoint = (p: any) => ({ ...p, doubles: [0, p.doubles[1]] });
      return { res: await observe(res), logs: logs.map(strip), points: points.map(stripPoint) };
    };
    const a = await run(theirs, onFetchPath);
    const b = await run(ours, (f) => f());
    expect(a.logs).toHaveLength(1);
    expect(b).toEqual(a);
  });
});
