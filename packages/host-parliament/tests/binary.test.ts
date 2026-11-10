/**
 * The `italianparliament-mcp` binary as a user runs it: built from src/node.ts as the package
 * script builds it, then started over stdio. As the original's src/index.ts at fd46810: the
 * protocol on stdout, nothing on stderr, the server's name. No tool is called (no network).
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { build } from "esbuild";

const HOST = join(import.meta.dirname, "..");
const BIN = join(HOST, "dist", "binary-test.js");
const running: ChildProcess[] = [];

beforeAll(async () => {
  await build({
    entryPoints: [join(HOST, "src/node.ts")],
    bundle: true, platform: "node", format: "esm", target: "node20", outfile: BIN, logLevel: "silent",
    banner: { js: "#!/usr/bin/env node" },
    external: ["@modelcontextprotocol/sdk", "express", "zod", "undici"]
  });
}, 60000);

afterEach(() => {
  for (const p of running.splice(0)) p.kill();
});

async function waitFor(cond: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("italianparliament-mcp binary", () => {
  it("stdio: initialize names the server, tools/list gives the six tools, stderr stays empty", async () => {
    const child = spawn(process.execPath, [BIN], { cwd: HOST, env: { ...process.env, VITEST: "" }, stdio: ["pipe", "pipe", "pipe"] });
    running.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c) => { stdout += c.toString(); });
    child.stderr!.on("data", (c) => { stderr += c.toString(); });
    const send = (m: unknown) => child.stdin!.write(JSON.stringify(m) + "\n");
    const reply = (id: number) => stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === id);

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    await waitFor(() => reply(1) !== undefined);
    expect(reply(1).result.serverInfo).toEqual({ name: "italianparliament-mcp", version: "0.1.0" });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(() => reply(2) !== undefined);
    expect(reply(2).result.tools.map((t: { name: string }) => t.name))
      .toEqual(["deputies", "search", "legislatures", "bill-progress", "camera-amendments", "sparql"]);
    expect(stderr).toBe("");
  }, 20000);
});
