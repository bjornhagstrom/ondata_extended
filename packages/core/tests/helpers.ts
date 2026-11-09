/**
 * Test seams: the ported ondata tests drive the guards through environment variables, as
 * the original did. These wrappers build the policy from `process.env` with the prefix
 * "APP" on every call, so a test that sets `APP_PRIVATE_HOSTS` sees it immediately, the
 * way ondata's original saw its own variable. Only how the tests reach the code changed.
 */

import {
  assertHostnameResolvesSafe as coreAssertHostnameResolvesSafe,
  assertHttpAllowlistConfigured as coreAssertHttpAllowlistConfigured,
  assertRedirectKeepsPrivateExemption as coreAssertRedirect,
  createConfig,
  createSsrfSafeLookup as coreCreateSsrfSafeLookup,
  isPrivateHostAllowed as coreIsPrivateHostAllowed,
  netPolicyFromConfig,
  validateUrl,
  warnIfPrivateHostsOverHttp as coreWarn
} from "../src/index.js";

export const envConfig = () => createConfig(process.env, ["APP"]);
export const envPolicy = () => netPolicyFromConfig(envConfig());

// ondata's validateServerUrl always honoured the private-host exemption (its CKAN path
// asked for it); the core applies it only on request, so the seam asks for it.
export const validateServerUrl = (url: string) => validateUrl(url, envPolicy(), { allowPrivateHosts: true });
export const isPrivateHostAllowed = (hostname: string) => coreIsPrivateHostAllowed(hostname, envPolicy());
export const assertRedirectKeepsPrivateExemption = (from: string, to: string) => coreAssertRedirect(from, to, envPolicy());
export const warnIfPrivateHostsOverHttp = () => coreWarn(envPolicy());
export const assertHttpAllowlistConfigured = () => coreAssertHttpAllowlistConfigured(envConfig());

type LookupSettings = { allowPrivateHosts?: boolean };
export const createSsrfSafeLookup = (dns: Parameters<typeof coreCreateSsrfSafeLookup>[0], settings: LookupSettings = {}) =>
  coreCreateSsrfSafeLookup(dns, { ...settings, policy: envPolicy() });
export const assertHostnameResolvesSafe = (hostname: string, settings: LookupSettings = {}) =>
  coreAssertHostnameResolvesSafe(hostname, { ...settings, policy: envPolicy() });

// ondata's fixed list (src/utils/formatting.ts:21-24). The core takes the list from the
// profile; the ported truncation tests pass ondata's so their expectations hold as written.
import {
  cappedStructured as coreCappedStructured,
  jsonToolResult as coreJsonToolResult,
  truncateJson as coreTruncateJson
} from "../src/index.js";

export const ONDATA_SHRINKABLE_KEYS = [
  "results", "records", "rows", "datasets", "resources", "packages",
  "organizations", "groups", "portals", "tags", "facets", "fields"
];
export const truncateJson = (obj: unknown, limit?: number) => coreTruncateJson(obj, limit, ONDATA_SHRINKABLE_KEYS);
export const jsonToolResult = (obj: unknown, limit?: number) => coreJsonToolResult(obj, limit, ONDATA_SHRINKABLE_KEYS);
export const cappedStructured = (obj: unknown, limit?: number) => coreCappedStructured(obj, limit, ONDATA_SHRINKABLE_KEYS);

// Cache and rate-limit seams. The core builds both from a config object; the ported tests
// call the original zero-argument readers, which read process.env (prefix APP_).
import {
  buildCacheKey as coreBuildCacheKey,
  cacheConfigFrom,
  canonicalize,
  rateLimitConfigFrom
} from "../src/index.js";

export const canonicalizeParams = (params: Record<string, unknown>) => canonicalize(params);
export const buildCacheKey = (serverUrl: string, action: string, params: Record<string, unknown>) =>
  coreBuildCacheKey([serverUrl, action, params]);
export const getCacheConfig = () => cacheConfigFrom(envConfig());
export const getRateLimitConfig = () => rateLimitConfigFrom(envConfig());
/** The core has no shared singletons to reset; kept so the ported tests read as written. */
export const __resetCacheForTests = () => undefined;
export const __resetRateLimiterForTests = () => undefined;

// The scheming renderer seam: ondata's renderSchemaFields(pkg, schema, shown) and
// formatFieldsMarkdown(fields), expressed with the core's generic renderer. NEVER_ADDED,
// the source label and the shortened-note are ondata's (src/utils/scheming.ts:47-49, :215;
// src/utils/formatting.ts:149); in this repository they belong to a profile (ondata).
import {
  formatFieldsMarkdown as coreFormatFieldsMarkdown,
  renderFields,
  type FieldSpec,
  type RenderedField
} from "../src/index.js";

const NEVER_ADDED = new Set([
  "id", "name", "type", "url_name", "owner_org", "tag_string", "title_translated", "notes_translated"
]);

type SchemaField = { field_name?: unknown; label?: unknown; display_snippet?: unknown };

export function renderSchemaFields(
  pkg: Record<string, any>,
  schema: { dataset_fields?: SchemaField[] },
  shown: ReadonlySet<string> = new Set()
): RenderedField[] {
  const specs = (schema.dataset_fields ?? []).map((f) =>
    f && typeof f === "object"
      ? ({ name: f.field_name, label: f.label, hidden: "display_snippet" in f && f.display_snippet === null } as FieldSpec)
      : (f as unknown as FieldSpec)
  );
  return renderFields(pkg, specs, { exclude: NEVER_ADDED, shown });
}

export const formatFieldsMarkdown = (fields: RenderedField[]) =>
  coreFormatFieldsMarkdown(fields, {
    source: "the data portal",
    truncatedNote: "[shortened here; the full value is in the Full JSON metadata]"
  });
