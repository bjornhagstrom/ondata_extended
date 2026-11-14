/**
 * The CKAN ecosystem deployment: Worker routes and the telemetry it logs.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/worker.js";
import { profile, SERVER_NAME } from "../src/server.js";

afterEach(() => vi.restoreAllMocks());

const mcp = (body: unknown) => new Request("https://e.example/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify(body)
});

describe("worker routes", () => {
  it("/health reports the profile's tool count", async () => {
    const res = await worker.fetch(new Request("https://e.example/health"), {});
    expect(await res.json()).toMatchObject({ status: "ok", name: SERVER_NAME, tools: 4, runtime: "cloudflare-workers" });
    expect(profile.tools).toHaveLength(4);
  });

  it("GET / is 404 (no landing page in the proof of concept)", async () => {
    expect((await worker.fetch(new Request("https://e.example/"), {})).status).toBe(404);
  });

  it("/mcp lists the four ecosystem_ tools", async () => {
    const res = await worker.fetch(mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), {});
    const body = await res.json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual(["ecosystem_get_extension", "ecosystem_overview", "ecosystem_portals_using", "ecosystem_search_extensions"]);
  });

  it("logs a completed search with its arguments, answered without a request", async () => {
    vi.resetModules();
    const fresh = (await import("../src/worker.js")).default;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const res = await fresh.fetch(mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ecosystem_search_extensions", arguments: { query: "harvest dcat", limit: 3 } } }), {});
      expect(JSON.stringify(await res.json())).toContain("ckan/ckanext-dcat");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled(); // search answers from the bundled index
    const lines = log.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(lines).toContain("ecosystem_search_extensions");
    expect(lines).toContain('"query":"harvest dcat"');
    expect(lines).toContain('"limit":3');
  });
});
