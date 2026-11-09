/**
 * Per-host policy (throttle, retry, timeout) and row-based output. New in the contract after the
 * third-backend contract spike (see docs/DECISIONS.md); each test names the property it protects.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  HttpClient,
  TransportError,
  createHostThrottle,
  formatTable,
  truncateTextKeeping,
  type HttpClientSettings,
  type NetPolicy
} from "../src/index.js";
import type { HostPolicy } from "@ondata-extended/profile-contract";

const policy: NetPolicy = {
  allowedDomains: [],
  privateHosts: ["127.0.0.1"],
  names: { allowedDomains: "APP_ALLOWED_DOMAINS", privateHosts: "APP_PRIVATE_HOSTS", httpAllowAll: "APP_HTTP_ALLOW_ALL" }
};

let server: http.Server;
let base: string;
const hits: Record<string, number> = {};
const startTimes: number[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    hits[path] = (hits[path] ?? 0) + 1;
    if (path === "/flaky") {
      // 503 twice, then 200
      res.statusCode = hits[path] <= 2 ? 503 : 200;
      res.end(res.statusCode === 200 ? "ok" : "down");
    } else if (path === "/busy") {
      res.statusCode = hits[path] <= 1 ? 429 : 200;
      res.end("x");
    } else if (path === "/missing") {
      res.statusCode = 404;
      res.end("no");
    } else if (path === "/always-down") {
      res.statusCode = 503;
      res.end("down");
    } else if (path === "/timed") {
      startTimes.push(Date.now());
      res.end("t");
    } else if (path === "/to-metadata") {
      res.statusCode = 302;
      res.setHeader("location", "http://169.254.169.254/latest/meta-data/");
      res.end();
    } else if (path === "/huge") {
      res.setHeader("content-length", String(50 * 1024 * 1024));
      res.write("x");
    } else if (path === "/loop") {
      res.statusCode = 302;
      res.setHeader("location", "/loop");
      res.end();
    } else if (path === "/anubis-then-down") {
      if (String(req.headers["user-agent"]) === "H") { res.statusCode = 503; res.end("down"); }
      else { res.end("<html>anubis_challenge</html>"); }
    } else if (path === "/stall") {
      res.write("x"); // never ends
    } else {
      res.end("ok");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const client = (hostPolicy?: HostPolicy, throttle = createHostThrottle()) => new HttpClient({
  policy,
  cache: null,
  maxCacheEntryBytes: 1e6,
  rateLimiter: null,
  maxResponseBytes: 1e6,
  maxDecompressedBytes: 1e6,
  maxErrorBodyBytes: 1024,
  timeoutMs: 2000,
  userAgents: { browser: "B", honest: "H" },
  hostPolicy: () => hostPolicy,
  throttle
} satisfies HttpClientSettings);
const P = { allowPrivateHosts: true } as const;
const fastRetry = (attempts: number) => ({ retry: { attempts, baseDelayMs: 5, maxDelayMs: 20 } });

describe("host retry policy", () => {
  it("retries 5xx until it succeeds", async () => {
    hits["/flaky"] = 0;
    const res = await client(fastRetry(5)).request(`${base}/flaky`, {}, P);
    expect(res.status).toBe(200);
    expect(hits["/flaky"]).toBe(3);
  });

  it("retries 429", async () => {
    hits["/busy"] = 0;
    expect((await client(fastRetry(3)).request(`${base}/busy`, {}, P)).status).toBe(200);
    expect(hits["/busy"]).toBe(2);
  });

  it("never retries another 4xx: a refused request is not transient", async () => {
    hits["/missing"] = 0;
    expect((await client(fastRetry(5)).request(`${base}/missing`, {}, P)).status).toBe(404);
    expect(hits["/missing"]).toBe(1);
  });

  it("returns the last 5xx after the last attempt", async () => {
    hits["/always-down"] = 0;
    expect((await client(fastRetry(3)).request(`${base}/always-down`, {}, P)).status).toBe(503);
    expect(hits["/always-down"]).toBe(3);
  });

  it("retries a timeout, then gives up with the transport error", async () => {
    hits["/stall"] = 0;
    const error = await client({ ...fastRetry(2), timeoutMs: 100 }).request(`${base}/stall`, {}, P).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(hits["/stall"]).toBe(2);
  });

  it("does not retry without a policy, and a request's own retry overrides the host's", async () => {
    hits["/always-down"] = 0;
    await client().request(`${base}/always-down`, {}, P);
    expect(hits["/always-down"]).toBe(1);
    hits["/always-down"] = 0;
    await client(fastRetry(5)).request(`${base}/always-down`, {}, { ...P, retry: { attempts: 1 } });
    expect(hits["/always-down"]).toBe(1);
  });
});

describe("what is never retried (no amplification)", () => {
  it("a redirect to a refused destination: one request", async () => {
    hits["/to-metadata"] = 0;
    await expect(client(fastRetry(5)).request(`${base}/to-metadata`, {}, P)).rejects.toThrow("private/internal");
    expect(hits["/to-metadata"]).toBe(1);
  });

  it("an oversized body: one request", async () => {
    hits["/huge"] = 0;
    await expect(client(fastRetry(5)).request(`${base}/huge`, {}, P)).rejects.toThrow("Response too large");
    expect(hits["/huge"]).toBe(1);
  });

  it("a redirect loop: one run of hops, not one per attempt", async () => {
    hits["/loop"] = 0;
    await expect(client(fastRetry(5)).request(`${base}/loop`, {}, { ...P, maxHops: 3 })).rejects.toThrow("Too many redirects");
    expect(hits["/loop"]).toBe(4);
  });

  it("an Anubis page gets one honest request, not a second retry loop", async () => {
    hits["/anubis-then-down"] = 0;
    const res = await client(fastRetry(5)).request(`${base}/anubis-then-down`, {}, P);
    expect(res.status).toBe(503);
    expect(hits["/anubis-then-down"]).toBe(2);
  });

  it("a nonsensical attempt count is bounded", async () => {
    hits["/always-down"] = 0;
    await client({ retry: { attempts: Infinity, baseDelayMs: 1, maxDelayMs: 1 } }).request(`${base}/always-down`, {}, P);
    expect(hits["/always-down"]).toBe(1);
    hits["/always-down"] = 0;
    await client({ retry: { attempts: 1000, baseDelayMs: 1, maxDelayMs: 1 } }).request(`${base}/always-down`, {}, P);
    expect(hits["/always-down"]).toBe(10);
  });
});

describe("host throttle", () => {
  it("spaces the start of requests to one host, also when they are concurrent", async () => {
    startTimes.length = 0;
    const c = client({ minIntervalMs: 120 });
    await Promise.all([1, 2, 3].map(() => c.request(`${base}/timed`, {}, P)));
    expect(startTimes).toHaveLength(3);
    for (let i = 1; i < startTimes.length; i++) expect(startTimes[i] - startTimes[i - 1]).toBeGreaterThanOrEqual(110);
  });

  it("is shared by clients of the same engine (one throttle), not per client", async () => {
    startTimes.length = 0;
    const shared = createHostThrottle();
    await Promise.all([client({ minIntervalMs: 120 }, shared), client({ minIntervalMs: 120 }, shared)].map((c) => c.request(`${base}/timed`, {}, P)));
    expect(startTimes[1] - startTimes[0]).toBeGreaterThanOrEqual(110);
  });

  it("throttles each retry too: that is what the host counts", async () => {
    hits["/flaky"] = 0;
    const t0 = Date.now();
    await client({ minIntervalMs: 100, retry: { attempts: 5, baseDelayMs: 1, maxDelayMs: 1 } }).request(`${base}/flaky`, {}, P);
    expect(hits["/flaky"]).toBe(3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
  });
});

describe("table output", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: `name ${i}`.padEnd(30, ".") }));

  it("shows the empty text instead of rows when there are none", () => {
    expect(formatTable([], { emptyText: "Nothing. Do not invent a value.", notice: "N" }, 1000).text).toBe("Nothing. Do not invent a value.");
  });

  it("renders JSONL with the notice after the rows", () => {
    const t = formatTable(rows.slice(0, 2), { emptyText: "-", notice: "[cut at limit 2]" }, 1000);
    expect(t.text).toBe('{"id":"0","name":"name 0........................"}\n{"id":"1","name":"name 1........................"}\n[cut at limit 2]');
  });

  it("cuts on whole rows, keeps the notice, and says how many rows were shown", () => {
    const t = formatTable(rows, { emptyText: "-", notice: "[NOTICE]" }, 600);
    expect(t.text.length).toBeLessThanOrEqual(600);
    expect(t.text.endsWith("[NOTICE]")).toBe(true);
    const lines = t.text.split("\n");
    const dataLines = lines.filter((l) => l.startsWith("{"));
    for (const l of dataLines) expect(() => JSON.parse(l)).not.toThrow();
    expect(t.text).toMatch(new RegExp(`\\[${dataLines.length} of 50 rows shown`));
    expect(t.structured).toMatchObject({ total: 50, truncated: true });
    expect(t.structured.rows).toHaveLength(dataLines.length);
  });

  it("renders CSV with a header and escapes quotes, commas and newlines", () => {
    const t = formatTable([{ a: 'x,"y"', b: "l1\nl2" }], { emptyText: "-", format: "csv" }, 1000);
    expect(t.text).toBe('a,b\n"x,""y""","l1\nl2"');
  });

  it("text with a trailer keeps the trailer when the text is cut", () => {
    const out = truncateTextKeeping("x".repeat(500), "[MUST SEE]", 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("[MUST SEE]")).toBe(true);
    expect(out).toContain("Response truncated");
  });
});

describe("table channels agree (review fix)", () => {
  it("near the limit, the structured channel holds exactly the rows the text shows", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: String(i), v: "x".repeat(20) }));
    const full = rows.map((r) => JSON.stringify(r)).join("\n").length;
    for (const limit of [full - 20, full, full + 10, full + 60]) {
      const t = formatTable(rows, { emptyText: "-" }, limit);
      const textRows = t.text.split("\n").filter((l) => l.startsWith("{")).length;
      expect(t.structured.rows).toHaveLength(textRows);
      expect(t.structured.truncated).toBe(textRows < rows.length);
      expect(JSON.stringify(t.structured).length).toBeLessThanOrEqual(limit);
      expect(t.text.length).toBeLessThanOrEqual(limit);
    }
  });

  it("columns select and order the fields in JSONL too", () => {
    expect(formatTable([{ b: "2", a: "1", z: "x" }], { columns: ["a", "b"], emptyText: "-" }, 100).text).toBe('{"a":"1","b":"2"}');
  });
});
