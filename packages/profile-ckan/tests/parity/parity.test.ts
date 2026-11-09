/**
 * Black-box parity (docs/test-parity.md, principle 3). For every recorded case:
 *  1. ondata at 09e8cdc, replayed, must reproduce its recorded observation exactly: proves the
 *     harness is deterministic (a failure here is a harness problem, not a port problem);
 *  2. our CKAN profile, replayed from the same exchanges, must produce the same observation, for
 *     every tool, resource and prompt it already registers. Not yet registered: listed as todo.
 * An observation is the text, the error flag, and structuredContent / resource MIME types /
 * prompt roles. Both sides must send exactly the recorded requests (same keys, same count, same
 * identity and encoding headers). Time is frozen at the recording time (`Date` only).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import type { ParityCase } from "./cases.js";
import { ONDATA_COMMIT, ondataAvailable, ondataClient, type McpCaller, type Observed } from "./ondata.js";
import { replayingFetch, unusedExchanges, type RecordedExchange } from "./replay.js";
import { ourClient, implemented } from "./ours.js";

const DIR = join(import.meta.dirname, "recorded");
interface Recording { case: ParityCase; ondata: string; recordedAt: string; output: Observed; exchanges: RecordedExchange[] }
const recordings: Recording[] = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => f.endsWith(".json.gz")).sort().map((f) => JSON.parse(gunzipSync(readFileSync(join(DIR, f))).toString("utf8")))
  : [];

async function run(caller: McpCaller, c: ParityCase): Promise<Observed> {
  try {
    return c.kind === "tool" ? await caller.callTool(c.name, c.args)
      : c.kind === "resource" ? await caller.readResource(c.uri)
      : await caller.getPrompt(c.name, c.args);
  } catch (error) {
    return { text: `THROWN: ${error instanceof Error ? error.message : String(error)}`, isError: true, extra: null };
  }
}

async function replay(rec: Recording, caller: McpCaller) {
  const misses: string[] = [];
  const keys: string[] = [];
  const realFetch = globalThis.fetch;
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(rec.recordedAt) });
  globalThis.fetch = replayingFetch(rec.exchanges, misses, keys);
  try {
    const output = await run(caller, rec.case);
    return { output, misses: [...misses, ...unusedExchanges(rec.exchanges, keys)] };
  } finally {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  }
}

afterEach(() => vi.useRealTimers());

describe.runIf(ondataAvailable() && recordings.length > 0)("parity with ondata/ckan-mcp-server 09e8cdc", () => {
  describe("ondata replays its own recording exactly (harness determinism)", () => {
    for (const rec of recordings) {
      it(rec.case.id, async () => {
        expect(rec.ondata).toBe(ONDATA_COMMIT);
        vi.resetModules(); // fresh module state per case, as when recording
        const ondata = await ondataClient();
        ondata.setDnsResolver(async () => [{ address: "93.184.216.34", family: 4 }]);
        ondata.resetState();
        try {
          const { output, misses } = await replay(rec, ondata);
          expect(misses).toEqual([]);
          expect(output).toEqual(rec.output);
        } finally {
          ondata.setDnsResolver(null);
        }
      });
    }
  });

  describe("our CKAN profile gives the same observation", () => {
    for (const rec of recordings) {
      (implemented(rec.case) ? it : it.todo)(rec.case.id, async () => {
        expect(rec.ondata).toBe(ONDATA_COMMIT);
        vi.resetModules();
        const ours = await ourClient();
        const { output, misses } = await replay(rec, ours);
        expect(misses).toEqual([]);
        expect(output).toEqual(rec.output);
      });
    }
  });
});
