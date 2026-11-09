/**
 * The CKAN profile: behaves like ondata/ckan-mcp-server at 09e8cdc (tool names, arguments,
 * texts, JSON shape), checked case by case by the black-box parity test
 * (tests/parity, docs/test-parity.md). Ported in rounds; see docs/DECISIONS.md.
 */

import type { Profile, ToolSpec } from "@ondata-extended/profile-contract";
import { HONEST_USER_AGENT } from "./utils/http.js";
import { SHRINKABLE_KEYS, UNTRUSTED_SOURCE } from "./utils/formatting.js";
import { STATUS_TOOLS } from "./tools/status.js";
import { TAG_TOOLS } from "./tools/tag.js";
import { ORGANIZATION_TOOLS } from "./tools/organization.js";
import { GROUP_TOOLS } from "./tools/group.js";
import { PACKAGE_TOOLS } from "./tools/package.js";
import { DATASTORE_TOOLS } from "./tools/datastore.js";

export const PROFILE_ID = "ckan";
export const TOOL_PREFIX = "ckan_";
export const PROFILE_VERSION = "0.0.0";

export { makeCkanRequest, formatCkanError, extractCkanErrorMessage, CkanApiError, CkanTransportError, getTtlForAction } from "./utils/http.js";

/** The arguments ondata's Worker logs per call (src/worker.ts:282-309), besides tool and server. */
export const TELEMETRY_FIELDS = [
  "q", "fq", "query", "id", "name", "pattern", "resource_id", "format_filter", "sort", "rows", "limit", "sql",
  "country", "language", "has_datastore", "min_datasets", "page", "page_size", "offset", "distinct", "filters", "fields"
];

export const CKAN_TOOLS: ToolSpec<any>[] = [...PACKAGE_TOOLS, ...ORGANIZATION_TOOLS, ...DATASTORE_TOOLS, ...STATUS_TOOLS, ...TAG_TOOLS, ...GROUP_TOOLS];

export function createCkanProfile(): Profile {
  return {
    id: PROFILE_ID,
    version: PROFILE_VERSION,
    toolPrefix: TOOL_PREFIX,
    tools: CKAN_TOOLS,
    shrinkableKeys: SHRINKABLE_KEYS,
    telemetryFields: TELEMETRY_FIELDS,
    untrustedSourceLabel: UNTRUSTED_SOURCE,
    honestUserAgent: HONEST_USER_AGENT
  };
}
