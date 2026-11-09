/**
 * Cloudflare Workers entry: /, /health and /mcp. The landing page and health counts are
 * generated from the registered profile, so they cannot drift from the code (ondata's were
 * hand-maintained and had drifted). GUI text comes from language files (en, sv).
 */

import { createWorkerHandler, pickTelemetryFields, type AnalyticsEngineDataset, type ConfigSource } from "@ondata-extended/core";
import { KNOWN_VOCABULARIES } from "@ondata-extended/profile-skos";
import { buildServer, createVocabEngine, profile, SERVER_NAME, SERVER_VERSION } from "./server.js";
import type { Engine } from "@ondata-extended/core";
import en from "./i18n/en.json";
import sv from "./i18n/sv.json";

type Env = ConfigSource & { ANALYTICS?: AnalyticsEngineDataset };
type Strings = typeof en;
const LANGS: Record<string, Strings> = { en, sv };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function pickLang(request: Request): "en" | "sv" {
  const q = new URL(request.url).searchParams.get("lang");
  if (q === "sv" || q === "en") return q;
  return /^sv\b/i.test(request.headers.get("accept-language") ?? "") ? "sv" : "en";
}

export function landingPage(request: Request): Response {
  const lang = pickLang(request);
  const t = LANGS[lang];
  const other = lang === "sv" ? "en" : "sv";
  const endpoint = new URL("/mcp", request.url).toString();
  const tools = profile.tools.map((tool) => `<li><code>${esc(tool.name)}</code> ${esc(tool.title ?? "")}</li>`).join("");
  const vocabs = KNOWN_VOCABULARIES.map((v) => `<li><code>${esc(v.id)}</code> ${esc(v.ext.title ?? v.baseUrl)}</li>`).join("");
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}code{background:#f2f2f2;padding:0 .25rem;border-radius:3px}@media (prefers-color-scheme:dark){body{color:#eee;background:#141414}code{background:#2a2a2a}}</style></head>
<body><p><a href="?lang=${other}">${esc(t.language)}</a></p><h1>${esc(t.title)}</h1><p>${esc(t.intro)}</p>
<h2>${esc(t.endpoint)}</h2><p><code>${esc(endpoint)}</code></p><h2>${esc(t.tools)}</h2><ul>${tools}</ul>
<h2>${esc(t.vocabularies)}</h2><ul>${vocabs}</ul><p><small>${esc(t.status)} ${esc(SERVER_NAME)} ${esc(SERVER_VERSION)}</small></p></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Language": lang } });
}

// One engine per isolate, not per request: the engine holds the cache, the rate limiter and the
// per-host throttle, which must span requests. `env` is the same for every request of a Worker
// version, so building from the first one is safe.
let engine: Engine | undefined;

export default createWorkerHandler<Env>({
  buildServer: (env) => buildServer((engine ??= createVocabEngine(env))),
  health: () => ({
    status: "ok",
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: profile.tools.length,
    resources: profile.resources?.length ?? 0,
    prompts: profile.prompts?.length ?? 0,
    runtime: "cloudflare-workers"
  }),
  landing: (request) => landingPage(request),
  logEntry: (tool, args) => pickTelemetryFields(tool, args, profile.telemetryFields),
  analytics: (env) => env.ANALYTICS,
  dataPoint: (entry) => ({
    blobs: [String(entry.tool ?? ""), String(entry.vocab ?? ""), String(entry.query ?? entry.prefix ?? entry.id ?? ""), String(entry.status ?? "")],
    doubles: [Number(entry.duration_ms ?? 0), entry.cache_hit ? 1 : 0],
    indexes: [String(entry.tool ?? "")]
  })
});
