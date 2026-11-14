/**
 * The bundled index (data/index.json, built by scripts/build-ckan-ecosystem-index.mjs) and the pure functions
 * over it: lookup, search ranking, co-installation, README openings. No engine, no network.
 */

import rawIndex from "../data/index.json";

export interface Extension {
  repo: string;
  url: string;
  /** datHere's package name ("ckanext-dcat"), when their crawl matched the repository to a package. */
  package: string | null;
  plugins: string[];
  families: string[];
  description: string | null;
  topics: string[];
  stars: number | null;
  forks: number | null;
  contributors: number | null;
  open_issues: number | null;
  releases: number | null;
  latest_release: string | null;
  release_date: string | null;
  pushed_at: string | null;
  archived: boolean;
  fork_of: string | null;
  /** Portals whose reported plugins datHere matched to this package; null when not matched. */
  portals: number | null;
  portals_pct: number | null;
  /**
   * datHere's push-recency bucket: active (<180 days), recent (<365), quiet (<730), still, archived; datHere write
   * `unknown` when the push date is missing (none in the index of 2026-11-14), which the `upkeep` filter does not offer.
   */
  upkeep: string | null;
  forks_ahead: number | null;
  on_github: boolean;
}

export interface Portal {
  name: string;
  url: string;
  ckan_version: string | null;
  datasets: number | null;
  status: string | null;
  plugins: string[];
}

export interface Plugin {
  name: string;
  portals: number;
  pct: number;
  core: boolean;
  family: string | null;
}

export interface EcosystemIndex {
  about: string;
  built: string;
  source: { repository: string; commit: string; files: Record<string, string> };
  dashboard_generated: string;
  extensions_week: string;
  portals_week: string;
  reporting_portals: number;
  /** [plugin a, plugin b, portals running both]; datHere computes pairs only among the most used plugins. */
  pairs_top: [string, string, number][];
  plugins: Plugin[];
  extensions: Extension[];
  portals: Portal[];
}

export const UPKEEP = ["active", "recent", "quiet", "still", "archived"] as const;

let current: EcosystemIndex = rawIndex as unknown as EcosystemIndex;

export function getIndex(): EcosystemIndex {
  return current;
}

/** Tests only: serve a small index instead of the bundled one; `undefined` restores it. */
export function setIndexForTests(index: EcosystemIndex | undefined): void {
  current = index ?? (rawIndex as unknown as EcosystemIndex);
}

/** One line naming the data and its date; ends every answer. */
export function sourceLine(index: EcosystemIndex = current): string {
  return `Data: CKAN ecosystem crawl by datHere (POSE project, MIT), extensions week ${index.extensions_week}, portals week ${index.portals_week}; GitHub descriptions as of ${index.built}. Supported CKAN versions, licence and publisher are not in this data.`;
}

// ---------------------------------------------------------------------------------------
// Lookup

const GITHUB_URL = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i;

/**
 * An extension by `owner/repo`, a GitHub URL, a package name ("ckanext-dcat") or a plugin name ("dcat").
 * A plugin name can belong to several repositories (forks); the most used one comes first.
 */
export function findExtensions(ref: string, index: EcosystemIndex = current): Extension[] {
  const raw = ref.trim();
  const repo = (GITHUB_URL.exec(raw)?.[1] ?? raw).toLowerCase();
  const byRepo = index.extensions.filter((e) => e.repo.toLowerCase() === repo);
  if (byRepo.length) return byRepo;
  const byPackage = index.extensions.filter((e) => e.package?.toLowerCase() === repo);
  if (byPackage.length) return byPackage;
  const byName = index.extensions.filter((e) => e.repo.split("/")[1].toLowerCase() === repo);
  if (byName.length) return byName;
  return index.extensions.filter((e) => e.plugins.some((p) => p.toLowerCase() === repo));
}

export function portalsUsing(plugin: string, index: EcosystemIndex = current): Portal[] {
  const name = plugin.trim().toLowerCase();
  return index.portals
    .filter((p) => p.plugins.some((x) => x.toLowerCase() === name))
    .sort((a, b) => (b.datasets ?? -1) - (a.datasets ?? -1) || a.name.localeCompare(b.name));
}

export function pluginInfo(name: string, index: EcosystemIndex = current): Plugin | undefined {
  const key = name.toLowerCase();
  return index.plugins.find((p) => p.name.toLowerCase() === key);
}

/** Plugins most often installed on the same portals; empty when datHere did not compute pairs for it. */
export function usedWith(plugin: string, limit: number, index: EcosystemIndex = current): { plugin: string; portals: number }[] {
  const key = plugin.toLowerCase();
  return index.pairs_top
    .filter(([a, b]) => a.toLowerCase() === key || b.toLowerCase() === key)
    .map(([a, b, n]) => ({ plugin: a.toLowerCase() === key ? b : a, portals: n }))
    .sort((x, y) => y.portals - x.portals || x.plugin.localeCompare(y.plugin))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------------------
// Search

/** Words that match nearly every extension and so say nothing about what it does. */
const STOP = new Set(["ckan", "ckanext", "extension", "extensions", "plugin", "plugins", "for", "the", "a", "an", "and", "of", "to", "in", "with"]);

export function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

export interface SearchFilters {
  upkeep?: string;
  family?: string;
  min_portals?: number;
}

export interface Hit {
  extension: Extension;
  matched: number;
  score: number;
}

/**
 * Keyword ranking: each query word scores where it appears (a plugin name or the repository name weighs more than
 * a topic, a topic more than the description), plus a bonus that grows with the log of the portals running it.
 * Hits are ordered by how many query words they match, then score, then portals, then stars. A query that is
 * exactly a plugin or package name puts that plugin's repositories first.
 */
export function search(query: string, filters: SearchFilters = {}, index: EcosystemIndex = current): Hit[] {
  const all = tokens(query);
  const words = all.filter((t) => !STOP.has(t));
  const q = words.length ? words : all;
  const exact = query.trim().toLowerCase();
  const hits: Hit[] = [];
  for (const e of index.extensions) {
    if (filters.upkeep && e.upkeep !== filters.upkeep) continue;
    if (filters.family && !e.families.some((f) => f.toLowerCase() === filters.family!.toLowerCase())) continue;
    if (filters.min_portals !== undefined && (e.portals ?? 0) < filters.min_portals) continue;
    const name = new Set(tokens(e.repo.split("/")[1]));
    const plugins = new Set(e.plugins.flatMap(tokens));
    const topics = new Set(e.topics.flatMap(tokens));
    const desc = new Set(tokens(e.description ?? ""));
    let matched = 0, score = 0;
    for (const t of q) {
      let s = 0;
      if (name.has(t)) s += 6;
      if (plugins.has(t)) s += 6;
      if (topics.has(t)) s += 4;
      if (desc.has(t)) s += 3;
      if (!s && t.length >= 4 && [...name, ...plugins, ...topics, ...desc].some((w) => w.startsWith(t))) s += 1;
      if (s) { matched++; score += s; }
    }
    if (e.plugins.some((p) => p.toLowerCase() === exact) || e.package?.toLowerCase() === exact) score += 20;
    if (!matched && !score) continue;
    // Use counts: an extension many portals run is the likelier answer among equal matches.
    score += 2 * Math.log2(1 + (e.portals ?? 0));
    hits.push({ extension: e, matched, score: Math.round(score * 10) / 10 });
  }
  return hits.sort((a, b) =>
    b.matched - a.matched || b.score - a.score || (b.extension.portals ?? 0) - (a.extension.portals ?? 0) ||
    (b.extension.stars ?? 0) - (a.extension.stars ?? 0) || a.extension.repo.localeCompare(b.extension.repo));
}

// ---------------------------------------------------------------------------------------
// README opening

export const README_FILES = ["README.md", "README.rst", "README"] as const;

export function readmeUrl(repo: string, file: string): string {
  return `https://raw.githubusercontent.com/${repo}/HEAD/${file}`;
}

/**
 * The first prose paragraph of a README: headings, badges, images, HTML, code blocks, tables, lists and
 * reStructuredText directives skipped; links reduced to their text. At most `max` characters, cut on a word.
 */
export function readmeOpening(text: string, max = 600): string | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "").replace(/```[\s\S]*?```/g, "").split("\n");
  const paragraphs: string[] = [];
  let buf: string[] = [];
  const flush = () => { if (buf.length) paragraphs.push(buf.join(" ")); buf = []; };
  // Inside a reStructuredText directive or comment (`.. image::`, `.. a comment`): its indented lines belong to it.
  let directive = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const next = (lines[i + 1] ?? "").trim();
    if (!line) { flush(); continue; }
    if (directive && /^\s/.test(lines[i])) continue;
    directive = /^\.\. /.test(line);
    const skip =
      /^#/.test(line) || /^[=\-~^*+#`'"]{3,}$/.test(line) || /^[=\-~^]{3,}$/.test(next) ||
      /^\.\. /.test(line) || /^:\w+:/.test(line) || /^\|/.test(line) || /^[-*+] |^\d+\. /.test(line) ||
      /^<\/?\w/.test(line) || /^!\[|^\[!\[/.test(line) || /^>/.test(line) || /^ {4}|^\t/.test(lines[i]);
    if (skip) { flush(); continue; }
    buf.push(line);
  }
  flush();
  const clean = (p: string) => p
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`_?/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const para = paragraphs.map(clean).find((p) => p.length >= 40 && /[a-z]{3}/i.test(p) && !/^(pip|git|cd|python|ckan) /i.test(p));
  if (!para) return null;
  if (para.length <= max) return para;
  const cut = para.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40)).trimEnd()}…`;
}
