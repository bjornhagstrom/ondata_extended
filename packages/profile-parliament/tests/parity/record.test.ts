/**
 * RECORDING: runs only with PARLIAMENT_PARITY_RECORD=1. Calls the original (fd46810) once per case
 * and saves every upstream exchange and the original's own output, the reference our profile must
 * match.
 *
 * Network rules, enforced here and not left to the cases:
 * - Only dati.camera.it may be reached live, one request at a time, at least 2 s apart; a request
 *   already answered in this run is served from that answer, not sent again.
 * - Every other host is refused unless the case answers it synthetically. A senato.it host is
 *   NEVER reached (Senato blocks the IP permanently): its answers are always synthetic.
 *
 *   PARLIAMENT_PARITY_RECORD=1 PARLIAMENT_REPO=... npx vitest run packages/profile-parliament/tests/parity/record.test.ts
 *   ... PARLIAMENT_PARITY_ONLY=search (one case or prefix)
 */

import { describe, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { CASES, type ParityCase } from "./cases.js";
import { PARLIAMENT_COMMIT, originalAvailable, originalClient, type Observed } from "./original.js";
import { KEPT_RESPONSE_HEADERS, bodyOf, exchangeKey, requestHeaders, type RecordedExchange } from "./replay.js";

const RECORD = process.env.PARLIAMENT_PARITY_RECORD === "1";
const ONLY = process.env.PARLIAMENT_PARITY_ONLY;
/** Dry run: refuse every live request (checks the harness and the synthetic cases without network). */
const NO_LIVE = process.env.PARLIAMENT_PARITY_NO_LIVE === "1";
export const RECORDED_DIR = join(import.meta.dirname, "recorded");
const LIVE_HOST = "dati.camera.it";
const LIVE_SPACING_MS = 2500;

interface LiveAnswer { status: number; statusText: string; headers: Record<string, string>; bytes: Uint8Array }

function guardedFetch(realFetch: typeof fetch, c: ParityCase, log: RecordedExchange[], live: Map<string, LiveAnswer>, pace: { last: number; sent: number }): typeof fetch {
  const seen = new Map<string, number>();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const key = exchangeKey(input, init);
    const url = new URL(typeof input === "string" ? input : input.toString());
    const n = seen.get(url.toString()) ?? 0;
    seen.set(url.toString(), n + 1);
    const synthetic = c.synthetic?.(url, n);
    let answer: LiveAnswer;
    if (synthetic) {
      answer = { status: synthetic.status, statusText: "", headers: synthetic.contentType ? { "content-type": synthetic.contentType } : {}, bytes: new TextEncoder().encode(synthetic.body) };
    } else if (/(^|\.)senato\.it$/i.test(url.hostname)) {
      throw new Error(`REFUSED: a senato.it request without a synthetic answer (${c.id})`);
    } else if (url.hostname !== LIVE_HOST || url.protocol !== "https:") {
      throw new Error(`REFUSED: ${url.hostname} is not a live recording host (${c.id})`);
    } else if (NO_LIVE) {
      throw new Error(`REFUSED (dry run): ${key}`);
    } else if (live.has(key)) {
      answer = live.get(key)!;
    } else {
      const wait = pace.last + LIVE_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      pace.last = Date.now();
      pace.sent++;
      const res = await realFetch(input, init);
      const headers: Record<string, string> = {};
      for (const h of KEPT_RESPONSE_HEADERS) {
        const v = res.headers.get(h);
        if (v !== null) headers[h] = v;
      }
      answer = { status: res.status, statusText: res.statusText, headers, bytes: new Uint8Array(await res.arrayBuffer()) };
      pace.last = Date.now();
      live.set(key, answer);
    }
    log.push({ key, requestHeaders: requestHeaders(init), status: answer.status, statusText: answer.statusText, headers: answer.headers, ...bodyOf(answer.bytes), ...(synthetic ? { synthetic: true } : {}) });
    return new Response(answer.status === 204 || answer.status === 304 ? null : (answer.bytes as BodyInit), { status: answer.status, statusText: answer.statusText, headers: answer.headers });
  }) as typeof fetch;
}

describe.runIf(RECORD && originalAvailable())("record parity cases (live dati.camera.it, synthetic Senato)", () => {
  it("records every case", async () => {
    mkdirSync(RECORDED_DIR, { recursive: true });
    const realFetch = globalThis.fetch;
    const live = new Map<string, LiveAnswer>();
    const pace = { last: 0, sent: 0 };
    const cases = CASES.filter((c) => !ONLY || c.id.startsWith(ONLY));
    try {
      for (const c of cases) {
        const log: RecordedExchange[] = [];
        vi.resetModules();
        const original = await originalClient();
        globalThis.fetch = guardedFetch(realFetch, c, log, live, pace);
        const recordedAt = new Date().toISOString();
        let output: Observed;
        try {
          output = await original.callTool(c.name, c.args);
        } catch (error) {
          output = { text: `THROWN: ${error instanceof Error ? error.message : String(error)}`, isError: true, extra: null };
        } finally {
          globalThis.fetch = realFetch;
        }
        const { synthetic: _fn, ...stored } = c;
        writeFileSync(join(RECORDED_DIR, `${c.id}.json.gz`), gzipSync(JSON.stringify({ case: stored, original: PARLIAMENT_COMMIT, recordedAt, output, exchanges: log })));
        console.log(`${c.id}: ${log.length} exchange(s) (${log.filter((e) => e.synthetic).length} synthetic), ${output.isError ? "error" : "ok"}, ${output.text.length} chars; live requests so far: ${pace.sent}`);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 30 * 60 * 1000);
});
