/**
 * The core engine: backend-agnostic. Nothing here names a backend, a profile or a deployment;
 * `npm run check:boundaries` enforces it.
 *
 * Node-only transports (stdio, Express) are in "@ondata-extended/core/node", so a Workers
 * bundle never pulls them in.
 */

export { createConfig, processEnv, readList, readNumber, readEnabled, type ConfigSource } from "./config.js";
export { createEngine, type Engine, type EngineOptions } from "./engine.js";
export {
  createMcpServer,
  registerProfiles,
  validateProfiles,
  genericErrorText,
  createTextPrompt,
  describeTool,
  runRowsTool,
  DEFAULT_EMPTY_TEXT,
  McpServer,
  type ServerInfo
} from "./mcp.js";
export { createInstanceRegistry } from "./registry.js";
export {
  HttpClient,
  HttpStatusError,
  TransportError,
  ResponseTooLargeError,
  InvalidJsonError,
  isAnubisChallenge,
  readBoundedBytes,
  safeFetch,
  createHostThrottle,
  DEFAULT_BROWSER_USER_AGENT,
  type HttpClientSettings
} from "./net/client.js";
export {
  SsrfGuardError,
  DnsResolutionError,
  validateUrl,
  netPolicyFromConfig,
  isPrivateHostAllowed,
  assertRedirectKeepsPrivateExemption,
  assertHostnameResolvesSafe,
  assertHttpAllowlistConfigured,
  warnIfPrivateHostsOverHttp,
  createSsrfSafeLookup,
  getSafeDispatcher,
  __setDnsResolverForTests,
  type NetPolicy
} from "./net/guards.js";
export { isBlockedIp, isPrivateNetworkIp, parseIpv6 } from "./net/ip.js";
export {
  MemoryLruCache,
  WorkersCacheApi,
  buildCacheKey,
  canonicalize,
  cacheConfigFrom,
  createCache,
  isNodeRuntime,
  type Cache,
  type CacheConfig
} from "./cache.js";
export { UpstreamRateLimiter, RateLimitError, rateLimitConfigFrom, type RateLimitConfig } from "./rate-limiter.js";
export {
  DEFAULT_CHARACTER_LIMIT,
  truncateText,
  truncateJson,
  jsonToolResult,
  cappedStructured,
  formatError,
  sanitizeInline,
  wrapUntrusted,
  safeUrlText,
  formatDate,
  formatBytes,
  isWorkers
} from "./output/format.js";
export {
  renderFields,
  formatFieldsMarkdown,
  cleanText,
  plainValue,
  MAX_FIELD_TEXT,
  type FieldSpec,
  type RenderedField
} from "./output/fields.js";
export { formatTable, truncateTextKeeping, type FormattedTable } from "./output/table.js";
export { noteTelemetry, takeTelemetry, summarizeToolError, type ErrorKind, type ErrorTelemetry } from "./telemetry.js";
export { createWorkerHandler, pickTelemetryFields, type WorkerHostOptions, type AnalyticsEngineDataset } from "./worker.js";
export {
  validateSelectQuery,
  injectLimit,
  sparqlStringLiteral,
  flattenBindings,
  sparqlSelect,
  SparqlValidationError,
  type SparqlResults,
  type SparqlBindingValue
} from "./sparql.js";
