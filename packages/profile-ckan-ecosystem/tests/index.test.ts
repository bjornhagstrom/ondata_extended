/**
 * The committed index (data/index.json): its shape, that it is internally consistent, and that it holds nothing it
 * should not. Guards a rebuild that silently drops a field or a source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getIndex } from "../src/data.js";

const RAW = readFileSync(join(import.meta.dirname, "..", "data", "index.json"), "utf8");
const index = getIndex();

describe("data/index.json", () => {
  it("names its source at a pinned commit and its dates", () => {
    expect(index.source.repository).toBe("dathere/pose-ckanext-metadata");
    expect(index.source.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const d of [index.built, index.extensions_week, index.portals_week, index.dashboard_generated]) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(index.about).toMatch(/datHere.*MIT/);
  });

  it("has the extensions, plugins, portals and pairs a rebuild must keep", () => {
    expect(index.extensions.length).toBeGreaterThan(1000);
    expect(index.plugins.length).toBeGreaterThan(1000);
    expect(index.portals.length).toBeGreaterThan(1000);
    expect(index.pairs_top.length).toBeGreaterThan(100);
    expect(index.extensions.filter((e) => e.description).length).toBeGreaterThan(800);
    expect(index.extensions.filter((e) => (e.portals ?? 0) > 0).length).toBeGreaterThan(300);
  });

  it("every extension has a repository name and a GitHub URL; repositories are unique", () => {
    const repos = index.extensions.map((e) => e.repo.toLowerCase());
    expect(new Set(repos).size).toBe(repos.length);
    for (const e of index.extensions) {
      expect(e.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(e.url).toMatch(/^https:\/\/github\.com\//);
    }
  });

  it("portal plugin names are bare names (no brackets or quotes from the crawl's list syntax)", () => {
    for (const p of index.portals) for (const name of p.plugins) expect(name).toMatch(/^[\w.:-]+$/);
    // The crawl's count for the most used plugin and the portals listing it agree.
    const top = index.plugins.slice().sort((a, b) => b.portals - a.portals)[0];
    expect(index.portals.filter((p) => p.plugins.includes(top.name)).length).toBe(top.portals);
  });

  it("stable facts: ckanext-dcat provides dcat, is run by portals, and is in the dcat family", () => {
    const dcat = index.extensions.find((e) => e.repo === "ckan/ckanext-dcat")!;
    expect(dcat.plugins).toContain("dcat");
    expect(dcat.families).toContain("ckanext-dcat");
    expect(dcat.portals).toBeGreaterThan(100);
  });

  it("holds no token or e-mail address, and no field beyond the extension record (no README text)", () => {
    expect(RAW).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/);
    expect(RAW).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    const fields = ["repo", "url", "package", "plugins", "families", "description", "topics", "stars", "forks", "contributors",
      "open_issues", "releases", "latest_release", "release_date", "pushed_at", "archived", "fork_of", "portals", "portals_pct",
      "upkeep", "forks_ahead", "on_github"].sort();
    for (const e of index.extensions) expect(Object.keys(e).sort()).toEqual(fields);
    for (const e of index.extensions) expect((e.description ?? "").length).toBeLessThanOrEqual(400);
  });
});
