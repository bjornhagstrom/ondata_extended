// Ported from ondata/ckan-mcp-server tests/unit/rate-limiter.test.ts (commit 09e8cdc). Expectations unchanged;
// only the way the tests reach the code changed (imports, env prefix APP_ instead of ondata's,
// policy-building wrappers in ./helpers.ts). See docs/test-parity.md.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { UpstreamRateLimiter, RateLimitError } from '../src/index.js';
import { getRateLimitConfig, __resetRateLimiterForTests } from './helpers.js';

describe('getRateLimitConfig', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    for (const k of [
      'APP_RATE_LIMIT_ENABLED',
      'APP_RATE_LIMIT_RPS',
      'APP_RATE_LIMIT_BURST',
      'APP_RATE_LIMIT_MAX_WAIT_MS',
    ]) delete process.env[k];
  });

  afterAll(() => { process.env = saved; });

  it('defaults to disabled when VITEST=true', () => {
    expect(process.env.VITEST).toBe('true');
    expect(getRateLimitConfig().enabled).toBe(false);
  });

  it('enabled via APP_RATE_LIMIT_ENABLED=true', () => {
    process.env.APP_RATE_LIMIT_ENABLED = 'true';
    expect(getRateLimitConfig().enabled).toBe(true);
  });

  it('reads custom rps', () => {
    process.env.APP_RATE_LIMIT_RPS = '2';
    expect(getRateLimitConfig().rps).toBe(2);
  });

  it('reads custom burst', () => {
    process.env.APP_RATE_LIMIT_BURST = '3';
    expect(getRateLimitConfig().burst).toBe(3);
  });

  it('reads custom maxWaitMs', () => {
    process.env.APP_RATE_LIMIT_MAX_WAIT_MS = '1000';
    expect(getRateLimitConfig().maxWaitMs).toBe(1000);
  });
});

describe('UpstreamRateLimiter', () => {
  beforeEach(() => {
    __resetRateLimiterForTests();
    vi.useRealTimers();
  });

  it('allows burst requests immediately', async () => {
    const limiter = new UpstreamRateLimiter({ enabled: true, rps: 10, burst: 3, maxWaitMs: 5000 });
    const start = Date.now();
    await limiter.acquire('portal-a.example');
    await limiter.acquire('portal-a.example');
    await limiter.acquire('portal-a.example');
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('different hostnames have independent buckets', async () => {
    const limiter = new UpstreamRateLimiter({ enabled: true, rps: 1, burst: 1, maxWaitMs: 5000 });
    await limiter.acquire('host-a.example');
    // host-b is independent, should not be affected
    const start = Date.now();
    await limiter.acquire('host-b.example');
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('throws RateLimitError when wait would exceed maxWaitMs', async () => {
    const limiter = new UpstreamRateLimiter({ enabled: true, rps: 1, burst: 1, maxWaitMs: 10 });
    await limiter.acquire('slow.portal'); // consumes the 1 burst token
    await expect(limiter.acquire('slow.portal')).rejects.toThrow(RateLimitError);
  });

  it('RateLimitError message includes hostname', async () => {
    const limiter = new UpstreamRateLimiter({ enabled: true, rps: 1, burst: 1, maxWaitMs: 10 });
    await limiter.acquire('slow.portal');
    await expect(limiter.acquire('slow.portal')).rejects.toThrow('slow.portal');
  });

  it('RateLimitError message includes wait time in ms', async () => {
    const limiter = new UpstreamRateLimiter({ enabled: true, rps: 1, burst: 1, maxWaitMs: 10 });
    await limiter.acquire('slow.portal');
    await expect(limiter.acquire('slow.portal')).rejects.toThrow('ms');
  });

  it('waits and proceeds when within maxWaitMs', async () => {
    vi.useFakeTimers();
    const limiter = new UpstreamRateLimiter({ enabled: true, rps: 10, burst: 1, maxWaitMs: 5000 });
    await limiter.acquire('portal');        // consumes burst
    const p = limiter.acquire('portal');    // should wait ~100ms (1/10s)
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
  });

  it('clear() resets all buckets', async () => {
    const limiter = new UpstreamRateLimiter({ enabled: true, rps: 1, burst: 1, maxWaitMs: 10 });
    await limiter.acquire('portal');
    limiter.clear();
    // After clear, bucket is recreated with full burst
    const start = Date.now();
    await limiter.acquire('portal');
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe('UpstreamRateLimiter — opts.rateLimit=false bypass', () => {
  it('exhausted limiter still proceeds when acquire is never called (rateLimit=false path)', async () => {
    // Verify that when opts.rateLimit=false, the limiter acquire() is never called.
    // We test this by exhausting a limiter with burst=1 and maxWait=10ms, then confirming
    // calling acquire again throws — i.e. the limiter IS exhausted and would block callers
    // who don't bypass it.
    const limiter = new UpstreamRateLimiter({ enabled: true, rps: 1, burst: 1, maxWaitMs: 10 });
    await limiter.acquire('host');
    await expect(limiter.acquire('host')).rejects.toThrow(RateLimitError);
    // A caller with rateLimit=false would never call acquire() at all — confirmed by
    // the branch in http.ts: `if (rateLimitEnabled) { ... acquire ... }`
  });
});
