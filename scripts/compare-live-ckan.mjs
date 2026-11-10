#!/usr/bin/env node
/**
 * Live side-by-side check: the same MCP requests to ondata's public Worker and to a deployment of ours, sent at the
 * same moment, results compared after the service notice is masked (D13). Read-only calls, about 20 per side.
 *
 *   node scripts/compare-live-ckan.mjs <oursMcpUrl> [ondataMcpUrl]
 *
 * A difference is printed with the text around the first differing character. Exit code 1 if any differ.
 */
// ondata's public endpoint (its README); ours is an argument, so no deployment address lives in the repository.
const B = process.argv[2];
const A = process.argv[3] ?? "https://ckan-mcp-server.andy-pr.workers.dev/mcp";
if (!B) {
  console.error("usage: node scripts/compare-live-ckan.mjs <oursMcpUrl> [ondataMcpUrl]");
  process.exit(2);
}
const M = "https://dati.comune.milano.it";
const G = "https://www.dati.gov.it/opendata";
const calls = [
  ["tools/list", {}],
  ["resources/templates/list", {}],
  ["prompts/list", {}],
  ["tools/call", { name: "ckan_status_show", arguments: { server_url: M } }],
  ["tools/call", { name: "ckan_package_search", arguments: { server_url: M, q: "bilancio", rows: 3 } }],
  ["tools/call", { name: "ckan_package_search", arguments: { server_url: G, q: "bonifica siti contaminati Piemonte", rows: 3, response_format: "json" } }],
  ["tools/call", { name: "ckan_find_relevant_datasets", arguments: { server_url: M, query: "trasporti pubblici", limit: 3 } }],
  ["tools/call", { name: "ckan_organization_list", arguments: { server_url: M, limit: 5 } }],
  ["tools/call", { name: "ckan_organization_search", arguments: { server_url: G, pattern: "toscana" } }],
  ["tools/call", { name: "ckan_tag_list", arguments: { server_url: M, limit: 10 } }],
  ["tools/call", { name: "ckan_group_list", arguments: { server_url: G, limit: 5 } }],
  ["tools/call", { name: "ckan_package_show", arguments: { server_url: M, id: "ds633_bilancio_partecipativo" } }],
  ["tools/call", { name: "ckan_list_resources", arguments: { server_url: M, id: "ds633_bilancio_partecipativo" } }],
  ["tools/call", { name: "ckan_catalog_stats", arguments: { server_url: M, facet_limit: 5 } }],
  ["tools/call", { name: "ckan_find_portals", arguments: { country: "Italy", limit: 5 } }],
  ["tools/call", { name: "sparql_query", arguments: { endpoint_url: "https://query.wikidata.org/sparql", query: "SELECT ?x WHERE { BIND(42 AS ?x) }" } }],
  ["tools/call", { name: "ckan_status_show", arguments: { server_url: "http://127.0.0.1" } }],
  ["tools/call", { name: "ckan_status_show", arguments: { server_url: "https://example.invalid" } }],
  ["tools/call", { name: "ckan_package_show", arguments: { server_url: M, id: "does-not-exist-xyz" } }],
  ["resources/read", { uri: "ckan://dati.comune.milano.it/dataset/ds633_bilancio_partecipativo" }],
  ["prompts/get", { name: "ckan-search-by-theme", arguments: { server_url: M, theme: "ambiente" } }]
];
async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  let t = await r.text();
  if (t.startsWith("event:") || t.includes("\ndata: ")) t = t.split("data: ").slice(1).join("");
  return t;
}
const norm = (s) => s
  .replace(/ℹ️ Test instance of ondata-extended[^"\\]*/g, "<NOTICE>")
  .replace(/ℹ️ Demo instance[^"\\]*/g, "<NOTICE>")
  .replace(/\\n\\n---\\n<NOTICE>/g, "\\n\\n---\\n<NOTICE>");
let same = 0, diff = 0;
for (const [m, p] of calls) {
  const [a, b] = await Promise.all([rpc(A, m, p), rpc(B, m, p)]);
  const label = m + (p.name ? " " + p.name : "") + (p.uri ? " " + p.uri : "") + " " + JSON.stringify(p.arguments ?? {}).slice(0, 70);
  if (norm(a) === norm(b)) { same++; console.log("SAME ", label); }
  else {
    diff++; console.log("DIFF ", label);
    const na = norm(a), nb = norm(b); let i = 0; while (i < na.length && na[i] === nb[i]) i++;
    console.log("   ondata:", JSON.stringify(na.slice(Math.max(0, i - 80), i + 160)));
    console.log("   ours  :", JSON.stringify(nb.slice(Math.max(0, i - 80), i + 160)));
  }
  await new Promise((r) => setTimeout(r, 300));
}
console.log(`\n${same} same, ${diff} different (of ${calls.length})`);
process.exitCode = diff ? 1 : 0;
