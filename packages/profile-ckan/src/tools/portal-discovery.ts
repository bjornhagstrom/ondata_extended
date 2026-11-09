/**
 * Portal Discovery tool — finds CKAN portals via datashades.info registry
 *
 * Ported from ondata/ckan-mcp-server src/tools/portal-discovery.ts at 09e8cdc (MIT, see NOTICE.md).
 */

import { z } from "zod";
import type { EngineContext } from "@ondata-extended/profile-contract";
import { cappedStructured } from "@ondata-extended/core";
import { defineTool } from "../types.js";
import { formatCkanError } from "../utils/http.js";
import { fetchAsResponse } from "../utils/fetch.js";
import { addDemoFooter, SHRINKABLE_KEYS } from "../utils/formatting.js";

const DATASHADES_URL = "https://datashades.info/api/portal/list";

interface DatashadesPortal {
  Href: string;
  SiteInfo: { site_title: string; locale_default: string };
  Coordinates: { country_name: string };
  Version: string;
  Plugins: string[];
  DatasetsNumber: number;
  OrgNumber: number;
  status: string;
}

// The registry is 22 MB and every call downloaded it: 5 s median on the Worker
// (telemetry 2026-10-04 to 2026-11-04). Filters change per call, the list rarely does,
// so the active portals are cached, reduced to the fields this tool reads: 945
// portals weigh ~129 KB, under the default per-entry cap.
const REGISTRY_CACHE_KEY = "datashades-portal-list-v1";
const REGISTRY_TTL_SECONDS = 6 * 3600;

function slimPortal(p: DatashadesPortal): DatashadesPortal {
  return {
    Href: p.Href,
    SiteInfo: { site_title: p.SiteInfo?.site_title, locale_default: p.SiteInfo?.locale_default },
    Coordinates: { country_name: p.Coordinates?.country_name },
    Version: p.Version,
    Plugins: (p.Plugins || []).includes("datastore") ? ["datastore"] : [],
    DatasetsNumber: p.DatasetsNumber,
    OrgNumber: p.OrgNumber,
    status: p.status
  };
}

// ondata: safeFetch with its honest identity, a 15 s timeout and https-only redirects; the
// slim list cached under a fixed key (here the profile's namespace in the engine cache)
async function fetchPortals(ctx: EngineContext): Promise<DatashadesPortal[]> {
  const cacheKey = ctx.cache.enabled ? await ctx.cache.key([REGISTRY_CACHE_KEY]) : "";
  if (ctx.cache.enabled) {
    const cached = await ctx.cache.get(cacheKey);
    if (Array.isArray(cached)) return cached as DatashadesPortal[];
  }

  const resp = await fetchAsResponse(ctx, DATASHADES_URL, {}, {
    timeoutMs: 15000,
    userAgent: "honest",
    httpsOnly: true,
    fixedUpstream: true,
    timeoutStyle: "signal"
  });
  if (!resp.ok) {
    throw new Error(`datashades.info returned ${resp.status} ${resp.statusText}`);
  }
  const data = await resp.json() as { portals: DatashadesPortal[] };
  const portals = data.portals.filter(p => p.status === "active" && p.Href).map(slimPortal);

  // the engine cache skips entries over the configured maximum, as ondata did
  if (ctx.cache.enabled) await ctx.cache.set(cacheKey, portals, REGISTRY_TTL_SECONDS);
  return portals;
}

function deduplicateByHostname(portals: DatashadesPortal[]): DatashadesPortal[] {
  const seen = new Map<string, DatashadesPortal>();
  for (const p of portals) {
    try {
      const hostname = new URL(p.Href).hostname;
      const existing = seen.get(hostname);
      if (!existing || p.Href.startsWith("https://")) {
        seen.set(hostname, p);
      }
    } catch { /* skip malformed URLs */ }
  }
  return Array.from(seen.values());
}

function filterPortals(
  portals: DatashadesPortal[],
  params: {
    country?: string;
    query?: string;
    min_datasets?: number;
    language?: string;
    has_datastore?: boolean;
    limit: number;
  }
): DatashadesPortal[] {
  const filtered = portals
    .filter(p => p.status === "active" && p.Href)
    .filter(p => !params.country || p.Coordinates.country_name.toLowerCase().includes(params.country.toLowerCase()))
    .filter(p => !params.query || p.SiteInfo.site_title.toLowerCase().includes(params.query.toLowerCase()))
    .filter(p => params.min_datasets === undefined || p.DatasetsNumber >= params.min_datasets)
    .filter(p => !params.language || p.SiteInfo.locale_default.toLowerCase().startsWith(params.language.toLowerCase()))
    .filter(p => !params.has_datastore || (p.Plugins || []).includes("datastore"));

  return deduplicateByHostname(filtered)
    .sort((a, b) => b.DatasetsNumber - a.DatasetsNumber)
    .slice(0, params.limit);
}

// `limit` unused, as in ondata (its code was never typechecked: see docs/DECISIONS.md, backlog)
function formatMarkdown(portals: DatashadesPortal[], total: number, _limit: number): string {
  if (portals.length === 0) return "No CKAN portals found matching the given filters.";

  const rows = portals.map(p =>
    `| [${p.SiteInfo.site_title || p.Href}](${p.Href}) | ${p.Coordinates.country_name} | ${p.Version} | ${p.DatasetsNumber.toLocaleString()} | ${p.SiteInfo.locale_default} | ${(p.Plugins || []).includes("datastore") ? "✅" : "❌"} |`
  ).join("\n");

  return `# CKAN Portals

**Source**: [datashades.info](https://datashades.info/portals) — live registry of ${total} active portals
**Showing**: ${portals.length} of ${total} (filtered, sorted by dataset count)

| Portal | Country | CKAN | Datasets | Locale | DataStore |
|--------|---------|------|----------|--------|-----------|
${rows}

---
💡 Use the portal URL as \`server_url\` in any CKAN tool.`;
}

export const findPortals = defineTool({
  name: "ckan_find_portals",
  title: "Find CKAN Portals",
  description: `Search the live datashades.info registry of ~950 CKAN portals worldwide.

Use this tool to discover which CKAN portals exist for a country, language, or topic
before querying them with other CKAN tools.

**IMPORTANT — country parameter**: always pass country name in English.
If the user writes in another language (e.g. "Italia", "España", "Brasil"),
translate to English ("Italy", "Spain", "Brazil") before calling this tool.

Args:
  - country (string): Country name in English (e.g. "Italy", "Brazil", "France")
  - query (string): Keyword to match against portal title (e.g. "transport", "health")
  - min_datasets (number): Minimum number of datasets (e.g. 100)
  - language (string): Portal default locale code (e.g. "it", "en", "pt_BR", "fr")
  - has_datastore (boolean): If true, return only portals with DataStore enabled (supports SQL queries)
  - limit (number): Max results to return (default 10, max 50)

Returns:
  Ranked list of matching portals with URL, country, CKAN version, dataset count, and DataStore status.

Typical workflow: ckan_find_portals (discover portal URL) → ckan_status_show (verify) → ckan_package_search (search datasets)`,
  inputSchema: {
    country: z.string().optional().describe("Country name in English (e.g. 'Italy', 'Brazil'). Translate from any language before passing."),
    query: z.string().optional().describe("Keyword matched against portal title (case-insensitive)"),
    min_datasets: z.coerce.number().int().min(0).optional().describe("Minimum number of datasets"),
    language: z.string().optional().describe("Portal default locale code (e.g. 'it', 'en', 'pt_BR')"),
    has_datastore: z.boolean().optional().describe("If true, return only portals with DataStore plugin (required for SQL queries)"),
    limit: z.coerce.number().int().min(1).max(50).optional().default(10).describe("Max results (default 10, max 50)")
  },
  strictInput: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  },
  async handler(params, ctx) {
    try {
      const all = await fetchPortals(ctx);
      const active = all.filter(p => p.status === "active");
      const results = filterPortals(all, {
        country: params.country,
        query: params.query,
        min_datasets: params.min_datasets,
        language: params.language,
        has_datastore: params.has_datastore,
        limit: params.limit
      });

      const markdown = formatMarkdown(results, active.length, params.limit);

      // Text channel is Markdown, so cap the structured payload on its own. The 50-result
      // limit bounds the number of entries, not their size: titles and URLs come from
      // datashades.info and have no length bound (#39).
      return {
        content: [{ type: "text", text: ctx.output.truncateText(addDemoFooter(ctx, markdown)) }],
        structuredContent: cappedStructured({ portals: results.map(p => ({
          url: p.Href,
          title: p.SiteInfo.site_title,
          country: p.Coordinates.country_name,
          version: p.Version,
          datasets: p.DatasetsNumber,
          locale: p.SiteInfo.locale_default,
          has_datastore: (p.Plugins || []).includes("datastore")
        }))}, ctx.limits.characterLimit, SHRINKABLE_KEYS) as Record<string, unknown>
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Could not fetch portal list from datashades.info:\n${formatCkanError(error, "ckan_find_portals")}` }],
        isError: true
      };
    }
  }
});

export const PORTAL_DISCOVERY_TOOLS = [findPortals];
