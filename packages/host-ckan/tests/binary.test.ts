/**
 * The `ckan-mcp-server` binary as a user runs it: built from src/node.ts as the package script
 * builds it, then started over stdio and over HTTP. Checks ondata's status lines (src/index.ts,
 * src/transport/*.ts at 09e8cdc), the tool list, and that `CKAN_*` settings reach the engine.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { build } from "esbuild";

const HOST = join(import.meta.dirname, "..");
const BIN = join(HOST, "dist", "binary-test.js");
const running: ChildProcess[] = [];

beforeAll(async () => {
  await build({
    entryPoints: [join(HOST, "src/node.ts")],
    bundle: true, platform: "node", format: "esm", target: "node20", outfile: BIN, logLevel: "silent",
    external: ["@modelcontextprotocol/sdk", "express", "zod", "undici"]
  });
}, 60000);

afterEach(() => {
  for (const p of running.splice(0)) p.kill();
});

function start(env: Record<string, string>) {
  const child = spawn(process.execPath, [BIN], { cwd: HOST, env: { ...process.env, VITEST: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  running.push(child);
  let stderr = "";
  child.stderr!.on("data", (c) => { stderr += c.toString(); });
  return { child, stderr: () => stderr };
}

async function waitFor(cond: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  srv.close();
  return port;
}

describe("ckan-mcp-server binary", () => {
  it("stdio: ondata's status line on stderr, the protocol on stdout", async () => {
    const { child, stderr } = start({ TRANSPORT: "" });
    let stdout = "";
    child.stdout!.on("data", (c) => { stdout += c.toString(); });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
    await waitFor(() => stdout.includes('"id":1'));
    expect(stderr()).toContain("CKAN MCP server running on stdio");
    expect(JSON.parse(stdout.trim().split("\n")[0]).result.serverInfo.name).toBe("ckan-mcp-server");
  }, 20000);

  it("http: ondata's status line, 20 tools, and CKAN_ALLOWED_DOMAINS applied", async () => {
    const port = await freePort();
    const { stderr } = start({ TRANSPORT: "http", PORT: String(port), CKAN_ALLOWED_DOMAINS: "a.example" });
    await waitFor(() => stderr().includes("running on"));
    expect(stderr()).toContain(`CKAN MCP server running on http://127.0.0.1:${port}/mcp`);
    const rpc = async (body: unknown) => (await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(body)
    })).json() as Promise<any>;
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools).toHaveLength(20);
    const refused = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ckan_status_show", arguments: { server_url: "https://b.example" } } });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain('Domain "b.example" is not in the allowed list (CKAN_ALLOWED_DOMAINS)');
  }, 20000);

  it("http without an allowlist refuses to start, naming ondata's setting", async () => {
    const { child, stderr } = start({ TRANSPORT: "http", PORT: String(await freePort()), CKAN_ALLOWED_DOMAINS: "", CKAN_HTTP_ALLOW_ALL: "" });
    const [code] = await once(child, "exit");
    expect(code).toBe(1);
    expect(stderr()).toContain("CKAN_ALLOWED_DOMAINS");
  }, 20000);
});
