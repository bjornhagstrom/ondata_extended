/**
 * The parliament deployment without the reference copy: routes, the info document, health, the
 * one-engine-per-isolate rule (the Senato throttle spans requests) and the error that leaks
 * nothing (P12). worker-parity.test.ts compares the routes with the original's Worker. No request
 * leaves the process: `fetch` is stubbed and DNS answers with a stand-in public address.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { __setDnsResolverForTests } from "@ondata-extended/core";
import worker, { infoDocument } from "../src/worker.js";
import { CONFIG_PREFIXES, profile, SERVER_NAME, SERVER_VERSION } from "../src/server.js";

const BASE = "https://p.example";
const rpc = (body: unknown) => new Request(`${BASE}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify(body)
});
/** The JSON-RPC message of an SSE answer. */
async function message(res: Response): Promise<any> {
  const data = (await res.text()).split("\n").filter((l) => l.startsWith("data: "));
  expect(data).toHaveLength(1);
  return JSON.parse(data[0].slice(6));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __setDnsResolverForTests(null);
});

describe("parliament Worker routes", () => {
  it("names the server as the original does, with our version and the PARLIAMENT prefix", () => {
    expect(SERVER_NAME).toBe("italianparliament-mcp");
    expect(SERVER_VERSION).toBe("0.1.0");
    expect(CONFIG_PREFIXES).toEqual(["PARLIAMENT"]);
  });

  it("GET / is the original's info document with our version and tool count", async () => {
    const res = await worker.fetch(new Request(`${BASE}/`), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const doc = await res.json();
    expect(doc).toEqual({
      name: "italianparliament-mcp",
      version: SERVER_VERSION,
      description: "MCP server for querying Italian Parliament SPARQL endpoints (Camera + Senato)",
      mcp_endpoint: "/mcp",
      tools: 6
    });
    expect(Object.keys(doc)).toEqual(Object.keys(infoDocument()));
    expect(profile.tools).toHaveLength(6);
  });

  it("GET /health is the original's body", async () => {
    const res = await worker.fetch(new Request(`${BASE}/health`), {});
    expect(await res.text()).toBe('{"status":"ok","runtime":"cloudflare-workers"}');
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("OPTIONS /mcp is the original's preflight: 200, POST and Content-Type only", async () => {
    const res = await worker.fetch(new Request(`${BASE}/mcp`, { method: "OPTIONS" }), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type");
    expect(await res.text()).toBe("");
  });

  it("anything else, GET /mcp included, is a bare 404", async () => {
    for (const req of [new Request(`${BASE}/mcp`), new Request(`${BASE}/x`), new Request(`${BASE}/health`, { method: "POST" })]) {
      const res = await worker.fetch(req, {});
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not Found");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("POST /mcp answers as an SSE stream, with CORS, listing the six tools", async () => {
    const res = await worker.fetch(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {});
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const names = (await message(res)).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["deputies", "search", "legislatures", "bill-progress", "camera-amendments", "sparql"]);
  });

  it("writes no log line for a tool call (the original writes none)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await worker.fetch(rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "sparql", arguments: { query: "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }" } } }), {});
    expect((await message(res)).result.isError).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("one engine per isolate", () => {
  it("spaces Senato requests >= 2 s apart across separate /mcp requests", async () => {
    vi.resetModules();
    const { default: fresh } = await import("../src/worker.js");
    (await import("@ondata-extended/core")).__setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    const starts: number[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      expect(new URL(String(input)).hostname).toBe("dati.senato.it");
      starts.push(Date.now());
      return new Response(JSON.stringify({ head: { vars: ["n"] }, results: { bindings: [{ n: { type: "literal", value: "1" } }] } }), {
        headers: { "content-type": "application/sparql-results+json" }
      });
    });
    const call = (id: number) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "sparql", arguments: { query: "SELECT ?n WHERE { ?s ?p ?n }", endpoint: "senato", limit: 1 } } });
    for (const id of [1, 2]) {
      const m = await message(await fresh.fetch(call(id), {}));
      expect(m.result.isError).toBeUndefined();
    }
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1950);
  }, 15000);
});

describe("P12: an exception while serving /mcp", () => {
  it("answers the core's generic error, not the exception's message", async () => {
    vi.resetModules();
    vi.doMock("../src/server.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/server.js")>()),
      buildServer: () => { throw new Error("secret detail 10.0.0.1"); }
    }));
    try {
      const { default: broken } = await import("../src/worker.js");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await broken.fetch(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {});
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      expect(body).not.toContain("secret");
    } finally {
      vi.doUnmock("../src/server.js");
    }
  });
});

describe("wrangler.toml", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  it("names the test Worker, sends no wrangler metrics, has no analytics binding", () => {
    expect(toml).toMatch(/^name = "ondata-extended-parliament"$/m);
    expect(toml).toMatch(/^main = "dist\/worker\.js"$/m);
    expect(toml).toMatch(/^send_metrics = false$/m);
    expect(toml).toMatch(/^\[observability\]\nenabled = true$/m);
    expect(toml).not.toContain("analytics_engine_datasets");
  });
});
