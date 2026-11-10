/**
 * The example deployment: Worker routes and the telemetry it logs.
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
    expect(await res.json()).toMatchObject({ status: "ok", name: SERVER_NAME, tools: profile.tools.length });
  });

  it("GET / is 404 (no landing page)", async () => {
    expect((await worker.fetch(new Request("https://e.example/"), {})).status).toBe(404);
  });

  it("/mcp lists the two akn_ tools", async () => {
    const res = await worker.fetch(mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), {});
    const body = await res.json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual(["akn_document", "akn_list_files"]);
  });

  it("logs the allowed arguments of a completed call, and no token", async () => {
    // A fresh module: the Worker keeps one engine per isolate, built from the first /mcp request's env.
    vi.resetModules();
    const fresh = (await import("../src/worker.js")).default;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const seen: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response('[{"name":"emend","type":"dir"}]', { status: 200, headers: { "content-type": "application/json" } });
    }));
    try {
      const res = await fresh.fetch(mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "akn_list_files", arguments: { legislature: 19, ddl: 60233, kind: "emend" } } }), { AKN_GITHUB_TOKEN: "ghp_secretvalue" });
      expect(JSON.stringify(await res.json())).toContain("emend");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen).toEqual(["Bearer ghp_secretvalue"]); // the token reached the engine and the request
    const lines = log.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(lines).toContain("akn_list_files");
    expect(lines).toContain('"kind":"emend"');
    expect(lines).toContain('"ddl":60233');
    expect(lines).not.toContain("ghp_secretvalue");
  });
});
