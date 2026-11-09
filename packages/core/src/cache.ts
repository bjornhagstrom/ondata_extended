/**
 * Read-through cache with two backends, chosen by runtime:
 * - WorkersCacheApi: Cloudflare Workers edge cache via caches.default
 * - MemoryLruCache: bounded in-memory LRU for Node.js
 *
 * Derived from ondata/ckan-mcp-server src/utils/cache.ts (commit 09e8cdc). The TTL table
 * keyed by backend action names is gone: the caller passes the TTL with each request.
 * The key takes any list of parts instead of (server, action, params).
 */

import type { EngineConfig } from "@ondata-extended/profile-contract";
import { readEnabled, readNumber, type ConfigSource } from "./config.js";

export interface Cache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

export interface CacheConfig {
  enabled: boolean;
  ttlDefault: number;
  maxEntries: number;
  maxEntryBytes: number;
}

export function cacheConfigFrom(config: EngineConfig, source?: ConfigSource): CacheConfig {
  return {
    enabled: readEnabled(config, "CACHE_ENABLED", source),
    ttlDefault: readNumber(config, "CACHE_TTL_DEFAULT", 300),
    maxEntries: readNumber(config, "CACHE_MAX_ENTRIES", 500),
    maxEntryBytes: readNumber(config, "CACHE_MAX_ENTRY_BYTES", 1024 * 1024)
  };
}

/** Recursively sort object keys so serialization is order-independent and type-preserving. */
function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Serialize to an unambiguous canonical string. Typed JSON (not `k=v` joins), so
 * `{q:"budget",rows:10}` and `{q:"budget&rows=10"}`, and a nested object vs. its
 * stringified form, never collide onto one key (GHSA-78x9). Null and undefined members are
 * dropped at the top level only (an absent parameter), as in ondata's canonicalizeParams;
 * nested nulls are data and stay.
 */
export function canonicalize(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined && v !== null) filtered[k] = v;
    }
    value = filtered;
  }
  return JSON.stringify(canonicalizeValue(value)) ?? "null";
}

async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  let hex = "";
  for (const b of new Uint8Array(hashBuffer)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** A key from any parts; JSON-array framing keeps the part boundaries unambiguous. */
export async function buildCacheKey(parts: unknown[]): Promise<string> {
  return sha1Hex(JSON.stringify(parts.map((p) => canonicalize(p))));
}

interface LruEntry {
  value: unknown;
  expiresAt: number;
}

export class MemoryLruCache implements Cache {
  private readonly store = new Map<string, LruEntry>();

  constructor(private readonly maxEntries: number) {}

  async get(key: string): Promise<unknown | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

export class WorkersCacheApi implements Cache {
  /** `origin` is a fake host that namespaces this deployment's entries in caches.default. */
  constructor(private readonly origin: string) {}

  async get(key: string): Promise<unknown | undefined> {
    try {
      const response = await (caches as unknown as { default: globalThis.Cache }).default.match(`${this.origin}/${key}`);
      if (!response) return undefined;
      return await response.json();
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    try {
      const response = new Response(JSON.stringify(value), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, s-maxage=${ttlSeconds}`
        }
      });
      await (caches as unknown as { default: globalThis.Cache }).default.put(`${this.origin}/${key}`, response);
    } catch {
      // Best effort.
    }
  }
}

export function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && !!(process as { versions?: { node?: string } }).versions?.node;
}

/** The backend for this runtime. `origin` namespaces Workers cache entries. */
export function createCache(config: CacheConfig, origin: string): Cache {
  const hasWorkersCaches =
    typeof caches !== "undefined" &&
    typeof (caches as unknown as { default?: unknown }).default !== "undefined";
  if (hasWorkersCaches && !isNodeRuntime()) return new WorkersCacheApi(origin);
  return new MemoryLruCache(config.maxEntries);
}
