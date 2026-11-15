/**
 * Cloudflare Workers entry for several services in one Worker (core `createServicesHandler`): GET / lists the public
 * services, GET /health their endpoints, /<path>/mcp and /<path>/health serve one service. A private service is
 * reachable only at its secret path and is named nowhere a caller can see. GUI text comes from language files (en, sv).
 */

import { createServicesHandler, type WorkerService } from "@ondata-extended/core";
import { PUBLIC_SETUPS, SERVICES, type Env } from "./services.js";
import en from "./i18n/en.json";
import sv from "./i18n/sv.json";

type Strings = typeof en;
const LANGS: Record<string, Strings> = { en, sv };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function pickLang(request: Request): "en" | "sv" {
  const q = new URL(request.url).searchParams.get("lang");
  if (q === "sv" || q === "en") return q;
  return /^sv\b/i.test(request.headers.get("accept-language") ?? "") ? "sv" : "en";
}

/** Titles and intros of the public services, by service id; a public service without one is listed by its id. */
const TEXTS: Record<string, { title: keyof Strings; intro: keyof Strings }> = {
  ecosystem: { title: "ecosystemTitle", intro: "ecosystemIntro" }
};

export function landingPage(request: Request, publicServices: readonly WorkerService<Env>[]): Response {
  const lang = pickLang(request);
  const t = LANGS[lang];
  const other = lang === "sv" ? "en" : "sv";
  const sections = publicServices.map((s) => {
    const text = TEXTS[s.id];
    const setup = PUBLIC_SETUPS[s.id];
    const endpoint = new URL(`/${s.path}/mcp`, request.url).toString();
    const tools = (setup?.profile.tools ?? []).map((tool) => `<li><code>${esc(tool.name)}</code> ${esc(tool.title ?? "")}</li>`).join("");
    return `<h3>${esc(text ? t[text.title] : s.id)}</h3>${text ? `<p>${esc(t[text.intro])}</p>` : ""}
<p>${esc(t.endpoint)}: <code>${esc(endpoint)}</code></p>${tools ? `<p>${esc(t.tools)}:</p><ul>${tools}</ul>` : ""}`;
  }).join("");
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}code{background:#f2f2f2;padding:0 .25rem;border-radius:3px;overflow-wrap:anywhere}@media (prefers-color-scheme:dark){body{color:#eee;background:#141414}code{background:#2a2a2a}}</style></head>
<body><p><a href="?lang=${other}">${esc(t.language)}</a></p><h1>${esc(t.title)}</h1><p>${esc(t.intro)}</p>
<h2>${esc(t.services)}</h2>${sections}<p><small>${esc(t.limits)}</small></p><p><small>${esc(t.status)}</small></p></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Language": lang } });
}

export default createServicesHandler<Env>({
  services: SERVICES,
  health: () => ({ runtime: "cloudflare-workers" }),
  landing: (request, _env, publicServices) => landingPage(request, publicServices)
});
