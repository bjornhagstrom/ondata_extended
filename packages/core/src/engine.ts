/**
 * The engine: one per deployment. Holds the configuration, the shared cache and rate
 * limiter, and builds an EngineContext per profile per McpServer instance.
 */

import type { EngineConfig, EngineContext, Profile } from "@ondata-extended/profile-contract";
import { buildCacheKey, cacheConfigFrom, createCache, type Cache, type CacheConfig } from "./cache.js";
import { createConfig, processEnv, readNumber, type ConfigSource } from "./config.js";
import { DEFAULT_BROWSER_USER_AGENT, HttpClient, createHostThrottle } from "./net/client.js";
import { formatTable, truncateTextKeeping } from "./output/table.js";
import { netPolicyFromConfig, type NetPolicy } from "./net/guards.js";
import {
  DEFAULT_CHARACTER_LIMIT,
  formatBytes,
  formatDate,
  formatError,
  jsonToolResult,
  safeUrlText,
  sanitizeInline,
  truncateJson,
  truncateText,
  wrapUntrusted
} from "./output/format.js";
import { rateLimitConfigFrom, UpstreamRateLimiter } from "./rate-limiter.js";
import { noteTelemetry } from "./telemetry.js";

export interface EngineOptions {
  /** Config prefixes in lookup order; the first is the primary name ("APP", "ENGINE"). */
  configPrefixes: string[];
  /** Defaults to the process environment on Node. On Workers, pass the env bindings. */
  configSource?: ConfigSource;
  /** Namespaces Workers cache entries, e.g. "https://app-mcp-cache.internal". */
  cacheOrigin: string;
}

export interface Engine {
  readonly config: EngineConfig;
  readonly policy: NetPolicy;
  readonly cacheConfig: CacheConfig;
  /** The context for one profile on one McpServer instance. */
  contextFor(profile: Profile, server: object): EngineContext;
}

export function createEngine(options: EngineOptions): Engine {
  const source = options.configSource ?? processEnv();
  const config = createConfig(source, options.configPrefixes);
  const policy = netPolicyFromConfig(config);
  const cacheConfig = cacheConfigFrom(config, source);
  const cache: Cache | null = cacheConfig.enabled ? createCache(cacheConfig, options.cacheOrigin) : null;
  const rateConfig = rateLimitConfigFrom(config, source);
  const rateLimiter = rateConfig.enabled ? new UpstreamRateLimiter(rateConfig) : null;
  const limits = {
    characterLimit: readNumber(config, "CHARACTER_LIMIT", DEFAULT_CHARACTER_LIMIT),
    // Size caps against decompression bombs and oversized answers (GHSA-q5gv).
    maxResponseBytes: readNumber(config, "MAX_RESPONSE_BYTES", 32 * 1024 * 1024),
    timeoutMs: readNumber(config, "TIMEOUT_MS", 30000)
  };
  const maxDecompressedBytes = readNumber(config, "MAX_DECOMPRESSED_BYTES", 64 * 1024 * 1024);
  // One throttle per engine, shared by every server built from it. A host must therefore keep one
  // engine per process (Node) or per isolate (Workers), not build one per request, or a host
  // policy's minimum interval never spans two requests.
  const throttle = createHostThrottle();

  return {
    config,
    policy,
    cacheConfig,
    contextFor(profile: Profile, server: object): EngineContext {
      const client = new HttpClient({
        policy,
        cache,
        maxCacheEntryBytes: cacheConfig.maxEntryBytes,
        rateLimiter,
        maxResponseBytes: limits.maxResponseBytes,
        maxDecompressedBytes,
        maxErrorBodyBytes: 64 * 1024,
        timeoutMs: limits.timeoutMs,
        userAgents: { browser: DEFAULT_BROWSER_USER_AGENT, honest: profile.honestUserAgent },
        onRequest: ({ fromCache }) => noteTelemetry(server, { cache_hit: fromCache }),
        hostPolicy: (hostname) => profile.hostPolicies?.[hostname.toLowerCase()],
        throttle
      });
      const shrink = profile.shrinkableKeys;
      const source = profile.untrustedSourceLabel;
      return {
        http: {
          request: (url, init, opts) => client.request(url, init, opts),
          json: (url, init, opts) => client.json(url, init, opts),
          validateUrl: (url, opts) => client.validateUrl(url, opts)
        },
        cache: {
          enabled: cache !== null,
          defaultTtlSeconds: cacheConfig.ttlDefault,
          get: async (key) => (cache ? cache.get(key) : undefined),
          set: async (key, value, ttl) => {
            if (!cache) return;
            try {
              if (JSON.stringify(value).length <= cacheConfig.maxEntryBytes) await cache.set(key, value, ttl);
            } catch { /* not serializable: skip */ }
          },
          key: (parts) => buildCacheKey([profile.id, ...parts])
        },
        output: {
          text: (text, opts) => ({
            content: [{
              type: "text",
              text: opts?.trailer ? truncateTextKeeping(text, opts.trailer, limits.characterLimit) : truncateText(text, limits.characterLimit)
            }]
          }),
          table: (rows, opts) => {
            const t = formatTable(rows, opts, limits.characterLimit);
            return {
              content: [{ type: "text", text: t.text }],
              // formatTable already fitted both channels to the same rows.
              structuredContent: t.structured as unknown as Record<string, unknown>
            };
          },
          json: (value) => jsonToolResult(value, limits.characterLimit, shrink),
          error: (message, asJson) => ({ content: [{ type: "text", text: formatError(message, asJson) }], isError: true }),
          truncateText: (text, limit) => truncateText(text, limit ?? limits.characterLimit),
          truncateJson: (value, limit) => truncateJson(value, limit ?? limits.characterLimit, shrink),
          sanitizeInline,
          wrapUntrusted: (text) => wrapUntrusted(text, source),
          safeUrlText,
          formatDate,
          formatBytes
        },
        config,
        telemetry: { note: (fields) => noteTelemetry(server, fields) },
        limits
      };
    }
  };
}
