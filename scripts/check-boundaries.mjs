#!/usr/bin/env node
/**
 * Mechanical check of the build rules (architecture proposal, section 9):
 *  1. The core names no backend: no backend, profile or catalog words in packages/core/src.
 *  2. The core and the contract never import a profile.
 *  3. A profile never imports another profile.
 *  4. The core's Workers-reachable code imports no Node builtin statically (only
 *     packages/core/src/node/ may; elsewhere use the string-concatenated dynamic import).
 * Exits non-zero with one line per violation.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const PACKAGES = join(ROOT, "packages");

// Substrings, not words: `ckan_package_show`, `CKAN_ALLOWED_DOMAINS` and `makeCkanRequest`
// must all be caught. A line naming the project the core comes from (provenance) is exempt.
const FORBIDDEN_IN_CORE = /(ckan|skos|tematres|solr|dcat|vocab|thesaur|portals?\.json|dati\.gov|data\.europa|begrepp\.hagstrom|camera|senato|parliament|parlament)/i;
// Exempt only lines that cite the origin; `@ondata-extended` imports do not count.
const PROVENANCE = /ondata\/ckan-mcp-server|ondata's/i;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist") continue;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

// Static imports, and dynamic imports of a whole string literal. A specifier assembled at
// runtime (`import("node:" + "dns")`) is the allowed way to keep a builtin out of the
// Workers bundle, so it is not reported.
const importsOf = (text) => [
  ...[...text.matchAll(/(?:from\s+|import\s+)["']([^"']+)["']/g)].map((m) => m[1]),
  ...[...text.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
];

const NODE_ONLY = new Set([...builtinModules, "express", "undici"]);

const problems = [];
const packages = readdirSync(PACKAGES).filter((n) => statSync(join(PACKAGES, n)).isDirectory());

for (const pkg of packages) {
  // Source and tests (fixtures included): the rule covers both.
  const files = [];
  for (const dir of ["src", "tests"]) {
    try { files.push(...walk(join(PACKAGES, pkg, dir))); } catch { /* absent */ }
  }
  for (const file of files) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    const imports = importsOf(text);

    if (pkg === "core" || pkg === "profile-contract") {
      if (pkg === "core") {
        lines.forEach((line, i) => {
          const m = line.match(FORBIDDEN_IN_CORE);
          // The provenance line naming the original project is allowed.
          if (m && !PROVENANCE.test(line)) problems.push(`${rel}:${i + 1}: backend word "${m[0]}" in the core`);
        });
      }
      for (const spec of imports) {
        if (/@ondata-extended\/profile-(?!contract)/.test(spec)) problems.push(`${rel}: imports a profile (${spec})`);
      }
    }

    if (pkg.startsWith("profile-") && pkg !== "profile-contract") {
      for (const spec of imports) {
        const m = spec.match(/@ondata-extended\/(profile-[\w-]+)/);
        if (m && m[1] !== "profile-contract" && m[1] !== pkg) problems.push(`${rel}: profile ${pkg} imports ${m[1]}`);
      }
    }

    // Workers-reachable core code: src outside src/node. Tests run on Node and may import builtins.
    if (pkg === "core" && rel.split(sep).includes("src") && !rel.split(sep).includes("node")) {
      for (const spec of imports) {
        if (/^node:/.test(spec) || NODE_ONLY.has(spec.split("/")[0])) {
          problems.push(`${rel}: static import of Node module "${spec}" outside packages/core/src/node`);
        }
      }
    }
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} boundary violation(s).`);
  process.exit(1);
}
console.log(`Boundaries OK (${packages.length} packages checked).`);
