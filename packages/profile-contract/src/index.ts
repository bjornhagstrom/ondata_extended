/**
 * The profile contract: what the engine gives a profile, and what a profile must deliver.
 *
 * Types only. Profiles depend on this package (and may use helpers from the core), never on
 * each other. The contract is 0.x: it may change until two profiles run on it (see
 * docs/DECISIONS.md). The design follows section 4.2 of the architecture proposal for
 * ondata/ckan-mcp-server, adjusted where building it showed otherwise.
 */

import type { ZodRawShape, ZodTypeAny, objectOutputType } from "zod";

// ---------------------------------------------------------------------------------------
// Results

export interface TextContent {
  type: "text";
  text: string;
}

/** A tool result as the MCP SDK expects it. */
export interface ToolResult {
  [key: string]: unknown;
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface PromptResult {
  [key: string]: unknown;
  messages: Array<{ role: "user" | "assistant"; content: TextContent }>;
}

export interface ResourceContents {
  [key: string]: unknown;
  contents: Array<{ uri: string; mimeType?: string; text: string }>;
}

// ---------------------------------------------------------------------------------------
// What the engine gives a profile

export interface FetchOptions {
  /** Whole-request timeout including reading the body. Default 30 000 ms. */
  timeoutMs?: number;
  /** Redirects followed, each hop re-validated. Default 5. */
  maxHops?: number;
  /** Refuse redirects to non-HTTPS URLs. */
  httpsOnly?: boolean;
  /** Identity sent upstream. "browser" passes Chrome-only firewalls; "honest" names the server. Default "browser". */
  userAgent?: "browser" | "honest";
  /**
   * Overrides the host policy's retry for this request (e.g. `{ attempts: 1 }` for a call that
   * must not be repeated).
   */
  retry?: RetryPolicy;
  /**
   * Retry once with the honest identity when the body shows a challenge page that turns
   * away browser identities (e.g. an Anubis proof-of-work page). The retry pays its own
   * rate token. Default: retry on the Anubis marker.
   */
  retryHonestIf?: ((bodyText: string) => boolean) | false;
  /** Take a rate token for the hostname before the request. Default true. */
  rateLimit?: boolean;
  /** Cache successful (2xx) bodies for this many seconds, keyed by method, URL, body and `key`. */
  cache?: { ttlSeconds: number; key?: unknown[] };
  /**
   * Let a host the administrator listed as private resolve to a private address
   * (loopback, RFC 1918, unique-local). Default false: closed even for listed hosts.
   */
  allowPrivateHosts?: boolean;
}

/**
 * Retries for one host: only on network failures, timeouts, 5xx and 429; never on another 4xx
 * (a refused request is not transient, and repeating it can get a client banned).
 */
export interface RetryPolicy {
  /** Total attempts including the first. 1 = no retry. */
  attempts: number;
  /** Exponential backoff: base * 2^(attempt-1), capped at maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * What a profile knows about one upstream host and the deployment cannot: how often it may be
 * called and whether it is worth retrying. Applied by the core to every request to that host.
 */
export interface HostPolicy {
  /** Minimum time between the *start* of two requests to this host, across all callers in the process. */
  minIntervalMs?: number;
  retry?: RetryPolicy;
  /** Default timeout for this host (a request's own `timeoutMs` wins). */
  timeoutMs?: number;
}

/** A response read under the engine's size cap. Returned for any HTTP status. */
export interface HttpResponse {
  /** The final URL, after redirects. */
  url: string;
  status: number;
  statusText: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /**
   * The body as UTF-8 text. For a non-2xx answer only small bodies are read (default
   * 64 KiB) and `text` is null when the body was larger or unreadable.
   */
  text: string | null;
  fromCache: boolean;
}

export interface EngineHttp {
  /** Validate, rate-limit, fetch with SSRF guards and caps; never throws on an HTTP status. */
  request(url: string, init?: RequestInit, opts?: FetchOptions): Promise<HttpResponse>;
  /** `request` + 2xx check + JSON parse. Throws the engine's HttpStatusError / TransportError. */
  json<T = unknown>(url: string, init?: RequestInit, opts?: FetchOptions): Promise<T>;
  /** The literal SSRF guards and the domain allowlist, without a request. Throws SsrfGuardError. */
  validateUrl(url: string): void;
}

export interface EngineCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /** A collision-proof key from any JSON-serializable parts. */
  key(parts: unknown[]): Promise<string>;
  readonly enabled: boolean;
}

/** A flat table: every value a string, as SPARQL bindings or CSV give them. */
export type Row = Record<string, string>;

export interface TableOptions {
  /** Which columns, in which order, in every format (JSONL, CSV, structured); default: the keys of the first row. */
  columns?: string[];
  /** Shown after the rows when the result is not empty (e.g. "cut at limit N, page with offset"); always kept. */
  notice?: string;
  /** Shown instead of rows when there are none: tells the model not to invent the missing value. */
  emptyText: string;
  /** "jsonl" (default) or "csv". */
  format?: "jsonl" | "csv";
}

export interface EngineOutput {
  /** Markdown or plain text, truncated to the character limit. A `trailer` is kept after truncation. */
  text(text: string, opts?: { trailer?: string }): ToolResult;
  /**
   * Rows as JSONL or CSV text, truncated on whole rows (never mid-row), with the notice kept after
   * the rows and a note added when rows were dropped for size. `structuredContent` carries
   * `{ columns, rows, total, truncated }` with exactly the rows the text shows.
   */
  table(rows: Row[], opts: TableOptions): ToolResult;
  /** Always-parseable JSON in both channels; shrinks the profile's shrinkable arrays first. */
  json(value: unknown): ToolResult;
  /** An error in the caller's format, marked `isError`. */
  error(message: string, asJson: boolean): ToolResult;
  truncateText(text: string, limit?: number): string;
  truncateJson(value: unknown, limit?: number): string;
  /** A short upstream string made safe inside one Markdown line. */
  sanitizeInline(value: unknown): string;
  /** Upstream free text fenced as data, not instructions. */
  wrapUntrusted(text: string): string;
  safeUrlText(url: unknown): string;
  formatDate(value: string): string;
  formatBytes(bytes: number | undefined): string;
}

export interface EngineConfig {
  /** A setting by its unprefixed name ("ALLOWED_DOMAINS"), from the first prefix that has it. */
  get(name: string): string | undefined;
  /** The primary variable name for a setting, for messages ("VOCAB_ALLOWED_DOMAINS"). */
  nameOf(name: string): string;
}

export interface EngineTelemetry {
  /** Add fields to this call's log line (host decides whether and where it is written). */
  note(fields: Record<string, unknown>): void;
}

export interface EngineLimits {
  characterLimit: number;
  maxResponseBytes: number;
  timeoutMs: number;
}

/** Everything a tool, resource or prompt handler may use. One per profile per server instance. */
export interface EngineContext {
  http: EngineHttp;
  cache: EngineCache;
  output: EngineOutput;
  config: EngineConfig;
  telemetry: EngineTelemetry;
  limits: EngineLimits;
}

// ---------------------------------------------------------------------------------------
// What a profile delivers

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolArgs<Shape extends ZodRawShape> = objectOutputType<Shape, ZodTypeAny>;

export interface ToolSpec<Shape extends ZodRawShape = ZodRawShape> {
  /** Full tool name as clients see it. Must start with the profile's prefix, if it has one, unless `shared`. */
  name: string;
  title?: string;
  description: string;
  /** Example calls; the core appends them to the description ("Examples:"). */
  examples?: string[];
  inputSchema: Shape;
  outputSchema?: ZodRawShape;
  annotations?: ToolAnnotations;
  /** A small tool the core offers to several profiles (e.g. a SPARQL query); exempt from the prefix. */
  shared?: boolean;
  handler(args: ToolArgs<Shape>, ctx: EngineContext): Promise<ToolResult>;
}

export interface PromptSpec<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  argsSchema?: Shape;
  /** Tool names the prompt text tells the model to call; checked against the registered tools. */
  referencedTools: string[];
  build(args: ToolArgs<Shape>): PromptResult;
}

export interface ResourceSpec {
  name: string;
  /** RFC 6570 template, e.g. "skos://{vocab}/concept/{id}". */
  uriTemplate: string;
  title?: string;
  description?: string;
  mimeType?: string;
  read(uri: URL, variables: Record<string, string | string[]>, ctx: EngineContext): Promise<ResourceContents>;
}

/** A known backend instance with the profile's own particulars under `ext`. */
export interface InstanceEntry<Ext = unknown> {
  id: string;
  baseUrl: string;
  aliases?: string[];
  apiPath?: string;
  /** The instance moved or closed; every answer about it says so. */
  migrated?: { notice: string; docsUrl: string };
  ext: Ext;
}

export interface InstanceRegistry<Ext = unknown> {
  all(): readonly InstanceEntry<Ext>[];
  /** By id, exact base URL or alias (trailing slash and case of the host ignored). */
  find(idOrUrl: string): InstanceEntry<Ext> | undefined;
  byHostname(hostname: string): InstanceEntry<Ext> | undefined;
}

export interface Profile {
  /** "skos", "ckan". */
  id: string;
  version: string;
  /**
   * "vocab_", "ckan_". Optional: a profile whose tool names are already a user contract without a
   * prefix (e.g. a server with 43 unprefixed tools) leaves it out; names must then still be unique
   * across the deployment's profiles.
   */
  toolPrefix?: string;
  /** Per-host request policy, keyed by hostname ("dati.senato.it"). */
  hostPolicies?: Record<string, HostPolicy>;
  tools: ToolSpec<any>[];
  resources?: ResourceSpec[];
  prompts?: PromptSpec<any>[];
  /** Array keys JSON truncation may shrink, in sacrifice order. */
  shrinkableKeys: string[];
  /** Tool arguments the host may log. */
  telemetryFields: string[];
  /** Names the source in the untrusted-content notice ("the vocabulary service"). */
  untrustedSourceLabel: string;
  /** The honest user agent for this profile's requests ("Vocab-MCP-Server/0.1"). */
  honestUserAgent: string;
  /** A hint for the model about an error from this profile's tools, or null for the generic text. */
  describeError?(error: unknown, toolName: string): string | null;
}
