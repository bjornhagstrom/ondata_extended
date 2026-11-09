#!/usr/bin/env node
/**
 * Known-answer gate for the vocabulary server, in the style of ondata's scripts/smoke.mjs:
 * builds nothing itself; starts packages/host-vocab/dist/index.js over HTTP with the
 * allowlist set to the cases' host, calls each tool through MCP and checks *which* concept
 * comes back. Exits non-zero on the first failure.
 *
 *   npm run smoke:vocab            all cases
 *   npm run smoke:vocab -- broader only cases whose name matches
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const HOST = join(ROOT, "packages/host-vocab");
const PORT = Number(process.env.SMOKE_PORT ?? 3199);
const FILTER = process.argv[2]?.toLowerCase();
const { cases } = JSON.parse(readFileSync(join(HOST, "tests/smoke/cases.json"), "utf8"));
const selected = FILTER ? cases.filter((c) => c.name.toLowerCase().includes(FILTER)) : cases;

let stderr = "";
let exited = null;
const server = spawn("node", [join(HOST, "dist/index.js")], {
  env: { ...process.env, TRANSPORT: "http", PORT: String(PORT), VOCAB_ALLOWED_DOMAINS: "begrepp.hagstrom.nu" },
  stdio: ["ignore", "ignore", "pipe"]
});
server.stderr.on("data", (c) => { stderr += c; });
server.on("exit", (code, signal) => { exited = signal ?? `code ${code}`; });
process.on("exit", () => server.kill());

let id = 0;
async function rpc(method, params) {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
  });
  return res.json();
}

async function waitReady(ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (exited) throw new Error(`server exited before it was ready (${exited})\n${stderr.trim().split("\n").slice(-5).join("\n")}`);
    try {
      const r = await rpc("tools/list", {});
      if (r?.result?.tools?.some((t) => t.name === "vocab_get_concept")) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not become ready (is packages/host-vocab built? npm run build -w @ondata-extended/host-vocab)");
}

const at = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

function check(c, result) {
  const e = c.expect;
  const text = result?.content?.[0]?.text ?? "";
  if (e.isError) {
    if (!result?.isError) return "expected an error";
    if (e.textContains && !text.includes(e.textContains)) return `error text lacks "${e.textContains}": ${text.slice(0, 200)}`;
    return null;
  }
  if (result?.isError) return `tool error: ${text.slice(0, 300)}`;
  const data = JSON.parse(text);
  const v = at(data, e.jsonPath);
  if ("equals" in e && v !== e.equals) return `${e.jsonPath} = ${JSON.stringify(v)}, expected ${JSON.stringify(e.equals)}`;
  if (e.containsId && !(Array.isArray(v) && v.some((x) => x.id === e.containsId))) return `${e.jsonPath} lacks id ${e.containsId}: ${JSON.stringify(v?.map?.((x) => x.id))}`;
  if (e.firstId && !(Array.isArray(v) && v[0]?.id === e.firstId)) return `${e.jsonPath}[0] is ${v?.[0]?.id}, expected ${e.firstId}`;
  if (e.secondId && !(Array.isArray(v) && v[1]?.id === e.secondId)) return `${e.jsonPath}[1] is ${v?.[1]?.id}, expected ${e.secondId}`;
  if (e.containsValue && !(Array.isArray(v) && v.some((x) => x.value === e.containsValue))) return `${e.jsonPath} lacks ${e.containsValue}`;
  if (e.alsoPath) {
    const w = at(data, e.alsoPath);
    if (!(Array.isArray(w) && w.some((x) => x.type === e.alsoContainsType))) return `${e.alsoPath} lacks type ${e.alsoContainsType}`;
  }
  return null;
}

try {
  await waitReady();
  let failed = 0;
  for (const c of selected) {
    const r = await rpc("tools/call", { name: c.tool, arguments: { ...c.args, response_format: c.expect.isError ? "markdown" : "json" } });
    const problem = r.error ? `JSON-RPC error: ${r.error.message}` : check(c, r.result);
    console.log(`${problem ? "FAIL" : "ok  "} ${c.name}${problem ? `\n     ${problem}` : ""}`);
    if (problem) failed++;
  }
  console.log(`\n${selected.length - failed}/${selected.length} passed`);
  process.exit(failed ? 1 : 0);
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(2);
}
