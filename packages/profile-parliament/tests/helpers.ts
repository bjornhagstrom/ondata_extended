/**
 * Test reach for the ported tests (principle 1 in docs/test-parity.md): the original's tests
 * called `tool.execute(input)` against the live endpoints; here `execute(input, ctx)` gets an
 * engine context whose `fetch` answers from a parity recording (tests/parity/recorded: Camera
 * recorded live on 2026-11-10, Senato synthetic). Only `fetch` and DNS are stubbed; the core's
 * client, guards and host policies run for real. A request the recording does not hold fails the
 * test.
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { expect } from "vitest";
import type { EngineContext } from "@ondata-extended/profile-contract";
import { __setDnsResolverForTests, createEngine } from "@ondata-extended/core";
import { createParliamentProfile } from "../src/index.js";
import { __resetCurrentLegislatureForTests } from "../src/core/current-legislature.js";
import { replayingFetch, unusedExchanges, type RecordedExchange } from "./parity/replay.js";

export function recordedExchanges(caseId: string): RecordedExchange[] {
  const rec = JSON.parse(gunzipSync(readFileSync(join(import.meta.dirname, "parity", "recorded", `${caseId}.json.gz`))).toString("utf8")) as { exchanges: RecordedExchange[] };
  return rec.exchanges;
}

export function testContext(configSource: Record<string, string> = {}): EngineContext {
  __setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
  __resetCurrentLegislatureForTests();
  const engine = createEngine({ configPrefixes: ["PARLIAMENT"], configSource: { VITEST: "true", ...configSource }, cacheOrigin: "https://parliament-test.internal" });
  return engine.contextFor(createParliamentProfile(), {});
}

/**
 * Run `fn` with `fetch` answering from the recording of `caseId`; afterwards every request made
 * must have been recorded, and every recorded request made.
 */
export async function withRecording<T>(caseId: string, fn: (ctx: EngineContext) => Promise<T>): Promise<T> {
  const exchanges = recordedExchanges(caseId);
  const misses: string[] = [];
  const keys: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = replayingFetch(exchanges, misses, keys);
  try {
    const out = await fn(testContext());
    expect([...misses, ...unusedExchanges(exchanges, keys)]).toEqual([]);
    return out;
  } finally {
    globalThis.fetch = realFetch;
    __setDnsResolverForTests(null);
  }
}
