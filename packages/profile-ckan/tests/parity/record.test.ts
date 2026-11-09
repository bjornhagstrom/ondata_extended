/**
 * RECORDING (live network): runs only with CKAN_PARITY_RECORD=1. Calls ondata/ckan-mcp-server
 * (09e8cdc, fetch path) against the real portals once per case, saving every upstream exchange
 * and ondata's own output, the reference our profile must match. Sequential and slow on
 * purpose; a pause between cases keeps the load on each portal small.
 *
 *   CKAN_PARITY_RECORD=1 npx vitest run packages/profile-ckan/tests/parity/record.test.ts
 *   CKAN_PARITY_RECORD=1 CKAN_PARITY_ONLY=package-show npx vitest run ... (one case or prefix)
 */

import { describe, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { allCases } from "./cases.js";
import { ONDATA_COMMIT, ondataAvailable, ondataClient, type Observed } from "./ondata.js";
import { recordingFetch, type RecordedExchange } from "./replay.js";

const RECORD = process.env.CKAN_PARITY_RECORD === "1";
const ONLY = process.env.CKAN_PARITY_ONLY;
export const RECORDED_DIR = join(import.meta.dirname, "recorded");

describe.runIf(RECORD && ondataAvailable())("record parity cases from live portals", () => {
  it("records every case", async () => {
    mkdirSync(RECORDED_DIR, { recursive: true });
    const realFetch = globalThis.fetch;
    const cases = allCases().filter((c) => !ONLY || c.id.startsWith(ONLY));
    try {
      for (const c of cases) {
        const log: RecordedExchange[] = [];
        // Fresh modules per case: ondata keeps per-portal state at module level (e.g. the Solr
        // parser probe in src/tools/package.ts:21, not exported), which would make a case's
        // requests depend on the cases before it.
        vi.resetModules();
        const ondata = await ondataClient();
        ondata.resetState();
        globalThis.fetch = recordingFetch(realFetch, log);
        const recordedAt = new Date().toISOString();
        let output: Observed;
        try {
          output = c.kind === "tool" ? await ondata.callTool(c.name, c.args)
            : c.kind === "resource" ? await ondata.readResource(c.uri)
            : await ondata.getPrompt(c.name, c.args);
        } catch (error) {
          output = { text: `THROWN: ${error instanceof Error ? error.message : String(error)}`, isError: true, extra: null };
        } finally {
          globalThis.fetch = realFetch;
        }
        // gzip: the portal registry alone is 28 MB as JSON.
        writeFileSync(join(RECORDED_DIR, `${c.id}.json.gz`), gzipSync(JSON.stringify({ case: c, ondata: ONDATA_COMMIT, recordedAt, output, exchanges: log })));
        console.log(`${c.id}: ${log.length} request(s), ${output.isError ? "error" : "ok"}, ${output.text.length} chars`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 30 * 60 * 1000);
});
