/**
 * Engine wiring, profile registration, config prefixes, instance registry and the Workers
 * host. New code; the registration tests go through a real MCP client over an in-memory
 * transport, so they test what a client sees.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Profile } from "@ondata-extended/profile-contract";
import {
  createConfig,
  createEngine,
  createInstanceRegistry,
  createMcpServer,
  createTextPrompt,
  createWorkerHandler,
  noteTelemetry,
  pickTelemetryFields,
  registerProfiles,
  validateProfiles
} from "../src/index.js";

function testProfile(over: Partial<Profile> = {}): Profile {
  return {
    id: "demo",
    version: "0.0.1",
    toolPrefix: "demo_",
    shrinkableKeys: ["items"],
    telemetryFields: ["q"],
    untrustedSourceLabel: "the demo service",
    honestUserAgent: "Demo/0.0.1",
    tools: [
      {
        name: "demo_echo",
        description: "Echo",
        inputSchema: { q: z.string(), response_format: z.enum(["markdown", "json"]).default("markdown") },
        handler: async (args, ctx) => {
          ctx.telemetry.note({ echoed: args.q });
          return args.response_format === "json" ? ctx.output.json({ q: args.q }) : ctx.output.text(`echo ${args.q}`);
        }
      },
      {
        name: "demo_fail",
        description: "Always fails",
        inputSchema: { response_format: z.enum(["markdown", "json"]).default("markdown") },
        handler: async () => { throw new Error("boom"); }
      }
    ],
    prompts: [
      { name: "demo-guide", description: "Guide", referencedTools: ["demo_echo"], build: () => createTextPrompt("Call demo_echo") }
    ],
    describeError: (_e, tool) => (tool === "demo_fail" ? "→ Try demo_echo instead." : null),
    ...over
  };
}

const engine = () => createEngine({ configPrefixes: ["APP"], configSource: {}, cacheOrigin: "https://test-cache.internal" });

async function connect(profiles: Profile[]) {
  const server = createMcpServer({ name: "test", version: "0.0.0" });
  registerProfiles(server, profiles, engine());
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client };
}

describe("validateProfiles", () => {
  it("rejects a tool without the profile prefix unless it is shared", () => {
    const p = testProfile();
    p.tools[0] = { ...p.tools[0], name: "echo" };
    p.prompts = [];
    expect(() => validateProfiles([p])).toThrow('does not start with "demo_"');
    p.tools[0] = { ...p.tools[0], shared: true };
    expect(() => validateProfiles([p])).not.toThrow();
  });

  it("rejects the same tool name in two profiles", () => {
    expect(() => validateProfiles([testProfile(), testProfile({ id: "other" })])).toThrow("more than one profile");
  });

  it("rejects a prompt that tells the model to call a tool that does not exist", () => {
    const p = testProfile({
      prompts: [{ name: "bad", description: "x", referencedTools: ["demo_missing"], build: () => createTextPrompt("x") }]
    });
    expect(() => validateProfiles([p])).toThrow('refers to tool "demo_missing"');
  });
});

describe("registerProfiles through an MCP client", () => {
  it("lists the profile's tools and prompts", async () => {
    const { client } = await connect([testProfile()]);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["demo_echo", "demo_fail"]);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["demo-guide"]);
  });

  it("calls a tool and returns its markdown and JSON forms", async () => {
    const { client } = await connect([testProfile()]);
    const md = await client.callTool({ name: "demo_echo", arguments: { q: "hej" } });
    expect((md.content as { text: string }[])[0].text).toBe("echo hej");
    const js = await client.callTool({ name: "demo_echo", arguments: { q: "hej", response_format: "json" } });
    expect(js.structuredContent).toEqual({ q: "hej" });
  });

  it("turns an uncaught error into isError with the profile's hint, in the caller's format", async () => {
    const { client } = await connect([testProfile()]);
    const md = await client.callTool({ name: "demo_fail", arguments: {} });
    expect(md.isError).toBe(true);
    expect((md.content as { text: string }[])[0].text).toBe("boom\n→ Try demo_echo instead.");
    const js = await client.callTool({ name: "demo_fail", arguments: { response_format: "json" } });
    expect(JSON.parse((js.content as { text: string }[])[0].text)).toEqual({ error: "boom\n→ Try demo_echo instead.", _error: true });
  });

  it("notes telemetry on the server instance that handled the call", async () => {
    const { server, client } = await connect([testProfile()]);
    await client.callTool({ name: "demo_echo", arguments: { q: "x" } });
    const { takeTelemetry } = await import("../src/index.js");
    expect(takeTelemetry(server)).toMatchObject({ echoed: "x" });
    expect(takeTelemetry(server)).toBeNull();
  });

  it("uses the profile's untrusted-source label", () => {
    const ctx = engine().contextFor(testProfile(), {});
    expect(ctx.output.wrapUntrusted("hi")).toContain("untrusted content from the demo service");
  });

  it("shrinks the profile's arrays first when JSON is over the limit", () => {
    const e = createEngine({ configPrefixes: ["APP"], configSource: { APP_CHARACTER_LIMIT: "300" }, cacheOrigin: "https://x.internal" });
    const ctx = e.contextFor(testProfile(), {});
    const out = ctx.output.json({ items: Array.from({ length: 50 }, (_, i) => ({ i, pad: "x".repeat(20) })) });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed._truncated).toBe(true);
    expect(parsed._original_count).toBe(50);
    expect(out.content[0].text.length).toBeLessThanOrEqual(300);
  });
});

describe("createConfig", () => {
  it("reads prefixes in order and names the primary one", () => {
    const c = createConfig({ OLD_ALLOWED_DOMAINS: "old.example", NEW_TIMEOUT_MS: "5" }, ["NEW", "OLD"]);
    expect(c.get("ALLOWED_DOMAINS")).toBe("old.example");
    expect(c.get("TIMEOUT_MS")).toBe("5");
    expect(c.nameOf("ALLOWED_DOMAINS")).toBe("NEW_ALLOWED_DOMAINS");
  });

  it("prefers the first prefix and treats empty as unset", () => {
    const c = createConfig({ NEW_X: "", OLD_X: "old", NEW_Y: "new", OLD_Y: "old" }, ["NEW", "OLD"]);
    expect(c.get("X")).toBe("old");
    expect(c.get("Y")).toBe("new");
  });

  it("refuses an empty or malformed prefix list", () => {
    expect(() => createConfig({}, [])).toThrow();
    expect(() => createConfig({}, ["bad-prefix"])).toThrow("Invalid config prefix");
  });
});

describe("createInstanceRegistry", () => {
  const reg = createInstanceRegistry([
    { id: "one", baseUrl: "https://one.example/api/", aliases: ["https://ONE-old.example"], ext: { a: 1 } },
    { id: "two", baseUrl: "https://two.example", ext: { a: 2 } }
  ]);

  it("finds by id, by URL ignoring trailing slash and host case, and by alias", () => {
    expect(reg.find("one")?.id).toBe("one");
    expect(reg.find("https://ONE.example/api")?.id).toBe("one");
    expect(reg.find("https://one-old.example/")?.id).toBe("one");
    expect(reg.find("https://three.example")).toBeUndefined();
  });

  it("finds by hostname", () => {
    expect(reg.byHostname("TWO.example")?.ext).toEqual({ a: 2 });
  });

  it("refuses duplicate ids and malformed URLs", () => {
    expect(() => createInstanceRegistry([{ id: "x", baseUrl: "https://a", ext: 0 }, { id: "x", baseUrl: "https://b", ext: 0 }])).toThrow("Duplicate");
    expect(() => createInstanceRegistry([{ id: "x", baseUrl: "not a url", ext: 0 }])).toThrow();
  });
});

describe("createWorkerHandler", () => {
  const handler = (log = vi.fn()) => {
    vi.spyOn(console, "log").mockImplementation(log);
    return createWorkerHandler<Record<string, never>>({
      buildServer: () => {
        const s = createMcpServer({ name: "w", version: "0" });
        registerProfiles(s, [testProfile()], engine());
        return s;
      },
      health: () => ({ status: "ok", tools: 2 }),
      logEntry: (tool, args) => pickTelemetryFields(tool, args, ["q"]),
      extraHeaders: { "X-Test": "1" }
    });
  };
  const call = (body: unknown) => new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body)
  });

  it("answers /health, refuses GET /mcp and answers the CORS preflight", async () => {
    const h = handler();
    expect(await (await h.fetch(new Request("https://w.example/health"), {})).json()).toEqual({ status: "ok", tools: 2 });
    expect((await h.fetch(new Request("https://w.example/mcp"), {})).status).toBe(405);
    expect((await h.fetch(new Request("https://w.example/mcp", { method: "OPTIONS" }), {})).status).toBe(204);
    expect((await h.fetch(new Request("https://w.example/nope"), {})).status).toBe(404);
  });

  it("serves a tool call statelessly and logs the allowed fields plus what the tool noted", async () => {
    const log = vi.fn();
    const h = handler(log);
    const res = await h.fetch(call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "demo_echo", arguments: { q: "x", secret: "no" } } }), {});
    expect(res.headers.get("X-Test")).toBe("1");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = await res.json() as { result: { content: { text: string }[] } };
    expect(body.result.content[0].text).toBe("echo x");
    const entry = JSON.parse(log.mock.calls.at(-1)![0]);
    expect(entry).toMatchObject({ tool: "demo_echo", q: "x", echoed: "x", status: "ok" });
    expect(entry).not.toHaveProperty("secret");
    vi.restoreAllMocks();
  });

  it("logs an error kind for a failed call", async () => {
    const log = vi.fn();
    const h = handler(log);
    await h.fetch(call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "demo_fail", arguments: {} } }), {});
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ status: "error", error_kind: "other" });
    vi.restoreAllMocks();
  });
});

describe("pickTelemetryFields", () => {
  it("keeps listed fields, caps strings and serializes objects", () => {
    expect(pickTelemetryFields("t", { q: "a".repeat(500), f: { x: 1 }, n: 3, other: 1 }, ["q", "f", "n"]))
      .toEqual({ tool: "t", q: "a".repeat(200), f: '{"x":1}', n: 3 });
  });
});

describe("noteTelemetry", () => {
  it("merges notes per server instance and keeps instances apart", async () => {
    const { takeTelemetry } = await import("../src/index.js");
    const a = {}, b = {};
    noteTelemetry(a, { x: 1 });
    noteTelemetry(a, { y: 2 });
    noteTelemetry(b, { x: 9 });
    expect(takeTelemetry(a)).toEqual({ x: 1, y: 2 });
    expect(takeTelemetry(b)).toEqual({ x: 9 });
  });
});

describe("row-level tools (rows instead of handler)", () => {
  const rowsProfile = (over: Partial<Profile> = {}): Profile => ({
    ...testProfile({ prompts: [] }),
    id: "rows",
    toolPrefix: "rows_",
    emptyText: "Profile: nothing here.",
    tools: [
      {
        name: "rows_list",
        description: "List",
        inputSchema: { n: z.number().int().min(0).max(5) },
        rows: async (args) => ({
          rows: Array.from({ length: args.n }, (_, i) => ({ id: String(i), extra: "x" })),
          columns: ["id"],
          ...(args.n === 5 ? { notice: "[cut at 5]" } : {})
        })
      },
      {
        name: "rows_own_empty",
        description: "Empty with its own text",
        inputSchema: {},
        rows: async () => ({ rows: [], emptyText: "Tool: nothing here." })
      }
    ],
    ...over
  });

  it("refuses a tool with both or neither of handler and rows", () => {
    const both = rowsProfile();
    both.tools = [{ ...both.tools[0], handler: async () => ({ content: [] }) }];
    expect(() => validateProfiles([both])).toThrow("exactly one of handler and rows");
    const neither = rowsProfile();
    neither.tools = [{ name: "rows_x", description: "x", inputSchema: {} }];
    expect(() => validateProfiles([neither])).toThrow("exactly one of handler and rows");
  });

  it("is formatted by the core for MCP: chosen columns, notice after rows, structured rows", async () => {
    const { client } = await connect([rowsProfile()]);
    const r = await client.callTool({ name: "rows_list", arguments: { n: 5 } });
    expect((r.content as { text: string }[])[0].text).toBe('{"id":"0"}\n{"id":"1"}\n{"id":"2"}\n{"id":"3"}\n{"id":"4"}\n[cut at 5]');
    expect(r.structuredContent).toMatchObject({ columns: ["id"], total: 5, truncated: false });
  });

  it("uses the tool's empty text, else the profile's, else the core's", async () => {
    const { client } = await connect([rowsProfile()]);
    const text = async (name: string, args: Record<string, unknown>) =>
      ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text;
    expect(await text("rows_own_empty", {})).toBe("Tool: nothing here.");
    expect(await text("rows_list", { n: 0 })).toBe("Profile: nothing here.");
    const { client: bare } = await connect([rowsProfile({ emptyText: undefined })]);
    expect(((await bare.callTool({ name: "rows_list", arguments: { n: 0 } })).content as { text: string }[])[0].text).toContain("Do not infer or invent");
  });

  it("runRowsTool gives a CLI the rows unformatted, after validating the arguments", async () => {
    const { runRowsTool, formatTable } = await import("../src/index.js");
    const result = await runRowsTool(rowsProfile(), "rows_list", { n: 2 }, engine());
    expect(result.rows).toEqual([{ id: "0", extra: "x" }, { id: "1", extra: "x" }]);
    expect(formatTable(result.rows, { columns: result.columns, emptyText: "-", format: "csv" }, 1000).text).toBe("id\n0\n1");
    await expect(runRowsTool(rowsProfile(), "rows_list", { n: 99 }, engine())).rejects.toThrow();
    await expect(runRowsTool(rowsProfile(), "rows_missing", {}, engine())).rejects.toThrow('Unknown tool "rows_missing"');
    await expect(runRowsTool(testProfile(), "demo_echo", { q: "x" }, engine())).rejects.toThrow("returns a document, not rows");
  });
});

describe("strict tool input (strictInput)", () => {
  const shape = { q: z.string() };
  const profile = (strict: boolean) => testProfile({
    tools: [{ name: "demo_args", description: "Args", inputSchema: shape, strictInput: strict, handler: async (args, ctx) => ctx.output.text(JSON.stringify(args)) }],
    prompts: []
  });

  it("rejects an unknown argument when the tool asks for it, as a Zod .strict() object does", async () => {
    const { client } = await connect([profile(true)]);
    const r = await client.callTool({ name: "demo_args", arguments: { q: "x", extra: 1 } }) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Unrecognized key(s) in object: 'extra'");
  });

  it("drops an unknown argument otherwise", async () => {
    const { client } = await connect([profile(false)]);
    const r = await client.callTool({ name: "demo_args", arguments: { q: "x", extra: 1 } }) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ q: "x" });
  });

  it("applies to runRowsTool too", async () => {
    const { runRowsTool, inputSchemaOf } = await import("../src/index.js");
    expect(() => inputSchemaOf({ inputSchema: shape, strictInput: true }).parse({ q: "x", extra: 1 })).toThrow("Unrecognized key");
    const rowsProfile = testProfile({
      tools: [{ name: "demo_rows", description: "Rows", inputSchema: shape, strictInput: true, rows: async () => ({ rows: [] }) }],
      prompts: []
    });
    await expect(runRowsTool(rowsProfile, "demo_rows", { q: "x", extra: 1 }, engine())).rejects.toThrow("Unrecognized key");
  });
});

describe("EngineContext additions for profiles with their own request layer", () => {
  it("validateUrl passes a configured private host only when asked", () => {
    const e = createEngine({ configPrefixes: ["APP"], configSource: { APP_PRIVATE_HOSTS: "10.1.2.3" }, cacheOrigin: "https://test-cache.internal" });
    const ctx = e.contextFor(testProfile(), {});
    expect(() => ctx.http.validateUrl("http://10.1.2.3/")).toThrow("private/internal");
    expect(() => ctx.http.validateUrl("http://10.1.2.3/", { allowPrivateHosts: true })).not.toThrow();
  });

  it("cache.defaultTtlSeconds is the configured default, 300 s unless set", () => {
    expect(engine().contextFor(testProfile(), {}).cache.defaultTtlSeconds).toBe(300);
    const e = createEngine({ configPrefixes: ["APP"], configSource: { APP_CACHE_TTL_DEFAULT: "42" }, cacheOrigin: "https://test-cache.internal" });
    expect(e.contextFor(testProfile(), {}).cache.defaultTtlSeconds).toBe(42);
  });
});

describe("resources through an MCP client", () => {
  it("matches the template, hands the variables and the context to read, and returns its contents", async () => {
    let seen: { uri: string; variables: unknown; hasContext: boolean } | null = null;
    const profile = testProfile({
      resources: [{
        name: "demo-item",
        uriTemplate: "demo://{host}/item/{id}",
        title: "Demo item",
        description: "One item",
        mimeType: "application/json",
        read: async (uri, variables, ctx) => {
          seen = { uri: uri.href, variables, hasContext: typeof ctx.http.request === "function" };
          return { contents: [{ uri: uri.href, mimeType: "application/json", text: ctx.output.truncateJson({ id: variables.id }) }] };
        }
      }]
    });
    const { client } = await connect([profile]);
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates).toEqual([
      expect.objectContaining({ name: "demo-item", uriTemplate: "demo://{host}/item/{id}", title: "Demo item", mimeType: "application/json" })
    ]);
    const r = await client.readResource({ uri: "demo://example.org/item/42" });
    expect(seen).toEqual({ uri: "demo://example.org/item/42", variables: { host: "example.org", id: "42" }, hasContext: true });
    expect(r.contents).toEqual([{ uri: "demo://example.org/item/42", mimeType: "application/json", text: JSON.stringify({ id: "42" }, null, 2) }]);
  });
});

