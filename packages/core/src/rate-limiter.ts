/**
 * Per-hostname upstream rate limiter (token bucket). Cache hits bypass it: only requests
 * that reach the upstream consume tokens.
 *
 * Derived from ondata/ckan-mcp-server src/utils/rate-limiter.ts (commit 09e8cdc); the
 * configuration is read through the deployment's prefixes instead of fixed names.
 */

import type { EngineConfig } from "@ondata-extended/profile-contract";
import { readEnabled, readNumber, type ConfigSource } from "./config.js";

export class RateLimitError extends Error {
  constructor(hostname: string, waitMs: number) {
    super(`Rate limit exceeded for ${hostname}: would need to wait ${Math.round(waitMs)}ms`);
    this.name = "RateLimitError";
  }
}

export interface RateLimitConfig {
  enabled: boolean;
  rps: number;
  burst: number;
  maxWaitMs: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const MAX_BUCKETS = 200;

export function rateLimitConfigFrom(config: EngineConfig, source?: ConfigSource): RateLimitConfig {
  return {
    enabled: readEnabled(config, "RATE_LIMIT_ENABLED", source),
    rps: readNumber(config, "RATE_LIMIT_RPS", 5),
    burst: readNumber(config, "RATE_LIMIT_BURST", 10),
    maxWaitMs: readNumber(config, "RATE_LIMIT_MAX_WAIT_MS", 5000)
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class UpstreamRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly config: RateLimitConfig) {}

  async acquire(hostname: string): Promise<void> {
    const { rps, burst, maxWaitMs } = this.config;

    if (!this.buckets.has(hostname)) {
      if (this.buckets.size >= MAX_BUCKETS) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      this.buckets.set(hostname, { tokens: burst, lastRefill: Date.now() });
    }

    let waited = 0;
    for (;;) {
      const bucket = this.buckets.get(hostname)!;
      const now = Date.now();
      const elapsed = now - bucket.lastRefill;
      bucket.tokens = Math.min(burst, bucket.tokens + (elapsed / 1000) * rps);
      bucket.lastRefill = now;

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }

      const waitNeeded = ((1 - bucket.tokens) / rps) * 1000;
      if (waited + waitNeeded > maxWaitMs) throw new RateLimitError(hostname, waited + waitNeeded);
      await sleep(waitNeeded);
      waited += waitNeeded;
    }
  }

  clear(): void {
    this.buckets.clear();
  }
}
