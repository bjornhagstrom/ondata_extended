/**
 * Test seams for the CKAN profile: how ported ondata tests reach the code (principle 1 in
 * docs/test-parity.md). ondata mocked axios and read `process.env` per call; here the network
 * is faked at `fetch` (the core client's boundary), DNS is stubbed to a public address, and an
 * engine is built per call from `process.env` so a test that sets `CKAN_*` before calling sees it.
 */

import { vi } from "vitest";
import type { EngineContext } from "@ondata-extended/profile-contract";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { __setDnsResolverForTests, createEngine, createMcpServer, registerProfiles, takeTelemetry, type Engine } from "@ondata-extended/core";
import { createCkanProfile } from "../src/index.js";

export const PUBLIC_ADDRESS = [{ address: "93.184.216.34", family: 4 }];

/** DNS answers a public address for every host (call in beforeEach; reset with `__setDnsResolverForTests(null)`). */
export function stubPublicDns(): void {
  __setDnsResolverForTests(async () => PUBLIC_ADDRESS);
}

/** An engine as the CKAN host builds it, from `process.env` plus `env`, at call time. */
export function ckanEngine(env: Record<string, string> = {}): Engine {
  const source: Record<string, string | undefined> = { ...process.env, ...env };
  return createEngine({ configPrefixes: ["CKAN"], configSource: source, cacheOrigin: "https://ckan-mcp-cache.internal" });
}

/** The context `makeCkanRequest` gets inside a tool. Pass `engine` to share cache and rate limiter between calls. */
export function ckanContext(engine: Engine = ckanEngine(), server: object = {}): EngineContext {
  return engine.contextFor(createCkanProfile(), server);
}

/** A JSON `Response`, as `fetch` would give it. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) }
  });
}

/** Replace `fetch` with a mock; restored by `vi.unstubAllGlobals()`. */
export function mockFetch(impl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl ?? (async () => jsonResponse({ success: true, result: {} })));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The URL of the n-th fetch call. */
export function fetchedUrl(fn: ReturnType<typeof mockFetch>, n = 0): string {
  return String(fn.mock.calls[n][0]);
}

/** The request headers of the n-th fetch call, as a plain object with lower-case names. */
export function fetchedHeaders(fn: ReturnType<typeof mockFetch>, n = 0): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(fn.mock.calls[n][1]?.headers).forEach((v, k) => { out[k] = v; });
  return out;
}

/** The CKAN profile behind an in-memory MCP client (one engine per client). */
export async function ckanClient(env: Record<string, string> = {}) {
  const server = createMcpServer({ name: "ckan-mcp-server", version: "0.4.138" });
  registerProfiles(server, [createCkanProfile()], ckanEngine(env));
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    /** The McpServer instance: the key the core files telemetry under (`takeTelemetry(server)`). */
    server,
    async callTool(name: string, args: Record<string, unknown>) {
      return client.callTool({ name, arguments: args }) as Promise<{
        isError?: boolean;
        content: { type: string; text: string }[];
        structuredContent?: Record<string, unknown>;
      }>;
    }
  };
}

/**
 * ondata's `takeSearchResults(server)`: the search fields the tools noted for this server
 * instance, or null. The core keeps them with the call's other telemetry (`cache_hit`), so
 * only the four search fields are picked; the rest of the note is cleared with them.
 */
export function takeSearchResults(server: object): Record<string, unknown> | null {
  const all = takeTelemetry(server);
  if (!all) return null;
  const keys = ["result_count", "result_start", "result_ids", "result_names"].filter((k) => k in all);
  return keys.length ? Object.fromEntries(keys.map((k) => [k, all[k]])) : null;
}

