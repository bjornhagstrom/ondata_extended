/**
 * Root fields declared by a ckanext-scheming schema.
 *
 * Ported from ondata/ckan-mcp-server src/utils/scheming.ts at 09e8cdc (MIT, see NOTICE.md).
 * The renderer itself (cleaning, capping, Markdown) moved to the core as a generic field
 * renderer (`renderFields`, `formatFieldsMarkdown`); what stays here is ondata's: which fields
 * are never added, the schema's shape, the untrusted-source label, the shortened-value note,
 * and fetching the schema with its negative cache.
 *
 * `package_show` returns every field a portal stores, but the tool output carries a fixed
 * list. On a portal that uses ckanext-scheming the rest (keywords, coverage, subject,
 * contacts, ...) never reached the caller. `renderSchemaFields` adds those fields, each
 * with the label the schema gives it. Values are passed on as stored: translated values
 * stay `{"en": ..., "fr": ...}`, codes stay codes.
 */

import type { EngineContext } from "@ondata-extended/profile-contract";
import {
  formatFieldsMarkdown as coreFormatFieldsMarkdown,
  renderFields,
  type FieldSpec,
  type RenderedField
} from "@ondata-extended/core";
import { makeCkanRequest } from "./http.js";
import { getPortalApiUrlForHostname } from "./portal-config.js";
import { UNTRUSTED_SOURCE } from "./formatting.js";

export { MAX_FIELD_TEXT, cleanText, type RenderedField } from "@ondata-extended/core";

type SchemaField = {
  field_name?: string;
  label?: unknown;
  display_snippet?: unknown;
};

export type DatasetSchema = {
  dataset_fields?: SchemaField[];
};

/**
 * Fields never added, whatever the output: CKAN bookkeeping, and translated twins of the
 * title and description. What each output (Markdown, JSON) really shows is passed in by the
 * caller, since the two differ.
 */
const NEVER_ADDED = new Set([
  "id", "name", "type", "url_name", "owner_org", "tag_string", "title_translated", "notes_translated"
]);

/**
 * The schema's root fields that the dataset has a value for and that the output being built
 * does not already show. `shown` names what that output carries (it differs between
 * Markdown and JSON, so the caller knows best); a value the output cannot show is not
 * "shown" and so comes through here.
 */
export function renderSchemaFields(
  pkg: Record<string, any>,
  schema: DatasetSchema,
  shown: ReadonlySet<string> = new Set()
): RenderedField[] {
  // a schema is portal input too: a malformed entry is passed on as is, and the core skips it
  const specs = (schema.dataset_fields ?? []).map((f) =>
    f && typeof f === "object"
      ? ({ name: f.field_name, label: f.label, hidden: "display_snippet" in f && f.display_snippet === null } as FieldSpec)
      : (f as unknown as FieldSpec)
  );
  return renderFields(pkg, specs, { exclude: NEVER_ADDED, shown });
}

/** Markdown bullets for rendered fields: label, then the field name in code, then the value. */
export function formatFieldsMarkdown(fields: RenderedField[]): string {
  return coreFormatFieldsMarkdown(fields, {
    source: UNTRUSTED_SOURCE,
    truncatedNote: "[shortened here; the full value is in the Full JSON metadata]"
  });
}

const SHORT_TTL_MS = 5 * 60 * 1000;
const LONG_TTL_MS = 60 * 60 * 1000;
const MAX_NO_SCHEMA = 200;
const noSchema = new Map<string, number>();

export function __resetSchemaCacheForTests(): void {
  noSchema.clear();
}

/**
 * The portal's scheming schema for a dataset type, or null. Any failure means "no schema"
 * and is not reported: portals without scheming answer 404 or 400 ("action not known"),
 * a slow or failing one times out or answers 5xx. Positive answers are cached by
 * `makeCkanRequest`; a missing schema is remembered for an hour (404, 400) or five minutes
 * (anything else), so `package_show` does not pay for a second request on every call.
 */
export async function getDatasetSchema(ctx: EngineContext, serverUrl: string, type: string = "dataset"): Promise<DatasetSchema | null> {
  const key = `${cacheOrigin(serverUrl)}|${type}`;
  const until = noSchema.get(key);
  if (until !== undefined && until > Date.now()) return null;
  try {
    const schema = await makeCkanRequest<DatasetSchema>(ctx, serverUrl, "scheming_dataset_schema_show", { type });
    if (schema && Array.isArray(schema.dataset_fields)) return schema;
    remember(key, LONG_TTL_MS);
    return null;
  } catch (error) {
    const status = (error as { status?: number }).status;
    remember(key, status === 404 || status === 400 ? LONG_TTL_MS : SHORT_TTL_MS);
    return null;
  }
}

/** Scheme and host are case-insensitive, the path is not: `/Data` and `/data` are two portals. Configured portal aliases resolve to one address. */
function cacheOrigin(serverUrl: string): string {
  try {
    // the same portal under another address must share the entry, as it shares the request cache
    const resolved = getPortalApiUrlForHostname(new URL(serverUrl).hostname);
    const url = new URL(resolved ?? serverUrl);
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return serverUrl.trim();
  }
}

function remember(key: string, ttl: number): void {
  if (noSchema.size >= MAX_NO_SCHEMA) noSchema.clear();
  noSchema.set(key, Date.now() + ttl);
}
