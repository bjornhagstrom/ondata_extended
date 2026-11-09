#!/usr/bin/env node
/**
 * Proves the core and profiles still bundle for Cloudflare Workers: esbuild, browser
 * platform, ESM, minified (ondata's build:worker settings). Fails if the build fails or if
 * the bundle imports a Node builtin statically. Prints the bundle size for the record.
 */
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
// The probe (core + profile alone) and every real Worker entry of a deployment package.
const ENTRIES = [
  "scripts/fixtures/worker-bundle-entry.ts",
  "packages/host-vocab/src/worker.ts"
];
const out = mkdtempSync(join(tmpdir(), "worker-bundle-"));
try {
  for (const entry of ENTRIES) {
  await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    minify: true,
    outfile: join(out, "worker.js"),
    logLevel: "error"
  });
  const code = readFileSync(join(out, "worker.js"), "utf8");
  const staticNode = code.match(/(?:from|import)\s*["'](node:[^"']+|express|undici)["']/g);
  if (staticNode) {
    console.error(`${entry}: Worker bundle imports Node-only modules statically: ${[...new Set(staticNode)].join(", ")}`);
    process.exit(1);
  }
  console.log(`Worker bundle OK (${entry}): ${(code.length / 1024).toFixed(0)} KiB minified.`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
