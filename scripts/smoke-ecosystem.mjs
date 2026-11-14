#!/usr/bin/env node
/**
 * Known-answer gate for the CKAN ecosystem profile: starts packages/host-ckan-ecosystem/dist/index.js
 * over stdio, calls each case's tool through MCP against the bundled index and live GitHub (README
 * openings), and checks the answer. Exits non-zero on a failure.
 *
 *   npm run smoke:ecosystem
 *   SMOKE_URL=https://<worker>/mcp node scripts/smoke-ecosystem.mjs   against a deployed server (after a deploy)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const HOST = join(ROOT, "packages/host-ckan-ecosystem");
const { cases } = JSON.parse(readFileSync(join(HOST, "tests/smoke/cases.json"), "utf8"));

const env = { PATH: process.env.PATH ?? "", ECOSYSTEM_ALLOWED_DOMAINS: "raw.githubusercontent.com" };
const client = new Client({ name: "smoke", version: "0" });
const REMOTE = process.env.SMOKE_URL;
await client.connect(REMOTE
  ? new StreamableHTTPClientTransport(new URL(REMOTE))
  : new StdioClientTransport({ command: "node", args: [join(HOST, "dist/index.js")], env, stderr: "ignore" }));

let failed = 0;
for (const c of cases) {
  const r = await client.callTool({ name: c.tool, arguments: c.args });
  const text = r.content?.[0]?.text ?? "";
  const ok = (c.expect.isError === undefined || (r.isError === true) === c.expect.isError) && text.includes(c.expect.textContains);
  console.log(`${ok ? "ok  " : "FAIL"} ${c.name}`);
  if (!ok) {
    failed++;
    console.log(`     got: ${text.slice(0, 300)}`);
  }
}
await client.close();
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
