/**
 * Several services in one Worker (createServicesHandler): routing by path, public services listed and private ones
 * never, a private service only at its secret path, the same 404 for every miss, and setup errors at load time.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import type { Profile } from "@ondata-extended/profile-contract";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEngine, createMcpServer, createServicesHandler, registerProfiles, serverInstructions, validateServices, type WorkerService } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

type Env = Record<string, string | undefined>;
const SECRET = "Zq3_kd9-Lw2xP7vN4mT8rY1sB6cH0jFa"; // 32 characters

function profile(id: string): Profile {
  return {
    id, version: "0.0.1", toolPrefix: `${id}_`, shrinkableKeys: [], telemetryFields: ["q"], untrustedSourceLabel: id, honestUserAgent: "T/0",
    tools: [{ name: `${id}_echo`, description: "Echo", inputSchema: { q: z.string() }, handler: async (args, ctx) => ctx.output.text(`${id} ${args.q}`) }]
  };
}

function service(id: string, where: { path: string } | { secretPath: (env: Env) => string | undefined }): WorkerService<Env> {
  const engine = createEngine({ configPrefixes: [id.toUpperCase()], configSource: {}, cacheOrigin: `https://${id}.internal` });
  return {
    id, ...where,
    buildServer: () => { const s = createMcpServer({ name: id, version: "0" }); registerProfiles(s, [profile(id)], engine); return s; },
    health: () => ({ status: "ok", name: id }),
    logEntry: (tool, args) => ({ service: id, tool, q: args.q })
  };
}

const handler = () => createServicesHandler<Env>({
  services: [service("pub", { path: "pub" }), service("priv", { secretPath: (env) => env.PRIV_PATH })],
  health: () => ({ runtime: "test" }),
  landing: (_r, _e, pub) => new Response(`listed: ${pub.map((s) => s.id).join(",")}`)
});

const post = (path: string, body: unknown) => new Request(`https://w.example${path}`, {
  method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body)
});
const listTools = async (res: Response) => ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

describe("createServicesHandler", () => {
  it("serves each service at its own path with only its own tools", async () => {
    const h = handler();
    expect(await listTools(await h.fetch(post("/pub/mcp", LIST), { PRIV_PATH: SECRET }))).toEqual(["pub_echo"]);
    expect(await listTools(await h.fetch(post(`/${SECRET}/mcp`, LIST), { PRIV_PATH: SECRET }))).toEqual(["priv_echo"]);
  });

  it("lists public services on / and /health and never a private one", async () => {
    const h = handler();
    const env = { PRIV_PATH: SECRET };
    expect(await (await h.fetch(new Request("https://w.example/"), env)).text()).toBe("listed: pub");
    const health = await (await h.fetch(new Request("https://w.example/health"), env)).text();
    expect(JSON.parse(health)).toEqual({ status: "ok", runtime: "test", services: [{ id: "pub", endpoint: "/pub/mcp" }] });
    expect(health).not.toContain("priv");
    expect(health).not.toContain(SECRET);
  });

  it("answers a wrong secret, a near miss, the service id and an unknown path with the same 404", async () => {
    const h = handler();
    const env = { PRIV_PATH: SECRET };
    for (const path of [`/${SECRET.slice(0, -1)}x/mcp`, `/${SECRET}x/mcp`, "/priv/mcp", "/nope/mcp", "/mcp", `/${SECRET}`, `/${SECRET}/mcp/`]) {
      const res = await h.fetch(post(path, LIST), env);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe("Not Found");
    }
  });

  it("switches a private service off when its secret is missing or too short, and says so once without the value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = handler();
    const short = "short-secret";
    expect((await h.fetch(post(`/${short}/mcp`, LIST), { PRIV_PATH: short })).status).toBe(404);
    expect((await h.fetch(post("/undefined/mcp", LIST), {})).status).toBe(404);
    expect((await h.fetch(post("/pub/mcp", LIST), {})).status).toBe(200); // the public service is unaffected
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('"priv" is off');
    expect(String(warn.mock.calls[0][0])).not.toContain(short);
  });

  it("holds the secret rule: under 32 characters or outside A-Z a-z 0-9 _ - is off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of [SECRET.slice(0, 31), `${SECRET.slice(0, 39)}.`, `${SECRET.slice(0, 39)}+`, `${SECRET.slice(0, 37)}%41`]) {
      const h = handler();
      expect((await h.fetch(post(`/${bad}/mcp`, LIST), { PRIV_PATH: bad })).status, bad).toBe(404);
    }
    expect(warn).toHaveBeenCalledTimes(4);
    const h = handler();
    expect((await h.fetch(post(`/${SECRET.slice(0, 32)}/mcp`, LIST), { PRIV_PATH: SECRET.slice(0, 32) })).status).toBe(200);
  });

  it("switches a private service off when its secret equals a public path", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = "a".repeat(40);
    const h = createServicesHandler<Env>({ services: [service("pub", { path }), service("priv", { secretPath: () => path })] });
    expect(await listTools(await h.fetch(post(`/${path}/mcp`, LIST), {}))).toEqual(["pub_echo"]);
  });

  it("serves a private service's health at its secret path only, and only for GET", async () => {
    const h = handler();
    const env = { PRIV_PATH: SECRET };
    expect(await (await h.fetch(new Request(`https://w.example/${SECRET}/health`), env)).json()).toEqual({ status: "ok", name: "priv" });
    expect((await h.fetch(new Request("https://w.example/priv/health"), env)).status).toBe(404);
    expect((await h.fetch(post("/pub/health", {}), env)).status).toBe(404);
  });

  it("serves no private service when two share a secret", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = createServicesHandler<Env>({ services: [service("a", { secretPath: () => SECRET }), service("b", { secretPath: () => SECRET })] });
    expect((await h.fetch(post(`/${SECRET}/mcp`, LIST), {})).status).toBe(404);
    expect(String(err.mock.calls[0][0])).not.toContain(SECRET);
  });

  it("per-service health, 405 for GET on /<path>/mcp, 404 for / without a landing page", async () => {
    const h = createServicesHandler<Env>({ services: [service("pub", { path: "pub" })] });
    expect(await (await h.fetch(new Request("https://w.example/pub/health"), {})).json()).toEqual({ status: "ok", name: "pub" });
    expect((await h.fetch(new Request("https://w.example/pub/mcp"), {})).status).toBe(405);
    expect((await h.fetch(new Request("https://w.example/"), {})).status).toBe(404);
  });

  it("logs a tool call with the service's own entry, not the path", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await handler().fetch(post(`/${SECRET}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "priv_echo", arguments: { q: "hi" } } }), { PRIV_PATH: SECRET });
    expect(JSON.stringify(await res.json())).toContain("priv hi");
    const lines = log.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(lines).toContain('"service":"priv"');
    expect(lines).not.toContain(SECRET);
  });
});

describe("validateServices", () => {
  const ok = (id: string, path: string) => service(id, { path });
  it("rejects bad ids, duplicate ids and paths, reserved paths and services with both or neither kind of path", () => {
    expect(() => validateServices([{ ...ok("a", "x"), id: "Bad Id" }])).toThrow("lower-case");
    expect(() => validateServices([ok("a", "x"), ok("a", "y")])).toThrow("listed twice");
    expect(() => validateServices([ok("a", "x"), ok("b", "x")])).toThrow("more than one service");
    expect(() => validateServices([ok("a", "health")])).toThrow("invalid path");
    expect(() => validateServices([ok("a", "Upper")])).toThrow("invalid path");
    expect(() => validateServices([{ ...ok("a", "x"), secretPath: () => SECRET }])).toThrow("exactly one");
    const neither = ok("a", "x");
    delete neither.path;
    expect(() => validateServices([neither])).toThrow("exactly one");
  });
});

describe("server instructions", () => {
  it("joins the profiles' instructions in order, skipping empty ones, and is undefined when there are none", () => {
    expect(serverInstructions([{ ...profile("a"), instructions: "First." }, profile("b"), { ...profile("c"), instructions: "  Third.  " }])).toBe("First.\n\nThird.");
    expect(serverInstructions([profile("a"), { ...profile("b"), instructions: "   " }])).toBeUndefined();
  });

  it("reach the client in the initialize answer, and are absent when not given", async () => {
    const connect = async (instructions?: string) => {
      const server = createMcpServer({ name: "t", version: "0", ...(instructions !== undefined ? { instructions } : {}) });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "t", version: "0" });
      await Promise.all([server.connect(a), c.connect(b)]);
      return c.getInstructions();
    };
    expect(await connect("Use these tools for X.")).toBe("Use these tools for X.");
    expect(await connect()).toBeUndefined();
    expect(await connect("  ")).toBeUndefined();
  });
});
