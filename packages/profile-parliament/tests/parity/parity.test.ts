/**
 * Black-box parity with ondata's italianparliament-mcp at fd46810 (docs/parliament-port.md). For
 * every recorded case:
 *  1. the original, replayed, must reproduce its recorded observation exactly: proves the harness
 *     is deterministic (a failure here is a harness problem, not a port problem);
 *  2. our profile, replayed from the same exchanges, must produce the same observation.
 * An observation is the text, the error flag and `structuredContent`. Both sides must send exactly
 * the recorded requests (same URL, same number of times, same User-Agent and Accept). `Date` is
 * frozen at the recording time. Also: tools/list entries of the ported tools equal the original's.
 *
 * Runs when PARLIAMENT_REPO (or the default path in original.ts) holds the original at fd46810
 * with its dependencies installed; skipped otherwise.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import type { ParityCase } from "./cases.js";
import { PARLIAMENT_COMMIT, originalAvailable, originalClient, type McpCaller, type Observed } from "./original.js";
import { replayingFetch, unusedExchanges, type RecordedExchange } from "./replay.js";
import { ourClient } from "./ours.js";

const DIR = join(import.meta.dirname, "recorded");
interface Recording { case: Omit<ParityCase, "synthetic">; original: string; recordedAt: string; output: Observed; exchanges: RecordedExchange[] }
const recordings: Recording[] = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => f.endsWith(".json.gz")).sort().map((f) => JSON.parse(gunzipSync(readFileSync(join(DIR, f))).toString("utf8")))
  : [];

/** The tools this profile ports (round 1). */
const PORTED = ["deputies", "search", "legislatures", "sparql"];

async function replay(rec: Recording, caller: McpCaller) {
  const misses: string[] = [];
  const keys: string[] = [];
  const realFetch = globalThis.fetch;
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(rec.recordedAt) });
  globalThis.fetch = replayingFetch(rec.exchanges, misses, keys);
  try {
    let output: Observed;
    try {
      output = await caller.callTool(rec.case.name, rec.case.args);
    } catch (error) {
      output = { text: `THROWN: ${error instanceof Error ? error.message : String(error)}`, isError: true, extra: null };
    }
    return { output, misses: [...misses, ...unusedExchanges(rec.exchanges, keys)] };
  } finally {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  }
}

afterEach(() => vi.useRealTimers());

/**
 * Cases where our observation differs from the original's on purpose. Each states exactly how it
 * may differ, so the rest of the observation is still checked.
 *
 * P1 (as D8 for CKAN): the MCP SDK (1.32.2 here, 1.27.1 in the original) words argument validation
 * errors before any tool code runs: one line per issue, "message at path", instead of the issues as
 * a JSON array. Same prefix, same issues, same messages.
 */
const DEVIATIONS: Record<string, { id: string; check(ours: Observed, theirs: Observed): void }> = {};
for (const caseId of ["offline-deputies-bad-date", "offline-search-bad-chamber", "offline-sparql-limit-range"]) {
  DEVIATIONS[caseId] = {
    id: "P1",
    check(ours, theirs) {
      const prefix = /^MCP error -32602: Input validation error: Invalid arguments for tool \w+: /;
      const head = theirs.text.match(prefix)?.[0];
      expect(head).toBeDefined();
      expect(theirs.isError).toBe(true);
      expect(ours.isError).toBe(true);
      expect(ours.extra).toEqual(theirs.extra);
      expect(ours.text.startsWith(head!)).toBe(true);
      const issues = JSON.parse(theirs.text.slice(head!.length)) as { message: string; path: (string | number)[] }[];
      expect(ours.text.slice(head!.length)).toBe(issues.map((i) => (i.path.length ? `${i.message} at ${i.path.join(".")}` : i.message)).join("\n"));
    }
  };
}

describe.runIf(originalAvailable() && recordings.length > 0)("parity with ondata/italianparliament-mcp fd46810", () => {
  it("every recording is from fd46810, and every Senato exchange is synthetic", () => {
    for (const rec of recordings) {
      expect(rec.original).toBe(PARLIAMENT_COMMIT);
      for (const e of rec.exchanges) {
        const host = new URL(e.key.split(" ")[1]).hostname;
        if (/(^|\.)senato\.it$/.test(host)) expect({ case: rec.case.id, synthetic: e.synthetic }).toEqual({ case: rec.case.id, synthetic: true });
      }
    }
  });

  describe("the original replays its own recording exactly (harness determinism)", () => {
    for (const rec of recordings) {
      it(rec.case.id, async () => {
        vi.resetModules(); // fresh module state per case, as when recording
        const original = await originalClient();
        const { output, misses } = await replay(rec, original);
        expect(misses).toEqual([]);
        expect(output).toEqual(rec.output);
      }, 30000);
    }
  });

  // What a client is told before it calls anything: name, title, description with examples,
  // argument schema (as JSON Schema), annotations. Every tool we register must equal the original's.
  it("tools/list: the ported tools, each described identically", async () => {
    vi.resetModules();
    const theirs = await (await originalClient()).listTools();
    vi.resetModules();
    const ours = await (await ourClient()).listTools();
    expect(Object.keys(ours).sort()).toEqual([...PORTED].sort());
    for (const [name, entry] of Object.entries(ours)) {
      expect({ name, entry }).toEqual({ name, entry: theirs[name] });
    }
    // Registration order of the ported tools follows the original's.
    expect(Object.keys(ours)).toEqual(Object.keys(theirs).filter((n) => PORTED.includes(n)));
  });

  describe("our profile gives the same observation", () => {
    for (const rec of recordings) {
      it(rec.case.id, async () => {
        vi.resetModules();
        const ours = await ourClient();
        const { output, misses } = await replay(rec, ours);
        expect(misses).toEqual([]);
        const deviation = DEVIATIONS[rec.case.id];
        if (deviation) deviation.check(output, rec.output);
        else expect(output).toEqual(rec.output);
      }, 30000);
    }
  });
});
