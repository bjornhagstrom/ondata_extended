/**
 * The example profile end to end: real engine, real MCP client (in memory), the network replaced
 * by answers recorded from GitHub on 2026-11-10 (tests/fixtures/github). Every request still
 * passes the core's guards; only `fetch` and DNS are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { __setDnsResolverForTests, createEngine, createMcpServer, registerProfiles } from "@ondata-extended/core";
import { createExampleProfile } from "../src/index.js";

const FIX = join(import.meta.dirname, "fixtures", "github");
const recorded = new Map<string, { body: string; status: number; contentType: string }>();
for (const f of readdirSync(FIX).filter((n) => n.endsWith(".meta.json"))) {
  const meta = JSON.parse(readFileSync(join(FIX, f), "utf8")) as { url: string; status: number; contentType: string };
  recorded.set(meta.url, { body: readFileSync(join(FIX, f.replace(".meta.json", ".body")), "utf8"), status: meta.status, contentType: meta.contentType });
}

let requests: { url: string; headers: Headers }[] = [];
beforeEach(() => {
  requests = [];
  __setDnsResolverForTests(async () => [{ address: "140.82.121.6", family: 4 }]);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ url, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
    const hit = recorded.get(url);
    if (!hit) return new Response(`no fixture for ${url}`, { status: 599 });
    return new Response(hit.body, { status: hit.status, headers: { "content-type": hit.contentType } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setDnsResolverForTests(null);
});

async function client(env: Record<string, string> = {}) {
  const engine = createEngine({ configPrefixes: ["AKN"], configSource: { AKN_RATE_LIMIT_ENABLED: "false", ...env }, cacheOrigin: "https://t.internal" });
  const server = createMcpServer({ name: "t", version: "0" });
  registerProfiles(server, [createExampleProfile()], engine);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
}

const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = await c.callTool({ name, arguments: args });
  return { text: (r.content as { text: string }[])[0].text, isError: r.isError === true, structured: r.structuredContent as Record<string, unknown> | undefined };
};

describe("the two tools", () => {
  it("are registered with the akn_ prefix, read-only, with examples in the description", async () => {
    const tools = (await (await client()).listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["akn_document", "akn_list_files"]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.description).toContain("Examples:");
    }
  });

  it("akn_list_files lists the Piano Casa bill's folders, with titles", async () => {
    const r = await call(await client(), "akn_list_files", { legislature: 19, ddl: 60233 });
    expect(r.isError).toBe(false);
    const rows = r.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((x: { name: string }) => x.name)).toEqual(["README.MD", "README_ENG.MD", "ddlmess", "ddlpres", "emend", "emendc", "resaula", "sommcomm"]);
    expect(rows).toContainEqual({ name: "emendc", type: "dir", title: "amendments in committee" });
    expect(r.structured).toMatchObject({ columns: ["name", "type", "title"], total: 8, truncated: false });
  });

  it("akn_list_files lists one folder's files with sizes", async () => {
    const r = await call(await client(), "akn_list_files", { legislature: 19, ddl: 60233, kind: "sommcomm" });
    expect(r.text.trim().split("\n").map((l) => JSON.parse(l))).toEqual([
      { name: "01511374-rc.akn.xml", type: "file", size: "35310" },
      { name: "01512302-rc.akn.xml", type: "file", size: "28385" }
    ]);
  });

  it("akn_document reads an amendment as Markdown, the text fenced as untrusted", async () => {
    const r = await call(await client(), "akn_document", { legislature: 19, ddl: 60233, kind: "emendc", file: "01511402-em.akn.xml" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^# Emendamento 1\.4\n/);
    expect(r.text).toContain("- **Date**: 2026-06-30 (presentazione)");
    expect(r.text).toContain("amendments in committee");
    expect(r.text).toContain("sopprimere le parole");
    expect(r.text).toMatch(/untrusted|UNTRUSTED/);
  });

  it("akn_document cuts a long report at max_chars and says so", async () => {
    const r = await call(await client(), "akn_document", { legislature: 19, ddl: 60233, kind: "sommcomm", file: "01512302-rc.akn.xml", max_chars: 500, response_format: "json" });
    const out = JSON.parse(r.text);
    expect(out).toMatchObject({ subtype: "SOMMCOMM", number: "284", truncated: true });
    expect(out.text).toHaveLength(501);
  });

  it("an unknown bill is an error with the profile's hint, not an invented answer", async () => {
    const r = await call(await client(), "akn_list_files", { legislature: 19, ddl: 9999999 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Ddl 9999999 (legislature 19) is not in the Senate's Akoma Ntoso repository.");
    expect(r.text).toContain("Call akn_list_files without `kind`");
  });

  it("a file name outside the repository's pattern never reaches the network", async () => {
    const r = await call(await client(), "akn_document", { legislature: 19, ddl: 60233, kind: "emend", file: "../../README.MD" });
    expect(r.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("sends the token to api.github.com only, and never shows it", async () => {
    const c = await client({ AKN_GITHUB_TOKEN: "ghp_secretvalue" });
    const list = await call(c, "akn_list_files", { legislature: 19, ddl: 60233 });
    const doc = await call(c, "akn_document", { legislature: 19, ddl: 60233, kind: "emendc", file: "01511402-em.akn.xml" });
    const missing = await call(c, "akn_list_files", { legislature: 19, ddl: 9999999 });
    for (const r of [list, doc, missing]) expect(r.text).not.toContain("ghp_secretvalue");
    for (const q of requests) {
      const auth = q.headers.get("authorization");
      if (new URL(q.url).hostname === "api.github.com") expect(auth).toBe("Bearer ghp_secretvalue");
      else expect(auth).toBeNull();
    }
    expect(new Set(requests.map((q) => new URL(q.url).hostname))).toEqual(new Set(["api.github.com", "raw.githubusercontent.com"]));
  });
});
