// Ported from ondata/ckan-mcp-server tests/unit/cache.test.ts (commit 09e8cdc). Expectations unchanged;
// only the way the tests reach the code changed (imports, env prefix APP_ instead of ondata's,
// policy-building wrappers in ./helpers.ts). See docs/test-parity.md.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { MemoryLruCache } from '../src/index.js';
import { buildCacheKey, canonicalizeParams, getCacheConfig, __resetCacheForTests } from './helpers.js';

describe('canonicalizeParams', () => {
  it('sorts keys alphabetically', () => {
    expect(canonicalizeParams({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('skips null and undefined values', () => {
    expect(canonicalizeParams({ a: 1, b: null, c: undefined, d: 2 })).toBe('{"a":1,"d":2}');
  });

  it('serializes objects as JSON with sorted nested keys', () => {
    expect(canonicalizeParams({ filters: { y: 2, x: 1 } })).toBe('{"filters":{"x":1,"y":2}}');
  });

  it('returns empty object for empty params', () => {
    expect(canonicalizeParams({})).toBe('{}');
  });

  it('does NOT collide different param sets onto one key (GHSA-78x9)', () => {
    // Injection into the alphabetically-first param used to reproduce the target string.
    expect(canonicalizeParams({ q: 'budget', rows: 10 }))
      .not.toBe(canonicalizeParams({ q: 'budget&rows=10' }));
    // Object vs. its stringified form must differ too.
    expect(canonicalizeParams({ filters: { a: 'b' } }))
      .not.toBe(canonicalizeParams({ filters: '{"a":"b"}' }));
  });
});

describe('buildCacheKey', () => {
  it('produces identical keys for identical input', async () => {
    const a = await buildCacheKey('https://portal-a.example', 'search_items', { q: 'x' });
    const b = await buildCacheKey('https://portal-a.example', 'search_items', { q: 'x' });
    expect(a).toBe(b);
  });

  it('produces identical keys regardless of param order', async () => {
    const a = await buildCacheKey('https://portal-a.example', 'search_items', { q: 'x', rows: 10 });
    const b = await buildCacheKey('https://portal-a.example', 'search_items', { rows: 10, q: 'x' });
    expect(a).toBe(b);
  });

  it('produces different keys for different params', async () => {
    const a = await buildCacheKey('https://portal-a.example', 'search_items', { q: 'x' });
    const b = await buildCacheKey('https://portal-a.example', 'search_items', { q: 'y' });
    expect(a).not.toBe(b);
  });

  it('produces different keys for different server URLs', async () => {
    const a = await buildCacheKey('https://portal-a.example', 'search_items', { q: 'x' });
    const b = await buildCacheKey('https://portal-b.example', 'search_items', { q: 'x' });
    expect(a).not.toBe(b);
  });
});

describe('getCacheConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const k of ['APP_CACHE_ENABLED', 'APP_CACHE_TTL_DEFAULT', 'APP_CACHE_MAX_ENTRIES', 'APP_CACHE_MAX_ENTRY_BYTES']) {
      delete process.env[k];
    }
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('defaults to disabled when VITEST=true', () => {
    expect(process.env.VITEST).toBe('true');
    expect(getCacheConfig().enabled).toBe(false);
  });

  it('honors APP_CACHE_ENABLED=true override', () => {
    process.env.APP_CACHE_ENABLED = 'true';
    expect(getCacheConfig().enabled).toBe(true);
  });

  it('honors APP_CACHE_ENABLED=false override', () => {
    process.env.APP_CACHE_ENABLED = 'false';
    expect(getCacheConfig().enabled).toBe(false);
  });

  it('reads APP_CACHE_TTL_DEFAULT', () => {
    process.env.APP_CACHE_TTL_DEFAULT = '600';
    expect(getCacheConfig().ttlDefault).toBe(600);
  });

  it('reads APP_CACHE_MAX_ENTRIES', () => {
    process.env.APP_CACHE_MAX_ENTRIES = '100';
    expect(getCacheConfig().maxEntries).toBe(100);
  });
});

describe('MemoryLruCache', () => {
  beforeEach(() => {
    __resetCacheForTests();
    vi.useRealTimers();
  });

  it('stores and retrieves values', async () => {
    const cache = new MemoryLruCache(10);
    await cache.set('k1', { hello: 'world' }, 60);
    expect(await cache.get('k1')).toEqual({ hello: 'world' });
  });

  it('returns undefined for missing keys', async () => {
    const cache = new MemoryLruCache(10);
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('expires entries after TTL', async () => {
    vi.useFakeTimers();
    const cache = new MemoryLruCache(10);
    await cache.set('k1', 'v1', 60);
    vi.advanceTimersByTime(61_000);
    expect(await cache.get('k1')).toBeUndefined();
  });

  it('does not store when ttl <= 0', async () => {
    const cache = new MemoryLruCache(10);
    await cache.set('k1', 'v1', 0);
    expect(await cache.get('k1')).toBeUndefined();
  });

  it('evicts least-recently-used entry when over capacity', async () => {
    const cache = new MemoryLruCache(2);
    await cache.set('a', 1, 60);
    await cache.set('b', 2, 60);
    await cache.get('a'); // touch a to make b LRU
    await cache.set('c', 3, 60);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBe(1);
    expect(await cache.get('c')).toBe(3);
  });

  it('overwrites existing entry on set', async () => {
    const cache = new MemoryLruCache(10);
    await cache.set('k1', 'v1', 60);
    await cache.set('k1', 'v2', 60);
    expect(await cache.get('k1')).toBe('v2');
    expect(cache.size()).toBe(1);
  });

  it('clear() empties the cache', async () => {
    const cache = new MemoryLruCache(10);
    await cache.set('k1', 'v1', 60);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(await cache.get('k1')).toBeUndefined();
  });
});
