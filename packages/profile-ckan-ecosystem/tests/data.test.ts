/** The pure functions over the index: lookup, search, co-installation, README openings. No engine, no network. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findExtensions, portalsUsing, readmeOpening, readmeUrl, search, tokens, usedWith } from "../src/data.js";
import { SMALL_INDEX as I } from "./small-index.js";

const FIX = join(import.meta.dirname, "fixtures", "github");

describe("findExtensions", () => {
  it("finds by owner/repo, GitHub URL, package, repository name and plugin, case-insensitively", () => {
    expect(findExtensions("CKAN/ckanext-dcat", I).map((e) => e.repo)).toEqual(["ckan/ckanext-dcat"]);
    expect(findExtensions("https://github.com/ckan/ckanext-dcat.git", I).map((e) => e.repo)).toEqual(["ckan/ckanext-dcat"]);
    expect(findExtensions("https://github.com/ckan/ckanext-dcat/", I).map((e) => e.repo)).toEqual(["ckan/ckanext-dcat"]);
    expect(findExtensions("ckanext-scheming", I).map((e) => e.repo)).toEqual(["ckan/ckanext-scheming"]);
    expect(findExtensions("ckanext-harvest-basket", I).map((e) => e.repo)).toEqual(["acme/ckanext-harvest-basket"]);
  });

  it("a plugin several repositories provide gives all of them, in index order (most used first)", () => {
    expect(findExtensions("dcat_rdf_harvester", I).map((e) => e.repo)).toEqual(["ckan/ckanext-dcat", "someone/ckanext-dcat-fork"]);
  });

  it("an unknown or path-like reference finds nothing", () => {
    expect(findExtensions("nope/nothing", I)).toEqual([]);
    expect(findExtensions("../../etc/passwd", I)).toEqual([]);
  });
});

describe("portals", () => {
  it("portalsUsing lists exact plugin matches, largest first, unknown sizes last", () => {
    expect(portalsUsing("DCAT", I).map((p) => p.name)).toEqual(["big-portal", "mid-portal", "small-portal"]);
    expect(portalsUsing("rare_plugin", I).map((p) => p.name)).toEqual(["quiet-portal"]);
    expect(portalsUsing("scheming", I)).toEqual([]);
  });

  it("usedWith gives the plugins installed together, most first, and nothing outside the computed pairs", () => {
    expect(usedWith("dcat", 5, I)).toEqual([{ plugin: "image_view", portals: 3 }, { plugin: "scheming_datasets", portals: 2 }]);
    expect(usedWith("dcat", 1, I)).toEqual([{ plugin: "image_view", portals: 3 }]);
    expect(usedWith("rare_plugin", 5, I)).toEqual([]);
  });
});

describe("search", () => {
  it("tokens lower-cases and splits on anything but letters and digits", () => {
    expect(tokens("Harvest DCAT-AP, s3!")).toEqual(["harvest", "dcat", "ap", "s3"]);
  });

  it("ranks the extension matching more words first, then by score and use", () => {
    const hits = search("harvest dcat", {}, I).map((h) => h.extension.repo);
    // dcat matches both words: 'dcat' as a plugin, 'harvest' in its description.
    expect(hits[0]).toBe("ckan/ckanext-dcat");
    expect(hits).toContain("acme/ckanext-harvest-basket");
    expect(hits.indexOf("ckan/ckanext-dcat")).toBeLessThan(hits.indexOf("someone/ckanext-dcat-fork"));
  });

  it("an exact plugin or package name puts its repositories first", () => {
    expect(search("scheming_datasets", {}, I)[0].extension.repo).toBe("ckan/ckanext-scheming");
    expect(search("ckanext-dcat", {}, I)[0].extension.repo).toBe("ckan/ckanext-dcat");
  });

  it("ignores words that match every extension, unless they are all there is", () => {
    expect(search("ckan extension for schemas", {}, I).map((h) => h.extension.repo)).toEqual(["ckan/ckanext-scheming"]);
    expect(search("ckan", {}, I).length).toBeGreaterThan(0);
  });

  it("filters by upkeep, family and minimum portals", () => {
    expect(search("dcat", { upkeep: "still" }, I).map((h) => h.extension.repo)).toEqual(["someone/ckanext-dcat-fork"]);
    expect(search("dcat", { family: "CKANEXT-DCAT" }, I).map((h) => h.extension.repo)).toEqual(["ckan/ckanext-dcat"]);
    expect(search("dcat", { min_portals: 1 }, I).map((h) => h.extension.repo)).toEqual(["ckan/ckanext-dcat", "acme/ckanext-harvest-basket"]);
    expect(search("dcat", { min_portals: 2 }, I).map((h) => h.extension.repo)).toEqual(["ckan/ckanext-dcat"]);
  });

  it("finds nothing for words no extension has", () => {
    expect(search("blockchain", {}, I)).toEqual([]);
  });
});

describe("README openings", () => {
  it("builds the raw URL from the repository and file", () => {
    expect(readmeUrl("ckan/ckanext-qa", "README.rst")).toBe("https://raw.githubusercontent.com/ckan/ckanext-qa/HEAD/README.rst");
  });

  it("takes the first prose paragraph of a recorded reStructuredText README, past its comment and badge directives", () => {
    expect(readmeOpening(readFileSync(join(FIX, "qa-readme-rst.body"), "utf8")))
      .toMatch(/^The ckanext-qa extension will check each of your dataset resources in CKAN and give them an 'openness score'/);
  });

  it("skips headings, badges, HTML, lists, code, tables and install commands; keeps link text", () => {
    const md = [
      "# ckanext-x", "", "[![CI](https://x/badge.svg)](https://x)", "", "<p align=center><img src=x></p>", "",
      "- a list item that is long enough to count as text", "", "```", "a code block line that is long enough", "```", "",
      "| a | table |", "", "pip install ckanext-x and other things to do", "",
      "This **extension** adds [a map view](https://example.org) to resources with geographic data.", "", "Second paragraph."
    ].join("\n");
    expect(readmeOpening(md)).toBe("This extension adds a map view to resources with geographic data.");
  });

  it("cuts a long paragraph on a word, and gives null when there is no prose", () => {
    const long = `${"word ".repeat(200)}end`;
    const cut = readmeOpening(long, 100)!;
    expect(cut.length).toBeLessThanOrEqual(101);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toMatch(/wor…$/);
    expect(readmeOpening("# Title\n\n```\ncode\n```\n")).toBeNull();
  });
});
