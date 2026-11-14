#!/usr/bin/env node
/**
 * Builds packages/profile-ckan-ecosystem/data/index.json, the data the CKAN ecosystem profile serves.
 *
 * Sources, all read at one pinned commit of dathere/pose-ckanext-metadata (MIT, the CKAN Ecosystem
 * Catalog's open pipeline data), plus each extension repository's GitHub description and topics:
 *   dashboard-data/dashboard.json        per package: portals running it, upkeep; per plugin: usage, family; pairs
 *   extensions-history/<latest>.csv      per repository: stars, forks, releases, open issues, contributors
 *   extensions-activity/github_activity.csv   per repository: last push, archived, fork
 *   extensions-activity/entry_points.csv      repository -> plugin names
 *   sites-history/<latest>.csv           per portal: CKAN version, datasets, plugins
 *   GitHub GraphQL                       description, topics (needs GITHUB_TOKEN; read here, never written out)
 *
 * A maintainer's build tool, not part of the server: it calls GitHub directly rather than through the core
 * HTTP client (docs/DECISIONS.md, 2026-11-14). It fails loudly when a field it reads is missing, so a change in
 * datHere's file layout stops the build instead of producing a quietly wrong index.
 *
 *   GITHUB_TOKEN=$(gh auth token) node scripts/build-ckan-ecosystem-index.mjs
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const OUT = join(ROOT, "packages/profile-ckan-ecosystem/data/index.json");
const REPO = "dathere/pose-ckanext-metadata";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) fail("GITHUB_TOKEN is not set (GITHUB_TOKEN=$(gh auth token) ...)");

function fail(message) {
  console.error(`build-ckan-ecosystem-index: ${message}`);
  process.exit(1);
}

async function get(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { "User-Agent": "ondata-extended-index-build", ...(init.headers ?? {}) } });
  if (!res.ok) fail(`${url}: HTTP ${res.status}`);
  return res;
}
const api = (path) => get(`https://api.github.com/${path}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" } }).then((r) => r.json());

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return { header, rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))) };
}

function requireColumns(name, { header }, columns) {
  const missing = columns.filter((c) => !header.includes(c));
  if (missing.length) fail(`${name}: missing columns ${missing.join(", ")} (datHere changed the layout?)`);
}

function requireKeys(name, object, keys) {
  const missing = keys.filter((k) => !(k in object));
  if (missing.length) fail(`${name}: missing keys ${missing.join(", ")} (datHere changed the layout?)`);
}

const num = (v) => (v === "" || v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));

// ---- datHere's files, at one pinned commit
const commit = (await api(`repos/${REPO}/commits/main`)).sha;
const tree = (await api(`repos/${REPO}/git/trees/${commit}?recursive=1`)).tree.map((t) => t.path);
const latest = (dir) => {
  const files = tree.filter((p) => new RegExp(`^${dir}/\\d{4}-\\d{2}-\\d{2}\\.csv$`).test(p)).sort();
  if (!files.length) fail(`no ${dir}/<date>.csv at ${commit}`);
  return files[files.length - 1];
};
const raw = (path) => get(`https://raw.githubusercontent.com/${REPO}/${commit}/${path}`).then((r) => r.text());

const FILES = {
  dashboard: "dashboard-data/dashboard.json",
  extensions: latest("extensions-history"),
  activity: "extensions-activity/github_activity.csv",
  entryPoints: "extensions-activity/entry_points.csv",
  sites: latest("sites-history")
};

const dashboard = JSON.parse(await raw(FILES.dashboard));
requireKeys("dashboard.json", dashboard, ["generated", "exts", "pairs", "instances", "ext_rows", "ext_meta"]);
requireKeys("dashboard.json ext_rows[0]", dashboard.ext_rows[0], ["p", "r", "u", "i", "pct", "s", "f", "c", "up", "ahead"]);
requireKeys("dashboard.json exts[0]", dashboard.exts[0], ["name", "count", "pct", "core", "family"]);
requireKeys("dashboard.json instances[0]", dashboard.instances[0], ["n", "u", "st"]);
requireKeys("dashboard.json pairs[0]", dashboard.pairs[0], ["a", "b", "n"]);
requireKeys("dashboard.json ext_meta", dashboard.ext_meta, ["reporting"]);

const extCsv = parseCsv(await raw(FILES.extensions));
requireColumns(FILES.extensions, extCsv, ["repository_name", "url", "forks_count", "total_releases", "latest_release", "release_date", "stars", "open_issues", "contributors_count"]);
const actCsv = parseCsv(await raw(FILES.activity));
requireColumns(FILES.activity, actCsv, ["repository_name", "pushed_at", "is_archived", "is_fork", "parent"]);
const epCsv = parseCsv(await raw(FILES.entryPoints));
requireColumns(FILES.entryPoints, epCsv, ["repository_name", "plugin"]);
const sitesCsv = parseCsv(await raw(FILES.sites));
requireColumns(FILES.sites, sitesCsv, ["tstamp", "name", "url", "num_datasets", "ckan_version", "extensions"]);

// ---- GitHub descriptions and topics, 50 repositories per GraphQL call
const repoNames = [...new Set([...extCsv.rows.map((r) => r.repository_name), ...dashboard.ext_rows.map((r) => r.r)])]
  .filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
const github = new Map();
let notFound = 0;
for (let i = 0; i < repoNames.length; i += 50) {
  const chunk = repoNames.slice(i, i + 50);
  const query = "query{" + chunk.map((full, j) => {
    const [owner, name] = full.split("/");
    return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner description repositoryTopics(first: 10) { nodes { topic { name } } } }`;
  }).join(" ") + "}";
  const res = await get("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query })
  }).then((r) => r.json());
  // GraphQL answers 200 with `errors` for a rate limit or a partial failure: fail, rather than record 50 repositories
  // as "not on GitHub". NOT_FOUND (a renamed or deleted repository) is expected and counted.
  const errors = res.errors ?? [];
  const fatal = errors.filter((e) => e.type !== "NOT_FOUND");
  if (fatal.length || !res.data) fail(`GitHub GraphQL: ${fatal.map((e) => e.type ?? e.message).join(", ") || "no data"}`);
  notFound += errors.length;
  chunk.forEach((full, j) => {
    const r = res.data?.[`r${j}`];
    if (r) github.set(full.toLowerCase(), { description: (r.description ?? "").trim(), topics: r.repositoryTopics.nodes.map((n) => n.topic.name) });
  });
}

// ---- Extensions: one record per repository
const lc = (s) => s.toLowerCase();
const extByRepo = new Map(extCsv.rows.map((r) => [lc(r.repository_name), r]));
const actByRepo = new Map(actCsv.rows.map((r) => [lc(r.repository_name), r]));
const rowByRepo = new Map(dashboard.ext_rows.map((r) => [lc(r.r), r]));
const pluginsByRepo = new Map();
for (const { repository_name, plugin } of epCsv.rows) {
  if (!plugin) continue;
  const key = lc(repository_name);
  pluginsByRepo.set(key, [...new Set([...(pluginsByRepo.get(key) ?? []), plugin])].sort());
}
const familyOf = new Map(dashboard.exts.filter((e) => e.family).map((e) => [e.name, e.family]));
const releaseText = (v) => (v && v !== "No releases" ? v : null);

const extensions = repoNames.map((full) => {
  const key = lc(full);
  const e = extByRepo.get(key) ?? {};
  const a = actByRepo.get(key) ?? {};
  const d = rowByRepo.get(key);
  const g = github.get(key);
  const plugins = pluginsByRepo.get(key) ?? [];
  const families = [...new Set(plugins.map((p) => familyOf.get(p)).filter(Boolean))].sort();
  return {
    repo: e.repository_name || d?.r || full,
    url: e.url || d?.u || `https://github.com/${full}`,
    package: d?.p ?? null,
    plugins,
    families,
    description: g?.description || null,
    topics: g?.topics ?? [],
    stars: num(e.stars) ?? d?.s ?? null,
    forks: num(e.forks_count) ?? d?.f ?? null,
    contributors: num(e.contributors_count) ?? d?.c ?? null,
    open_issues: num(e.open_issues),
    releases: num(e.total_releases),
    latest_release: releaseText(e.latest_release),
    release_date: releaseText(e.release_date),
    pushed_at: a.pushed_at || null,
    archived: a.is_archived === "true",
    fork_of: a.is_fork === "true" && a.parent ? a.parent : null,
    portals: d ? d.i : null,
    portals_pct: d ? d.pct : null,
    upkeep: d ? d.up : null,
    forks_ahead: d ? d.ahead : null,
    on_github: Boolean(g)
  };
}).sort((x, y) => (y.portals ?? 0) - (x.portals ?? 0) || (y.stars ?? 0) - (x.stars ?? 0) || x.repo.localeCompare(y.repo));

// ---- Portals, from the latest weekly crawl
/**
 * The crawl writes a portal's plugins as a JSON-like list (`["dcat", "xloader"]`) or, for a few portals, as one
 * quoted space-separated string (`"envvars image_view"`). Either way: names only, no brackets or quotes.
 */
function pluginList(value) {
  if (!value) return [];
  return [...new Set(value.split(/[\s,|]+/).map((p) => p.replace(/^[\[\]"']+|[\[\]"']+$/g, "")).filter((p) => /^[\w.:-]+$/.test(p)))].sort();
}
const statusOf = new Map(dashboard.instances.map((i) => [i.n, i.st ?? null]));
const portals = sitesCsv.rows.map((r) => ({
  name: r.name,
  url: r.url,
  ckan_version: r.ckan_version || null,
  datasets: num(r.num_datasets),
  status: statusOf.get(r.name) ?? null,
  plugins: pluginList(r.extensions)
})).sort((x, y) => x.name.localeCompare(y.name));

const plugins = dashboard.exts.map((e) => ({ name: e.name, portals: e.count, pct: e.pct, core: Boolean(e.core), family: e.family ?? null }));

const index = {
  about: "CKAN ecosystem data by datHere (POSE project, https://github.com/dathere/pose-ckanext-metadata, MIT), with GitHub repository descriptions and topics. Built by scripts/build-ckan-ecosystem-index.mjs.",
  built: new Date().toISOString().slice(0, 10),
  source: { repository: REPO, commit, files: FILES },
  dashboard_generated: dashboard.generated,
  extensions_week: FILES.extensions.match(/\d{4}-\d{2}-\d{2}/)[0],
  portals_week: FILES.sites.match(/\d{4}-\d{2}-\d{2}/)[0],
  reporting_portals: dashboard.ext_meta.reporting,
  pairs_top: dashboard.pairs.map((p) => [p.a, p.b, p.n]),
  plugins,
  extensions,
  portals
};

writeFileSync(OUT, JSON.stringify(index) + "\n");
const withText = extensions.filter((e) => e.description).length;
console.log(`wrote ${OUT}: ${extensions.length} extensions (${withText} with a description, ${notFound} not found on GitHub), ${plugins.length} plugins, ${portals.length} portals, ${index.pairs_top.length} pairs; commit ${commit.slice(0, 7)}; ${(JSON.stringify(index).length / 1024).toFixed(0)} KB`);
