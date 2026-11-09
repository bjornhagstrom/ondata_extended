/**
 * Render untrusted key/value fields with labels: the "other properties" of a record that a
 * fixed output does not show (extra metadata fields, adapter-specific properties).
 *
 * Every string here comes from the upstream (names, labels, values): each is stripped of
 * control characters and capped, nesting is bounded, and the Markdown renderer escapes
 * links, images and HTML.
 *
 * Derived from ondata/ckan-mcp-server src/utils/scheming.ts (commit 09e8cdc), lines 1-142
 * and 186-225, without the schema fetch: the caller passes the field list, the names to
 * leave out, and the note shown when a value was shortened.
 */

import { sanitizeInline, wrapUntrusted } from "./format.js";

export const MAX_FIELD_TEXT = 2000;
const MAX_LABEL_TEXT = 200;
const MAX_DEPTH = 4;

export interface RenderedField {
  field: string;
  label: string;
  value: unknown;
  /** True when a string in `value` was cut at MAX_FIELD_TEXT or nested data was left out. */
  truncated?: true;
}

/** A field to render: its name in the record and an optional label (a string, or one string per language). */
export interface FieldSpec {
  name: string;
  label?: unknown;
  /** The upstream's own way to say "do not show". */
  hidden?: boolean;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

type Cut = { done: boolean };

export function cleanText(value: unknown, limit: number = MAX_FIELD_TEXT, cut?: Cut): string {
  const text = String(value).replace(CONTROL, "");
  if (text.length <= limit) return text;
  if (cut) cut.done = true;
  return text.slice(0, limit) + "…";
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);
}

/**
 * Copy of a stored value with every string cleaned. Structure kept as stored (null and
 * empty members stay, so positions in a list do not shift); anything cut is flagged.
 */
export function plainValue(value: unknown, cut: Cut = { done: false }, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value) || (value && typeof value === "object")) {
    if (depth >= MAX_DEPTH) {
      cut.done = true;
      return "[nested data omitted]";
    }
    if (Array.isArray(value)) return value.map((v) => plainValue(v, cut, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      let key = cleanText(k, MAX_LABEL_TEXT, cut);
      // cleaning can make two keys equal; keep both rather than let one overwrite the other
      for (let n = 2; Object.hasOwn(out, key); n++) {
        cut.done = true;
        key = `${cleanText(k, MAX_LABEL_TEXT)}~${n}`;
      }
      // defined, not assigned: an upstream key `__proto__` must stay a key
      Object.defineProperty(out, key, { value: plainValue(v, cut, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return cleanText(value, MAX_FIELD_TEXT, cut);
}

/** A label is a string, or one string per language: take `preferredLang`, then English, then the first. */
function labelText(label: unknown, fallback: string, preferredLang: string | undefined, cut?: Cut): string {
  let text: unknown = label;
  if (label && typeof label === "object" && !Array.isArray(label)) {
    const dict = label as Record<string, unknown>;
    text = (preferredLang ? dict[preferredLang] : undefined) ?? dict.en ??
      Object.values(dict).find((v) => typeof v === "string" && v);
  }
  return cleanText(typeof text === "string" && text ? text : fallback, MAX_LABEL_TEXT, cut);
}

/**
 * The listed fields the record has a value for, minus `exclude` and what the output already
 * `shown`. Each field once, however often it is listed; a malformed entry is skipped.
 */
export function renderFields(
  record: Record<string, unknown>,
  fields: readonly FieldSpec[],
  opts: { exclude?: ReadonlySet<string>; shown?: ReadonlySet<string>; preferredLang?: string } = {}
): RenderedField[] {
  const out: RenderedField[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    const name = field.name;
    if (typeof name !== "string" || opts.exclude?.has(name) || opts.shown?.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    if (field.hidden) continue;
    const value = Object.hasOwn(record, name) ? record[name] : undefined;
    if (isEmpty(value)) continue;
    const cut: Cut = { done: false };
    const clean = plainValue(value, cut);
    if (isEmpty(clean)) continue;
    const item: RenderedField = {
      field: cleanText(name, MAX_LABEL_TEXT, cut),
      label: labelText(field.label, name, opts.preferredLang, cut),
      value: clean
    };
    if (cut.done) item.truncated = true;
    out.push(item);
  }
  return out;
}

/**
 * Brackets and angle brackets escaped so links, images and HTML stay text. A backslash is
 * doubled first, or it would swallow the escapes added after it.
 */
const escaped = (value: unknown): string =>
  sanitizeInline(String(value).replace(/\\/g, "\\\\")).replace(/[[\]<>]/g, "\\$&");

function markdownValue(value: unknown, source: string): { inline: string; block?: string } {
  if (typeof value === "string") {
    return value.length > 300 || /[\r\n]/.test(value)
      ? { inline: "", block: wrapUntrusted(value, source) }
      : { inline: escaped(value) };
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return { inline: value.map((v) => escaped(v)).join(", ") };
  }
  if (value && typeof value === "object") return { inline: escaped(JSON.stringify(value)) };
  return { inline: escaped(value) };
}

/** Markdown bullets: label, field name in code, then the value. */
export function formatFieldsMarkdown(
  fields: readonly RenderedField[],
  opts: { source: string; truncatedNote: string }
): string {
  let out = "";
  for (const f of fields) {
    const { inline, block } = markdownValue(f.value, opts.source);
    out += `- **${escaped(f.label)}** (\`${sanitizeInline(f.field)}\`):${block ? "\n\n" + block + "\n" : " " + inline}`;
    if (f.truncated) out += ` ${opts.truncatedNote}`;
    out += "\n";
  }
  return out;
}
