/**
 * The SKOS profile's tools. Names, arguments and output are SKOS, whatever the backend.
 *
 * Every tool takes `vocab` (optional: a known vocabulary id or a service base URL) and
 * `response_format` ("markdown" for reading, "json" for programs). A concept is addressed by
 * the backend's local `id` or by its concept URI.
 */

import { z } from "zod";
import type { EngineContext, InstanceEntry, ToolResult, ToolSpec } from "@ondata-extended/profile-contract";
import { RandomConceptNotOfferedError, type Concept, type ConceptRef, type Note, type SearchHit, type VocabularyAdapter, type VocabularyInstance } from "./model.js";
import { createResolver, type VocabExt } from "./vocabularies.js";
import { localId } from "./ids.js";
import { createChangeTools } from "./change-tools.js";
import { writtenAt } from "./fresh.js";

export { localId };

type Entries = readonly InstanceEntry<VocabExt>[];
const vocabArgBase = z.string().max(500).optional();
const MAX_LISTED = 20;

/** "'id' (Title), …" for at most MAX_LISTED entries, with the rest counted. */
function listed(entries: Entries): string {
  const shown = entries.slice(0, MAX_LISTED).map((e) => `'${e.id}'${e.ext.title ? ` (${e.ext.title})` : ""}`).join(", ");
  return entries.length > MAX_LISTED ? `${shown}, and ${entries.length - MAX_LISTED} more` : shown;
}

/**
 * Server instructions for the model, from the deployment's vocabularies: when to use these tools instead of memory or a
 * web search, and how to cite. `extra` is the deployment's own addition (what its vocabularies are for), appended.
 */
export function skosInstructions(entries: Entries, extra?: string): string {
  const where = entries.length
    ? `the controlled vocabularies ${listed(entries)} (and other vocabulary services the server may reach, by base URL)`
    : "controlled vocabularies on a vocabulary service, given by its base URL";
  const text =
    `These vocab_ tools read ${where}, live from the vocabulary service (SKOS: concepts, labels, definitions and notes, ` +
    "broader, narrower and related concepts, mappings to other vocabularies and languages). " +
    "When the user asks about one of these vocabularies, or the work at hand uses one (what a term means in it, its preferred " +
    "label, its place in the hierarchy, its neighbours, its equivalent in another language), look it up with these tools " +
    "instead of answering from memory or searching the web: vocab_search_concepts first, then vocab_get_concept. In the " +
    "answer, use the vocabulary's preferred terms, quote definitions and scope notes as given, and name the source as each " +
    "answer gives it (the vocabulary, its creator and its URI), with the concept URIs, so the answer can be checked and " +
    "attributed. If the vocabulary has no matching concept, say so rather than filling the gap from memory. For a " +
    "random concept (\"show me a random term\"), use vocab_random_concept rather than picking an id. For " +
    "general questions about words that do not involve these vocabularies, the tools are not needed.";
  return extra?.trim() ? `${text}\n\n${extra.trim()}` : text;
}

/** The `vocab` argument, described with the deployment's own vocabularies, so a model knows which ids exist. */
export function vocabArgDescription(entries: Entries): string {
  if (entries.length === 0) {
    return "Vocabulary to use: the base URL of a vocabulary service (e.g. 'https://vocab.example.org/').";
  }
  return `Vocabulary to use: a known id: ${listed(entries)}; or the base URL of another vocabulary service this server may reach. ` +
    `Omit for the default vocabulary ('${entries[0].id}').`;
}
const formatArg = z.enum(["markdown", "json"]).default("markdown")
  .describe("Output format: 'markdown' for reading, 'json' for structured data");
const idArg = z.string().min(1).max(500)
  .describe("The concept's id in the vocabulary (e.g. '10') or its concept URI as returned by these tools. A URI also selects its vocabulary when `vocab` is omitted. Get ids from vocab_search_concepts or vocab_suggest.");
const limitArg = z.number().int().min(1).max(200).default(50).describe("Maximum number of concepts to return (1-200, default 50)");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
/** Read-only, but each call may answer differently. */
const READ_ONLY_RANDOM = { ...READ_ONLY, idempotentHint: false } as const;

function resolve(entries: Entries, vocab: string | undefined): { instance: VocabularyInstance; adapter: VocabularyAdapter } {
  return createResolver(entries).resolve(vocab);
}

export class ForeignConceptUriError extends Error {
  constructor(uri: string, vocab: string) {
    super(`The concept URI "${uri}" does not belong to vocabulary "${vocab}".`);
    this.name = "ForeignConceptUriError";
  }
}

/**
 * Host (lower case) and the rest of a URL with repeated slashes in the path collapsed, without the scheme: http and https
 * forms of a concept URI name the same concept. Null if not a URL.
 */
function normalized(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `//${url.host.toLowerCase()}${url.pathname.replace(/\/{2,}/g, "/")}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * What a concept URI of a vocabulary starts with: its base URL (as a directory, so ".../en/" never matches ".../english/")
 * and, if set, its concept URI base exactly as given ("the text before the id", which may end in "?tema=").
 */
function prefixesOf(baseUrl: string, conceptUriBase?: string): string[] {
  const out: string[] = [];
  const base = normalized(baseUrl);
  if (base) out.push(base.endsWith("/") ? base : `${base}/`);
  const concept = normalized(conceptUriBase);
  if (concept) out.push(concept);
  return out;
}

const belongsTo = (uri: string, prefixes: string[]) => prefixes.some((p) => uri.startsWith(p));

/**
 * The vocabulary and local id for a concept argument. A URI picks its vocabulary when `vocab` is omitted (the known
 * vocabulary whose base URL or concept URI base is the longest prefix of it), and must belong to the chosen vocabulary;
 * otherwise a URI from elsewhere, or from another vocabulary on the same host, would silently resolve to a different
 * concept with the same id.
 */
function resolveConcept(entries: Entries, vocab: string | undefined, idOrUri: string) {
  const raw = idOrUri.trim();
  const isUri = /^https?:\/\//i.test(raw);
  const uri = isUri ? normalized(raw) : null;
  const resolver = createResolver(entries);
  let chosen = vocab;
  if (uri && !vocab) {
    let best: { id: string; length: number } | undefined;
    for (const e of resolver.registry.all()) {
      for (const p of prefixesOf(e.baseUrl, e.ext.conceptUriBase)) {
        if (uri.startsWith(p) && (!best || p.length > best.length)) best = { id: e.id, length: p.length };
      }
    }
    if (best) chosen = best.id;
  }
  const { instance, adapter } = resolver.resolve(chosen);
  if (isUri && !(uri && belongsTo(uri, prefixesOf(instance.baseUrl, instance.conceptUriBase)))) {
    throw new ForeignConceptUriError(raw, instance.id);
  }
  return { instance, adapter, id: localId(idOrUri) };
}

class ConceptNotFoundError extends Error {
  constructor(id: string, vocab: string) {
    super(`No concept with id "${id}" in vocabulary "${vocab}".`);
    this.name = "ConceptNotFoundError";
  }
}

class NoRandomConceptError extends Error {
  constructor(vocab: string) {
    super(`The vocabulary service of "${vocab}" gave no concept to pick: the vocabulary may be empty.`);
    this.name = "NoRandomConceptError";
  }
}

// ---------------------------------------------------------------------------------------
// Markdown

function refLine(ctx: EngineContext, r: ConceptRef): string {
  return `- ${ctx.output.sanitizeInline(r.prefLabel)} (id \`${ctx.output.sanitizeInline(r.id)}\`)`;
}

function refList(ctx: EngineContext, title: string, refs: ConceptRef[]): string {
  if (refs.length === 0) return "";
  return `\n## ${title} (${refs.length})\n\n${refs.map((r) => refLine(ctx, r)).join("\n")}\n`;
}

const NOTE_TITLES: Record<Note["type"], string> = {
  definition: "Definition",
  scopeNote: "Scope note",
  historyNote: "History note",
  editorialNote: "Editorial note",
  changeNote: "Change note",
  example: "Example",
  note: "Note"
};

function conceptMarkdown(ctx: EngineContext, c: Concept, vocab: VocabularyInstance): string {
  const o = ctx.output;
  let md = `# ${o.sanitizeInline(c.prefLabel)}\n\n`;
  md += `- **URI**: ${o.safeUrlText(c.uri)}\n- **id**: \`${o.sanitizeInline(c.id)}\`\n- **Vocabulary**: ${o.sanitizeInline(vocab.id)}\n`;
  if (c.lang) md += `- **Language**: ${o.sanitizeInline(c.lang)}\n`;
  if (c.path.length > 1) md += `- **Path**: ${c.path.map((p) => o.sanitizeInline(p.prefLabel)).join(" › ")}\n`;
  if (c.altLabels.length) md += `- **Alternative labels**: ${c.altLabels.map((l) => o.sanitizeInline(l.value)).join("; ")}\n`;
  if (c.created) md += `- **Created**: ${o.sanitizeInline(c.created)}\n`;
  if (c.modified) md += `- **Modified**: ${o.sanitizeInline(c.modified)}\n`;
  if (c.ext.tematres && (c.ext.tematres as Record<string, unknown>).isMetaTerm) {
    md += "- **Grouping term**: yes (a TemaTres meta-term: it groups concepts and is not meant for indexing)\n";
  }
  for (const n of c.notes) {
    md += `\n## ${NOTE_TITLES[n.type]}${n.lang ? ` (${o.sanitizeInline(n.lang)})` : ""}\n\n${o.wrapUntrusted(n.value)}\n`;
  }
  md += refList(ctx, "Broader", c.broader);
  md += refList(ctx, "Narrower", c.narrower);
  md += refList(ctx, "Related", c.related);
  if (c.mappings.length) {
    md += `\n## Mappings (${c.mappings.length})\n\n`;
    md += c.mappings.map((m) => `- ${m.type}${m.label ? ` ${o.sanitizeInline(m.label)}` : ""}${m.uri ? ` ${o.safeUrlText(m.uri)}` : ""}${m.scheme ? ` in ${o.sanitizeInline(m.scheme)}` : ""}`).join("\n") + "\n";
  }
  return md;
}

function hitsMarkdown(ctx: EngineContext, title: string, hits: SearchHit[], total: number): string {
  const o = ctx.output;
  if (total === 0) return `# ${title}\n\nNo concepts found.`;
  let md = `# ${title}\n\n${total} concept(s)${hits.length < total ? `, showing ${hits.length}` : ""}.\n\n`;
  md += hits.map((h) => {
    let line = refLine(ctx, h);
    if (h.matchedLabel) line += ` — matched the alternative label "${o.sanitizeInline(h.matchedLabel)}"`;
    return line;
  }).join("\n");
  return md;
}

function respond(ctx: EngineContext, format: "markdown" | "json", json: unknown, markdown: () => string, trailer?: string): ToolResult {
  return format === "json" ? ctx.output.json(json) : ctx.output.text(markdown(), trailer ? { trailer } : undefined);
}

// ---------------------------------------------------------------------------------------
// One concept in JSON at the character limit: cut inside the concept, so the answer keeps its identity and its source

/** The concept's lists from the one kept longest to the one given up first: those another tool gives, or that say least, go first. */
const LIST_ORDER = ["broader", "path", "altLabels", "hiddenLabels", "mappings", "related", "narrower"] as const;
/** Optional fields kept when there is room, after the notes and before the lists. */
const OPTIONAL_FIELDS = ["created", "modified"] as const;
/** What ends a note text that was cut. */
const NOTE_CUT = " … [cut]";
/** A note text is never cut below this many characters; with less room, whole notes are left out. */
const NOTE_MIN = 200;
const CUT_NOTE =
  "This concept was cut to fit the character limit. `_cut` gives, per list or field, how many entries are shown of the " +
  `total; a note ending in "${NOTE_CUT.trim()}" is not whole. vocab_narrower, vocab_related and vocab_broader give one ` +
  "list each (themselves within the same limit).";

const jsonSize = (value: unknown): number => JSON.stringify(value).length;

/** The first `n` characters of a text, without leaving half of a character that takes two UTF-16 units. */
function prefix(text: string, n: number): string {
  const p = text.slice(0, n);
  const last = p.charCodeAt(p.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? p.slice(0, -1) : p;
}

/** The largest n in lo..hi for which `fits` holds, or lo - 1 if none does; `fits` holds for every n below one that does. */
function largest(lo: number, hi: number, fits: (n: number) => boolean): number {
  let best = lo - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/**
 * A note measured once: its JSON size is `fixed` (everything but the text) plus the text's own JSON size, so a cut is
 * priced by serializing only the text's prefix, never the note's other fields (which come from upstream too).
 */
interface MeasuredNote { note: Note; fixed: number; whole: number; min: number }

/** The UTF-16 length of a text's first `points` characters (code points), or the whole text's if it has fewer. */
function unitsOf(text: string, points: number): number {
  let i = 0;
  for (let n = 0; n < points && i < text.length; n++) {
    const c = text.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
  }
  return i;
}

function measureNote(note: Note, limit: number): MeasuredNote {
  const value = note.value.length > limit ? prefix(note.value, limit + 1) : note.value;
  const fixed = jsonSize({ ...note, value: "" }) - 2;
  const whole = fixed + jsonSize(value);
  // The shortest cut keeps NOTE_MIN characters (code points, so an emoji counts as one).
  const least = unitsOf(value, NOTE_MIN);
  const min = least >= value.length ? whole : Math.min(whole, fixed + jsonSize(value.slice(0, least) + NOTE_CUT));
  return { note: value === note.value ? note : { ...note, value }, fixed, whole, min };
}

/** One note cut to at most `room` characters of JSON (with the marker, at least NOTE_MIN characters of text), or null. */
function cutNote(m: MeasuredNote, room: number): { note: Note; size: number } | null {
  if (m.whole <= room) return { note: m.note, size: m.whole };
  const text = m.note.value;
  const at = (k: number) => prefix(text, k) + NOTE_CUT;
  // From `least` UTF-16 units on, a prefix keeps at least NOTE_MIN characters (prefix never ends inside one).
  const least = unitsOf(text, NOTE_MIN);
  if (least >= text.length) return null;
  const n = largest(least, Math.min(text.length - 1, room), (k) => m.fixed + jsonSize(at(k)) <= room);
  if (n < least) return null;
  const value = at(n);
  return { note: { ...m.note, value }, size: m.fixed + jsonSize(value) };
}

/**
 * The first `count` notes in `room`, shared like water: a note smaller than the level stays whole, a note whose shortest
 * cut is above the level gets that shortest cut, the others are cut to the level. Null if their shortest forms do not fit.
 */
function shareNotes(notes: readonly MeasuredNote[], count: number, room: number): { notes: Note[]; size: number } | null {
  const avail = room - Math.max(0, count - 1); // separators
  let least = 0;
  for (let i = 0; i < count; i++) least += notes[i].min;
  if (least > avail) return null;
  // Find the level: the largest share such that sum(clamp(min_i, share, whole_i)) fits (monotonic in the share).
  const need = (level: number) => {
    let sum = 0;
    for (let i = 0; i < count; i++) sum += Math.min(notes[i].whole, Math.max(notes[i].min, level));
    return sum;
  };
  const level = largest(0, avail, (l) => need(l) <= avail);
  const out: Note[] = [];
  let size = Math.max(0, count - 1);
  for (let i = 0; i < count; i++) {
    const m = notes[i];
    const target = Math.min(m.whole, Math.max(m.min, level));
    const c = cutNote(m, target);
    if (!c) return null;
    out.push(c.note); size += c.size;
  }
  return { notes: out, size };
}

/** How many of the first notes fit in `room` at their shortest (fewer always fit if more do). */
function noteCount(notes: readonly MeasuredNote[], room: number): number {
  let used = -1; // n notes have n - 1 separators
  let n = 0;
  while (n < notes.length && used + 1 + notes[n].min <= room) used += 1 + notes[n].min, n++;
  return n;
}

/** The notes that fit in `room` characters of JSON (the list's brackets not counted), in their order, shared as above. */
function fitNotes(notes: readonly MeasuredNote[], room: number): { notes: Note[]; size: number } {
  const count = noteCount(notes, room);
  return (count && shareNotes(notes, count, room)) || { notes: [], size: 0 };
}

/**
 * A `vocab_get_concept` JSON answer that fits `limit` characters. The core shrinks top-level lists only, and here they
 * sit inside `concept`, so an answer too large would be replaced whole by the core's notice, source included. Instead
 * the answer is rebuilt from its frame (vocab, the concept's id, URI, preferred label and language, source) by filling
 * in order of value: the notes up to half the room, the optional fields, the lists in LIST_ORDER (each the longest
 * start that fits; once one is cut, the ones after it get nothing), the notes again with what is left, and `ext` if
 * it costs no whole note.
 * `_truncated`, `_cut` and `_note` say what was done. Every part is measured once, linearly in what upstream sent; the
 * rest (at most two fills, the notes' searches) is bounded by the limit, not by upstream. An answer that fits is returned as it is; if even
 * the bare frame does not fit, the answer is left to the core's notice.
 */
export function fitConceptAnswer(answer: { vocab: string; concept: Concept; source: Source }, limit: number): unknown {
  if (jsonSize(answer) <= limit) return answer;
  const full = answer.concept;
  const bare: Concept = { ...full, notes: [], ext: {} };
  for (const key of LIST_ORDER) bare[key] = [];
  for (const key of OPTIONAL_FIELDS) delete bare[key];
  type Cut = Record<string, { shown: number; total: number }>;
  const build = (concept: Concept, cut: Cut) =>
    ({ vocab: answer.vocab, concept, source: answer.source, _truncated: true, _cut: cut, _note: CUT_NOTE });
  const frameSize = (cut: Cut) => jsonSize(build(bare, cut));
  if (frameSize({}) > limit) return answer; // not even the concept's name and source fit: the core's notice

  // Nothing past `limit` entries or characters can fit; each part is measured once. A note that cannot fit even cut is
  // left out at once (counted in `_cut.notes`).
  const most0 = limit - frameSize({}); // the most room any fill can have
  // Every note is measured (linear in what upstream sent); of those that can fit at all, at most `limit` are fitted.
  const notes = full.notes.map((n) => measureNote(n, limit)).filter((m) => m.min <= most0).slice(0, limit);
  const notesWhole = notes.reduce((sum, m, i) => sum + m.whole + (i ? 1 : 0), 0);
  const lists = Object.fromEntries(LIST_ORDER.map((key) => {
    const list = (full[key] as unknown[]).slice(0, limit);
    return [key, { list, sizes: list.map(jsonSize) }];
  })) as Record<(typeof LIST_ORDER)[number], { list: unknown[]; sizes: number[] }>;
  const extSize = jsonSize(full.ext) - 2;
  const extKeys = Object.keys(full.ext).length;
  const optional = OPTIONAL_FIELDS.map((key) => ({ key, value: full[key], size: full[key] === undefined ? 0 : jsonSize(key) + jsonSize(full[key]) + 2 }));

  // "key":{"shown":n,"total":t} and a comma; keys are plain names, so this is arithmetic.
  const entry = (key: string, shown: number, total: number) => key.length + 2 + 1 + 19 + String(shown).length + String(total).length + 1;

  const extEntry = extKeys ? entry("ext", 0, extKeys) : 0;
  // `_cut.<list>` for the lists after each one, all left out; and the least those lists can cost (the next ones whole,
  // up to one that is cut with all after it).
  const later = LIST_ORDER.map((_k, i) => LIST_ORDER.slice(i + 1).reduce((sum, k) => sum + (full[k].length ? entry(k, 0, full[k].length) : 0), 0));
  const wholeSize = LIST_ORDER.map((k) => lists[k].list.length < full[k].length ? Infinity
    : lists[k].sizes.reduce((sum, x, n) => sum + x + (n ? 1 : 0), 0));
  const minRest: number[] = new Array(LIST_ORDER.length).fill(0);
  for (let i = LIST_ORDER.length - 2; i >= 0; i--) minRest[i] = Math.min(later[i], wholeSize[i + 1] + minRest[i + 1]);
  // The least all lists, and `ext`, can cost (`ext` whole when that is cheaper than saying it was left out); and the
  // least the optional fields after each one can cost (each whole or its entry, whichever is less).
  const allEntries = LIST_ORDER.reduce((sum, k) => sum + (full[k].length ? entry(k, 0, full[k].length) : 0), 0);
  const listsMin = Math.min(allEntries, wholeSize[0] + minRest[0]);
  const extMin = extKeys ? Math.min(extSize, extEntry) : 0;
  const optMin = optional.map((o) => (o.value === undefined ? 0 : Math.min(o.size, entry(o.key, 0, 1))));
  const optAfter = optional.map((_o, j) => optMin.slice(j + 1).reduce((a, b) => a + b, 0));
  // The least everything but the notes can cost: the notes never take that room.
  const rest = optMin.reduce((a, b) => a + b, 0) + listsMin + extMin;

  /**
   * The answer filled in order of value. Each `_cut` entry is paid for with a comma; `spare` gives back the first one's,
   * which has none (if no entry is made, that character is not there, and the fill is repeated without it).
   */
  function fill(spare: number) {
    const concept: Concept = { ...bare };
    const cut: Cut = {};
    let room = most0 + spare;

    // The notes first. If not all can be shown, their `_cut` entry is paid for now (its widest form).
    if (noteCount(notes, Math.max(0, room - rest)) < full.notes.length) room -= entry("notes", full.notes.length, full.notes.length);
    const forNotes = Math.max(0, room - rest);
    // As many notes as that room allows, each at least at its shortest; beyond that, up to half the room.
    const count = noteCount(notes, forNotes);
    let least = Math.max(0, count - 1);
    for (let i = 0; i < count; i++) least += notes[i].min;
    let fitted = fitNotes(notes, Math.min(forNotes, Math.max(Math.floor(room / 2), least)));
    room -= fitted.size;

    // An optional field is taken only if what follows can still be paid for at its least.
    optional.forEach(({ key, value, size }, j) => {
      if (value === undefined) return;
      if (size + optAfter[j] + listsMin + extMin <= room) { concept[key] = value; room -= size; }
      else { cut[key] = { shown: 0, total: 1 }; room -= entry(key, 0, 1); }
    });

    // The lists leave room for `ext` at its least (whole, or its entry), settled at the end.
    room -= extMin;
    // The lists in order: once one is cut, the ones after it get nothing (their entries paid for with the cut).
    let open = true;
    LIST_ORDER.forEach((key, i) => {
      const { list, sizes } = lists[key];
      const total = full[key].length;
      if (!total) return; // an empty list is never cut
      if (!open) { cut[key] = { shown: 0, total }; return; }
      if (wholeSize[i] + minRest[i] <= room) { (concept as unknown as Record<string, unknown[]>)[key] = list; room -= wholeSize[i]; return; }
      let used = 0;
      let n = 0;
      while (n < list.length && used + sizes[n] + (n ? 1 : 0) + entry(key, n + 1, total) + later[i] <= room) used += sizes[n] + (n ? 1 : 0), n++;
      (concept as unknown as Record<string, unknown[]>)[key] = list.slice(0, n);
      cut[key] = { shown: n, total };
      room -= used + entry(key, n, total) + later[i];
      open = false;
    });

    // `ext` (the backend's particulars) if it fits, then the notes again with what is left. The number of notes was
    // settled with room for every `_cut` entry, so neither can cost a whole note, only characters of a cut one.
    room += extMin;
    if (!extKeys || extSize <= room) { concept.ext = full.ext; room -= extSize; } else { cut.ext = { shown: 0, total: extKeys }; room -= extEntry; }
    if (fitted.size < notesWhole) fitted = fitNotes(notes, fitted.size + room);
    concept.notes = fitted.notes;
    if (fitted.notes.length < full.notes.length) cut.notes = { shown: fitted.notes.length, total: full.notes.length };
    return build(concept, cut);
  }
  for (const spare of [1, 0]) {
    const out = fill(spare);
    if (jsonSize(out) <= limit) return out;
  }
  return answer; // only when even the frame and what `_cut` must say do not fit
}

// ---------------------------------------------------------------------------------------
// Source: every answer names the vocabulary and its creator, as the vocabulary gives them, so it can be attributed

/** Who an answer comes from: the vocabulary's title, creator and publisher, its URI and when it last changed. */
export interface Source {
  title: string;
  creator?: string;
  publisher?: string;
  uri: string;
  modified?: string;
}

const SOURCE_TTL_MS = 60 * 60_000;
const SOURCE_RETRY_MS = 5 * 60_000;
/** How long an answer waits for its source; after that it carries the last known source or the stand-in. */
const SOURCE_WAIT_MS = 3_000;
/** A read pending this long is taken as lost (on Workers it dies with the request that started it) and started again. */
const SOURCE_PENDING_MS = 15_000;
const MAX_SOURCES = 100;
const MAX_SOURCE_FIELD = 300;

/** For tests: the production timings, so a change to them is a deliberate one. */
export const __SOURCE_TIMINGS = { ttlMs: SOURCE_TTL_MS, retryMs: SOURCE_RETRY_MS, waitMs: SOURCE_WAIT_MS, pendingMs: SOURCE_PENDING_MS, max: MAX_SOURCES, field: MAX_SOURCE_FIELD } as const;

let sourceWaitMs = SOURCE_WAIT_MS;
/** For tests: how long an answer waits for its source. */
export function __setSourceWaitForTests(ms: number | null): void {
  sourceWaitMs = ms ?? SOURCE_WAIT_MS;
}

/** One line of upstream text, at most MAX_SOURCE_FIELD characters: line breaks and control characters become spaces. */
const field = (v: unknown): string | undefined => {
  // eslint-disable-next-line no-control-regex
  const t = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim() : "";
  return t ? (t.length > MAX_SOURCE_FIELD ? `${prefix(t, MAX_SOURCE_FIELD - 1)}…` : t) : undefined;
};
/** An http(s) URI of at most `max` characters, or undefined: a URI is never cut, since a cut one names nothing. */
const uriField = (v: unknown, max = MAX_SOURCE_FIELD): string | undefined => {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t || t.length > max || /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/.test(t)) return undefined;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:" ? t : undefined;
  } catch {
    return undefined;
  }
};

interface SourceEntry {
  /** The last source read, or the stand-in after a failed or slow first read. */
  value?: Source;
  /** Until when no answer waits for a read: an hour after a good read, five minutes after a failed or slow one. */
  until: number;
  /** One of the deployment's own vocabularies: never evicted. */
  known: boolean;
  /** When the read that gave `value` started; a write to the vocabulary after it makes the value old (src/fresh.ts). */
  readAt?: number;
  /** The latest read; only it may write. */
  pending?: { at: number; done: Promise<void> };
}

type SourceOf = (ctx: EngineContext, instance: VocabularyInstance, adapter: VocabularyAdapter) => Promise<Source>;

/**
 * The sources of one set of tools (one service): remembered per process or isolate, never shared with another service
 * in the same isolate. The scheme is read at most once an hour per vocabulary. Answers wait for a read only while the
 * entry is not fresh, and only until SOURCE_WAIT_MS after that read began, each on its own timer (on Workers a timer
 * dies with the request that set it, so no answer waits on another's), all ending at that one moment; a read
 * that fails, answers with nothing usable, or is not done in that time leaves the last source (or the deployment's
 * title, or the id, with the base URL) standing for five minutes, so while the vocabulary service hangs answers wait at
 * most once in five minutes, and then at most SOURCE_WAIT_MS. A read pending SOURCE_PENDING_MS is taken as lost (on
 * Workers it dies with the request that started it); only the latest read writes. The deployment's own vocabularies
 * are never evicted; at most MAX_SOURCES vocabularies reached by base URL are kept besides. A source never fails an
 * answer.
 */
function createSourceMemo(entries: Entries): SourceOf {
  const memo = new Map<string, SourceEntry>();
  const knownIds = new Set(entries.map((e) => e.id));
  let adHoc = 0;
  return async (ctx, instance, adapter) => {
    const known = knownIds.has(instance.id);
    // A vocabulary reached by base URL is one vocabulary whether or not its URL ends in a slash.
    const key = known ? `${instance.id}|${adapter.id}|${instance.baseUrl}` : `|${adapter.id}|${instance.baseUrl.replace(/\/+$/, "")}`;
    const standIn: Source = {
      title: field(entries.find((e) => e.id === instance.id)?.ext.title) || field(instance.id) || "",
      // The base URL as given (at most 500 characters, as the argument allows), never cut.
      uri: uriField(instance.baseUrl, 500) ?? ""
    };
    const now = Date.now();
    let e = memo.get(key);
    const written = writtenAt(instance.baseUrl, now);
    if (e && now < e.until && !(written !== undefined && (e.readAt ?? 0) <= written)) return e.value ?? standIn;
    if (!e) {
      if (!known && adHoc >= MAX_SOURCES) {
        for (const [k, v] of memo) if (!v.known) { memo.delete(k); adHoc--; break; }
      }
      e = { until: 0, known };
      memo.set(key, e);
      if (!known) adHoc++;
    }
    const entry = e;
    if (!entry.pending || now - entry.pending.at >= SOURCE_PENDING_MS) {
      const pending: NonNullable<SourceEntry["pending"]> = { at: now, done: Promise.resolve() };
      const latest = () => entry.pending === pending;
      const failed = () => {
        if (!latest()) return;
        entry.value ??= standIn;
        entry.until = Date.now() + SOURCE_RETRY_MS;
        entry.readAt = pending.at;
      };
      pending.done = adapter.schemeInfo(ctx, instance).then(
        (info) => {
          if (!latest()) return;
          const title = field(info.title), creator = field(info.creator), publisher = field(info.publisher);
          if (!title && !creator && !publisher) return failed(); // nothing usable: keep the last source
          entry.value = {
            title: title || standIn.title,
            ...(creator ? { creator } : {}),
            ...(publisher ? { publisher } : {}),
            uri: uriField(info.uri) || entry.value?.uri || standIn.uri,
            ...(field(info.modified) ? { modified: field(info.modified) } : {})
          };
          entry.until = Date.now() + SOURCE_TTL_MS;
          entry.readAt = pending.at;
        },
        failed
      ).finally(() => { if (latest()) entry.pending = undefined; });
      entry.pending = pending;
    }
    const current = entry.pending!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<"slow">((r) => { timer = setTimeout(() => r("slow"), Math.max(0, current.at + sourceWaitMs - Date.now())); });
    const outcome = await Promise.race([current.done.then(() => "done" as const), slow]);
    clearTimeout(timer);
    if (outcome === "slow" && entry.pending === current && Date.now() >= entry.until) {
      // Not done in time: stand for five minutes, so later answers do not wait. The read may still finish and write.
      entry.value ??= standIn;
      entry.until = Date.now() + SOURCE_RETRY_MS;
      entry.readAt = current.at;
    }
    return entry.value ?? standIn;
  };
}

/**
 * The main answer and its source together. The source's read is started first, so on a throttled host it is not queued
 * behind the answer's own requests. The main answer's error wins; the source never fails and waits at most
 * SOURCE_WAIT_MS, so it is settled (or given up) before the tool answers or fails.
 */
async function withSource<T>(sourceOf: SourceOf, ctx: EngineContext, instance: VocabularyInstance, adapter: VocabularyAdapter, main: () => Promise<T>): Promise<[T, Source]> {
  const source = sourceOf(ctx, instance, adapter);
  const [m, src] = await Promise.allSettled([main(), source]);
  if (m.status === "rejected") throw m.reason;
  return [m.value, (src as PromiseFulfilledResult<Source>).value];
}

/** The source as a closing Markdown block, passed as the trailer so truncation keeps it. */
function sourceMarkdown(ctx: EngineContext, s: Source): string {
  const o = ctx.output;
  const by = [s.creator, s.publisher && s.publisher !== s.creator ? s.publisher : undefined].filter(Boolean)
    .map((v) => o.sanitizeInline(v as string)).join("; ");
  return `\n---\nSource: ${o.sanitizeInline(s.title)}${by ? `, by ${by}` : ""}. ${o.safeUrlText(s.uri)}` +
    `${s.modified ? ` (last changed ${o.sanitizeInline(s.modified)})` : ""}`;
}

/**
 * The nine tools for a deployment's vocabularies: `entries` are the known vocabularies (ids usable as `vocab`), the
 * first is the default. Any other vocabulary is reachable by its base URL when the deployment's allow-list lets the
 * request through.
 */
/** `changes`: offer the change tools for the writable vocabularies (only on a service behind a login). */
export function createSkosTools(entries: Entries = [], { changes = false }: { changes?: boolean } = {}): ToolSpec<any>[] {
  const vocabArg = vocabArgBase.describe(vocabArgDescription(entries));
  const sourceOf = createSourceMemo(entries);

  const searchConcepts: ToolSpec<{ query: z.ZodString; vocab: typeof vocabArg; limit: typeof limitArg; response_format: typeof formatArg }> = {
    name: "vocab_search_concepts",
    title: "Search concepts",
    description:
      "Search a controlled vocabulary (thesaurus, SKOS concept scheme) for concepts whose preferred or alternative labels contain the query. " +
      "Use it to find the concept for a word, then call vocab_get_concept with the id for its definition and relations. " +
      "Matches on alternative labels (synonyms, other languages) say which label matched. " +
      (entries.length ? `Vocabularies here: ${listed(entries)}. When a question is about one of them, prefer this tool to memory or a web search. ` : "") +
      "Example: { query: 'data' }.",
    inputSchema: {
      query: z.string().min(2).max(200).describe("Text to look for in labels (at least two characters; case-insensitive, substring)"),
      vocab: vocabArg,
      limit: limitArg,
      response_format: formatArg
    },
    annotations: { title: "Search concepts", ...READ_ONLY },
    async handler(args, ctx) {
      const { instance, adapter } = resolve(entries, args.vocab);
      const [all, source] = await withSource(sourceOf, ctx, instance, adapter, () => adapter.search(ctx, instance, args.query));
      const shown = all.slice(0, args.limit);
      return respond(ctx, args.response_format, { vocab: instance.id, query: args.query, count: all.length, concepts: shown, source },
        () => hitsMarkdown(ctx, `Concepts matching "${ctx.output.sanitizeInline(args.query)}"`, shown, all.length), sourceMarkdown(ctx, source));
    }
  };

  const suggest: ToolSpec<{ prefix: z.ZodString; vocab: typeof vocabArg; limit: typeof limitArg; response_format: typeof formatArg }> = {
    name: "vocab_suggest",
    title: "Suggest concepts",
    description:
      "Autocomplete: concepts whose labels start with or contain the given text, as a user types. " +
      "Prefer vocab_search_concepts for a whole word; use this for a fragment of a few letters. " +
      "TemaTres returns at most 50 suggestions, so the count is not a total. Example: { prefix: 'dat' }.",
    inputSchema: {
      prefix: z.string().min(2).max(100).describe("The beginning of a label (at least two characters; three or more gives better results)"),
      vocab: vocabArg,
      limit: z.number().int().min(1).max(50).default(50).describe("Maximum number of suggestions (1-50, default 50)"),
      response_format: formatArg
    },
    annotations: { title: "Suggest concepts", ...READ_ONLY },
    async handler(args, ctx) {
      const { instance, adapter } = resolve(entries, args.vocab);
      const [all, source] = await withSource(sourceOf, ctx, instance, adapter, () => adapter.suggest(ctx, instance, args.prefix));
      const shown = all.slice(0, args.limit);
      return respond(ctx, args.response_format, { vocab: instance.id, prefix: args.prefix, count: all.length, capped: all.length >= 50, concepts: shown, source },
        () => hitsMarkdown(ctx, `Suggestions for "${ctx.output.sanitizeInline(args.prefix)}"`, shown, all.length) +
          (all.length >= 50 ? "\n\nThe service returns at most 50 suggestions; type more letters to narrow them." : ""),
        sourceMarkdown(ctx, source));
    }
  };

  const getConcept: ToolSpec<{ id: typeof idArg; vocab: typeof vocabArg; response_format: typeof formatArg }> = {
    name: "vocab_get_concept",
    title: "Get concept",
    description:
      "Everything about one concept: preferred and alternative labels, definition and other notes, broader, narrower and related concepts, " +
      "mappings to other vocabularies, and its path from the top of the hierarchy. Notes are text from the vocabulary service, shown as quoted data. " +
      "Example: { id: '10' }.",
    inputSchema: { id: idArg, vocab: vocabArg, response_format: formatArg },
    annotations: { title: "Get concept", ...READ_ONLY },
    async handler(args, ctx) {
      const { instance, adapter, id } = resolveConcept(entries, args.vocab, args.id);
      const [concept, source] = await withSource(sourceOf, ctx, instance, adapter, () => adapter.getConcept(ctx, instance, id));
      if (!concept) throw new ConceptNotFoundError(id, instance.id);
      ctx.telemetry.note({ concept_id: id });
      const answer = { vocab: instance.id, concept, source };
      return respond(ctx, args.response_format, args.response_format === "json" ? fitConceptAnswer(answer, ctx.limits.characterLimit) : answer,
        () => conceptMarkdown(ctx, concept, instance), sourceMarkdown(ctx, source));
    }
  };

  const randomConcept: ToolSpec<{ vocab: typeof vocabArg; response_format: typeof formatArg }> = {
    name: "vocab_random_concept",
    title: "Random concept",
    description:
      "One concept of the vocabulary picked at random, answered as vocab_get_concept answers (labels, notes, relations, path). " +
      "Use it when the user asks for a random term or concept (e.g. \"show me a random term\"), instead of guessing an id. " +
      "Each call may give another concept.",
    inputSchema: { vocab: vocabArg, response_format: formatArg },
    annotations: { title: "Random concept", ...READ_ONLY_RANDOM },
    async handler(args, ctx) {
      const { instance, adapter } = resolve(entries, args.vocab);
      const pick = adapter.randomConcept?.bind(adapter);
      if (!pick) throw new RandomConceptNotOfferedError(instance.id);
      const [concept, source] = await withSource(sourceOf, ctx, instance, adapter, () => pick(ctx, instance));
      if (!concept) throw new NoRandomConceptError(instance.id);
      ctx.telemetry.note({ concept_id: concept.id });
      const answer = { vocab: instance.id, concept, source };
      return respond(ctx, args.response_format, args.response_format === "json" ? fitConceptAnswer(answer, ctx.limits.characterLimit) : answer,
        () => conceptMarkdown(ctx, concept, instance), sourceMarkdown(ctx, source));
    }
  };

  function relationTool(
    name: string,
    title: string,
    description: string,
    pick: (a: VocabularyAdapter) => VocabularyAdapter["broader"]
  ): ToolSpec<{ id: typeof idArg; vocab: typeof vocabArg; response_format: typeof formatArg }> {
    return {
      name,
      title,
      description,
      inputSchema: { id: idArg, vocab: vocabArg, response_format: formatArg },
      annotations: { title, ...READ_ONLY },
      async handler(args, ctx) {
        const { instance, adapter, id } = resolveConcept(entries, args.vocab, args.id);
        const [refs, source] = await withSource(sourceOf, ctx, instance, adapter, () => pick(adapter).call(adapter, ctx, instance, id));
        if (refs === null) throw new ConceptNotFoundError(id, instance.id);
        return respond(ctx, args.response_format, { vocab: instance.id, id, concepts: refs, source }, () =>
          (refs.length ? `# ${title} of concept ${ctx.output.sanitizeInline(id)}\n\n${refs.map((r) => refLine(ctx, r)).join("\n")}` : `# ${title} of concept ${ctx.output.sanitizeInline(id)}\n\nNone.`),
          sourceMarkdown(ctx, source));
      }
    };
  }

  const broader = relationTool("vocab_broader", "Broader concepts",
    "The concepts directly above this one in the hierarchy (skos:broader). More than one when the vocabulary is polyhierarchical. " +
    "For the whole path to the top, use vocab_get_concept. Example: { id: '10' }.",
    (a) => a.broader);
  const narrower = relationTool("vocab_narrower", "Narrower concepts",
    "The concepts directly below this one in the hierarchy (skos:narrower). Call again on a result to go deeper. Example: { id: '36' }.",
    (a) => a.narrower);
  const related = relationTool("vocab_related", "Related concepts",
    "Concepts associated with this one outside the hierarchy (skos:related). Example: { id: '2' }.",
    (a) => a.related);

  const topConcepts: ToolSpec<{ vocab: typeof vocabArg; response_format: typeof formatArg }> = {
    name: "vocab_top_concepts",
    title: "Top concepts",
    description:
      "The top of the vocabulary's hierarchy (skos:hasTopConcept): where to start browsing with vocab_narrower. " +
      "In TemaTres these are often grouping terms rather than concepts for indexing.",
    inputSchema: { vocab: vocabArg, response_format: formatArg },
    annotations: { title: "Top concepts", ...READ_ONLY },
    async handler(args, ctx) {
      const { instance, adapter } = resolve(entries, args.vocab);
      const [refs, source] = await withSource(sourceOf, ctx, instance, adapter, () => adapter.topConcepts(ctx, instance));
      return respond(ctx, args.response_format, { vocab: instance.id, concepts: refs, source }, () =>
        `# Top concepts of ${ctx.output.sanitizeInline(instance.id)}\n\n${refs.map((r) => refLine(ctx, r)).join("\n") || "None."}`,
        sourceMarkdown(ctx, source));
    }
  };

  const schemeInfo: ToolSpec<{ vocab: typeof vocabArg; response_format: typeof formatArg }> = {
    name: "vocab_scheme_info",
    title: "Vocabulary information",
    description:
      "About the vocabulary itself (skos:ConceptScheme): title, URI, languages, size, dates, creator and the software it runs on. " +
      "Call it first to see what a vocabulary covers. Size: `termCount` counts preferred and alternative terms together, so it is " +
      "not the number of concepts; `conceptCount` is given only where the number of concepts is known. When it is absent, the " +
      "number of concepts is not known here: say so, and do not derive it from `termCount`.",
    inputSchema: { vocab: vocabArg, response_format: formatArg },
    annotations: { title: "Vocabulary information", ...READ_ONLY },
    async handler(args, ctx) {
      const { instance, adapter } = resolve(entries, args.vocab);
      const info = await adapter.schemeInfo(ctx, instance);
      return respond(ctx, args.response_format, { vocab: instance.id, scheme: info }, () => {
        const o = ctx.output;
        let md = `# ${o.sanitizeInline(info.title || instance.id)}\n\n- **URI**: ${o.safeUrlText(info.uri)}\n- **Id here**: ${o.sanitizeInline(instance.id)}\n`;
        if (info.languages.length) md += `- **Languages**: ${info.languages.map((l) => o.sanitizeInline(l)).join(", ")}\n`;
        if (info.conceptCount !== undefined) {
          const snap = info.ext.snapshot as { lastModified?: unknown } | undefined;
          const from = snap ? ` (in the vocabulary's snapshot${typeof snap.lastModified === "string" ? ` of ${o.sanitizeInline(snap.lastModified)}` : ""})` : "";
          md += `- **Concepts**: ${info.conceptCount}${from}\n`;
        }
        if (info.termCount !== undefined) {
          md += `- **Terms, preferred and alternative**: ${info.termCount} (not the number of concepts` +
            `${info.conceptCount === undefined ? ", which is not known here" : ""})\n`;
        }
        if (info.created) md += `- **Created**: ${o.sanitizeInline(info.created)}\n`;
        if (info.modified) md += `- **Modified**: ${o.sanitizeInline(info.modified)}\n`;
        if (info.creator) md += `- **Creator**: ${o.sanitizeInline(info.creator)}\n`;
        if (info.publisher) md += `- **Publisher**: ${o.sanitizeInline(info.publisher)}\n`;
        if (info.rights) md += `- **Rights**: ${o.sanitizeInline(info.rights)}\n`;
        if (info.software) md += `- **Software**: ${o.sanitizeInline(info.software)}\n`;
        if (info.description) md += `\n${o.wrapUntrusted(info.description)}\n`;
        return md;
      });
    }
  };

  // The change tools only when the deployment offers them (a service behind a login) and gives a vocabulary write access (src/change-tools.ts).
  return [searchConcepts, getConcept, broader, narrower, related, topConcepts, suggest, schemeInfo, randomConcept, ...(changes ? createChangeTools(entries) : [])];
}

export { ConceptNotFoundError };
