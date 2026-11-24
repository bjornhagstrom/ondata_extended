/**
 * A vocabulary answered from a full snapshot of it: one JSON object per line (NDJSON), one line per concept, with SKOS
 * property names (`uri`, `prefLabel: {lang: text}`, `altLabel`/`hiddenLabel`/notes: `{lang: [text]}`,
 * `broader`/`narrower`/`related`/mappings/`topConceptOf`: `[uri]`, `created`, `modified`).
 *
 * The snapshot is loaded once per process or Worker isolate and kept in memory. At most once a minute a call asks the
 * server whether the file changed (`If-None-Match`, `If-Modified-Since`): a 304 keeps the copy, a 200 replaces it. Every
 * request goes through the core's HTTP client and its guards.
 *
 * The snapshot answers only when it has every concept an answer names. Everything else goes to the vocabulary's own adapter, as
 * without a snapshot: scheme information (to which a loaded snapshot adds the number of concepts it holds), an id or a
 * label the snapshot does not have (a concept added since the file was written), a concept that refers to one the
 * snapshot lacks, and every call while the snapshot cannot be loaded. A random concept is picked among the snapshot's.
 * A failed refresh keeps the copy it has and asks again a minute later. What the SKOS export does not carry (TemaTres
 * codes, meta-term flags, NB notes, note codes) is missing from snapshot answers; docs/DECISIONS.md lists it.
 */

import type { EngineContext } from "@ondata-extended/profile-contract";
import { RandomConceptNotOfferedError, type Concept, type ConceptRef, type Label, type Mapping, type Note, type SearchHit, type VocabularyAdapter, type VocabularyInstance } from "./model.js";
import { localId } from "./ids.js";
import { htmlToText } from "./text.js";
import { mustReadFresh } from "./fresh.js";

/** How long a loaded snapshot is used before the server is asked whether it changed. */
export const REVALIDATE_MS = 60_000;
/** How long after a failed first load the snapshot is not asked for again. */
export const RETRY_AFTER_FAILURE_MS = 60_000;
/** Snapshots kept in memory at once (one per snapshot URL a deployment names). */
const MAX_SNAPSHOTS = 20;
/** Concepts read from one snapshot at most; the rest of the file is ignored. */
const MAX_CONCEPTS = 200_000;
/**
 * How long a call waits for a load another call started before answering without it (from the copy it has, or live).
 * On Workers a request's I/O ends with the request, so a load started by a request that went away may never settle;
 * no caller waits on it for longer than this, and a load older than this is started afresh.
 */
let LOAD_WAIT_MS = 15_000;
/** At most this many suggestions, as TemaTres gives (the tool reports a full list as capped). */
const MAX_SUGGESTIONS = 50;

// TemaTres's SKOS export never writes its private notes (NP); skos:editorialNote is its editorial note (ED), which the
// live adapter shows too. Its NB notes go to dc:source, which a snapshot does not carry.
const NOTE_PROPERTIES: Note["type"][] = ["definition", "scopeNote", "historyNote", "editorialNote", "changeNote", "example", "note"];
const MAPPING_PROPERTIES = ["exactMatch", "closeMatch", "broadMatch", "narrowMatch", "relatedMatch"] as const;

interface SnapConcept {
  uri: string;
  /** prefLabel by language ("" for a label without one). */
  labels: Record<string, string>;
  altLabels: Label[];
  hiddenLabels: Label[];
  notes: Note[];
  broader: string[];
  narrower: string[];
  related: string[];
  mappings: Mapping[];
  top: boolean;
  created?: string;
  modified?: string;
}

interface Snapshot {
  byUri: Map<string, SnapConcept>;
  /** False when the file had more concepts than are read (MAX_CONCEPTS): the snapshot then gives no concept count. */
  complete: boolean;
  /** The concepts as a list, made on the first random pick. */
  list?: SnapConcept[];
  /** Whether any line has `topConceptOf`; if none has, top concepts come from the live service. */
  hasTopConceptOf: boolean;
  lastModified?: string;
}

interface State {
  snapshot?: Snapshot;
  etag?: string;
  lastModified?: string;
  /** When the server was last asked (or a failure last seen). */
  checkedAt: number;
  /** Before the first successful load: not asked again until then. */
  failedUntil?: number;
  pending?: Promise<Snapshot | null>;
  pendingSince?: number;
}

const states = new Map<string, State>();

/** Forget every loaded snapshot; for tests. */
export function __resetSnapshotsForTests(): void {
  states.clear();
  LOAD_WAIT_MS = 15_000;
}

/** Shorten the wait for another call's load; for tests. */
export function __setLoadWaitForTests(ms: number): void {
  LOAD_WAIT_MS = ms;
}

// ---------------------------------------------------------------------------------------
// Reading the file

const isString = (v: unknown): v is string => typeof v === "string";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function uriList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter(isString) : [];
}

/** `{lang: [text]}` (or `{lang: text}`) as labels; a "" language becomes no language. */
function langTexts(v: unknown): Label[] {
  if (!isObject(v)) return [];
  const out: Label[] = [];
  for (const [lang, texts] of Object.entries(v)) {
    for (const value of Array.isArray(texts) ? texts : [texts]) {
      if (isString(value) && value.trim()) out.push({ value, ...(lang ? { lang } : {}) });
    }
  }
  return out;
}

function parseLine(line: string): SnapConcept | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(o) || !isString(o.uri) || !/^https?:\/\//i.test(o.uri) || !isObject(o.prefLabel)) return null;
  const labels: Record<string, string> = {};
  for (const [lang, value] of Object.entries(o.prefLabel)) if (isString(value) && value.trim()) labels[lang] = value;
  if (Object.keys(labels).length === 0) return null;
  const notes: Note[] = [];
  for (const type of NOTE_PROPERTIES) {
    for (const l of langTexts(o[type])) notes.push({ type, value: htmlToText(l.value), ...(l.lang ? { lang: l.lang } : {}) });
  }
  const mappings: Mapping[] = [];
  for (const type of MAPPING_PROPERTIES) for (const uri of uriList(o[type])) mappings.push({ type, uri });
  return {
    uri: o.uri,
    labels,
    altLabels: langTexts(o.altLabel),
    hiddenLabels: langTexts(o.hiddenLabel),
    notes,
    broader: uriList(o.broader),
    narrower: uriList(o.narrower),
    related: uriList(o.related),
    mappings,
    top: uriList(o.topConceptOf).length > 0,
    ...(isString(o.created) ? { created: o.created } : {}),
    ...(isString(o.modified) ? { modified: o.modified } : {})
  };
}

/** The concepts of a snapshot file; null when it holds none (not a snapshot, or empty). Bad lines are skipped. */
export function parseSnapshot(text: string): Snapshot | null {
  const byUri = new Map<string, SnapConcept>();
  let hasTopConceptOf = false;
  let complete = true;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const c = parseLine(line);
    if (!c) continue;
    if (byUri.size >= MAX_CONCEPTS && !byUri.has(c.uri)) { complete = false; break; }
    if (c.top) hasTopConceptOf = true;
    byUri.set(c.uri, c);
  }
  return byUri.size ? { byUri, complete, hasTopConceptOf } : null;
}

// ---------------------------------------------------------------------------------------
// Loading and revalidating

function remember(url: string, state: State): void {
  states.delete(url);
  while (states.size >= MAX_SNAPSHOTS) states.delete(states.keys().next().value!);
  states.set(url, state);
}

async function refresh(ctx: EngineContext, url: string, state: State): Promise<Snapshot | null> {
  const headers: Record<string, string> = { Accept: "application/x-ndjson, application/json;q=0.9, */*;q=0.1" };
  if (state.snapshot && state.etag) headers["If-None-Match"] = state.etag;
  if (state.snapshot && state.lastModified) headers["If-Modified-Since"] = state.lastModified;
  try {
    const res = await ctx.http.request(url, { method: "GET", headers }, { userAgent: "honest" });
    if (res.status === 304 && state.snapshot) {
      state.checkedAt = Date.now();
      return state.snapshot;
    }
    if (res.status === 200 && res.text !== null) {
      const parsed = parseSnapshot(res.text);
      if (parsed) {
        const lastModified = res.headers["last-modified"];
        parsed.lastModified = lastModified;
        state.snapshot = parsed;
        state.etag = res.headers.etag;
        state.lastModified = lastModified;
        state.checkedAt = Date.now();
        state.failedUntil = undefined;
        ctx.telemetry.note({ snapshot_loaded: parsed.byUri.size });
        return parsed;
      }
    }
  } catch { /* no answer: handled below like a bad one */ }
  // A failure keeps the copy we have and asks again after a minute; without a copy, the live service answers meanwhile.
  state.checkedAt = Date.now();
  if (!state.snapshot) state.failedUntil = Date.now() + RETRY_AFTER_FAILURE_MS;
  return state.snapshot ?? null;
}

/**
 * The snapshot at `url`, loaded or revalidated as needed; null when there is none to use. Never throws. The URL is
 * checked against this deployment's guards on every call, so a snapshot loaded for one service is never used by a
 * service that may not reach its host.
 */
export async function loadSnapshot(ctx: EngineContext, url: string): Promise<Snapshot | null> {
  try {
    ctx.http.validateUrl(url);
  } catch {
    return null;
  }
  let state = states.get(url);
  if (!state) {
    state = { checkedAt: 0 };
    remember(url, state);
  }
  const now = Date.now();
  if (state.snapshot && now - state.checkedAt < REVALIDATE_MS) return state.snapshot;
  if (!state.snapshot && (state.failedUntil ?? 0) > now) return null;
  const s = state;
  if (!s.pending || now - (s.pendingSince ?? 0) >= LOAD_WAIT_MS) {
    const p: Promise<Snapshot | null> = refresh(ctx, url, s).finally(() => { if (s.pending === p) s.pending = undefined; });
    s.pending = p;
    s.pendingSince = now;
  }
  // Each caller waits on its own timer, never longer than LOAD_WAIT_MS, then goes on with what there is.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Snapshot | null>((resolve) => { timer = setTimeout(() => resolve(s.snapshot ?? null), LOAD_WAIT_MS); });
  try {
    return await Promise.race([s.pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The snapshot at `url` if one is loaded, without loading, revalidating or waiting: for what may be added to an answer
 * the live service gives anyway. Checked against this deployment's guards like loadSnapshot.
 */
function loadedSnapshot(ctx: EngineContext, url: string): Snapshot | null {
  try {
    ctx.http.validateUrl(url);
  } catch {
    return null;
  }
  return states.get(url)?.snapshot ?? null;
}

// ---------------------------------------------------------------------------------------
// Answering from a snapshot. `undefined` means "the snapshot cannot answer this"; the live adapter answers instead.

/** The label in the instance's language, else in the first language the concept has. */
function prefLabel(c: SnapConcept, instance: VocabularyInstance): { value: string; lang?: string } {
  const lang = instance.defaultLang && c.labels[instance.defaultLang] !== undefined ? instance.defaultLang : Object.keys(c.labels)[0];
  return { value: c.labels[lang], ...(lang ? { lang } : {}) };
}

function idOf(uri: string, instance: VocabularyInstance): string {
  const base = instance.conceptUriBase;
  return base && uri.startsWith(base) && uri.length > base.length ? uri.slice(base.length) : localId(uri);
}

function refOf(c: SnapConcept, instance: VocabularyInstance): ConceptRef {
  const label = prefLabel(c, instance);
  return { id: idOf(c.uri, instance), uri: c.uri, prefLabel: label.value, ...(label.lang ? { lang: label.lang } : {}) };
}

/**
 * Label order: the root collation at base strength (letters with diacritics sort with their base letter, "Dataägare"
 * before "Dataproducent"), as TemaTres's database orders them. Not the vocabulary's language: Swedish would put "ä"
 * after "z", unlike the live service, and the result would depend on the locale data of the runtime.
 */
const COLLATOR = new Intl.Collator("und", { sensitivity: "base", numeric: true });

function byLabel(_instance: VocabularyInstance) {
  const collator = COLLATOR;
  return (a: ConceptRef, b: ConceptRef) => collator.compare(a.prefLabel, b.prefLabel) || a.uri.localeCompare(b.uri);
}

/** All of `uris` as references in label order, or undefined if the snapshot lacks any of them. */
function refs(s: Snapshot, uris: string[], instance: VocabularyInstance): ConceptRef[] | undefined {
  const out: ConceptRef[] = [];
  for (const uri of uris) {
    const c = s.byUri.get(uri);
    if (!c) return undefined;
    out.push(refOf(c, instance));
  }
  return out.sort(byLabel(instance));
}

function find(s: Snapshot, id: string, instance: VocabularyInstance): SnapConcept | undefined {
  if (instance.conceptUriBase) {
    const hit = s.byUri.get(`${instance.conceptUriBase}${id}`);
    if (hit) return hit;
  }
  for (const c of s.byUri.values()) if (idOf(c.uri, instance) === id) return c;
  return undefined;
}

/** From the top down to `c`, along the first broader concept at each step; undefined if the chain leaves the snapshot. */
function pathTo(s: Snapshot, c: SnapConcept, instance: VocabularyInstance): ConceptRef[] | undefined {
  const chain: ConceptRef[] = [];
  const seen = new Set<string>();
  let cur: SnapConcept | undefined = c;
  while (cur && !seen.has(cur.uri) && chain.length < 100) {
    seen.add(cur.uri);
    chain.unshift(refOf(cur, instance));
    const up: string | undefined = [...cur.broader].sort()[0];
    if (!up) return chain;
    cur = s.byUri.get(up);
    if (!cur) return undefined;
  }
  return chain;
}

type Rank = 0 | 1 | 2 | 3;
/** 0 exact, 1 prefix, 2 a word starts with it, 3 contains it; null if not at all. */
function rank(label: string, q: string): Rank | null {
  const l = label.toLowerCase();
  if (l === q) return 0;
  if (l.startsWith(q)) return 1;
  let at = l.indexOf(q);
  if (at < 0) return null;
  for (; at >= 0; at = l.indexOf(q, at + 1)) if (/[\s\-–/(]/.test(l[at - 1] ?? "")) return 2;
  return 3;
}

/** Concepts whose labels match `text`, best first; `prefixOnly` for suggestions (exact, prefix or word start only). */
function matches(s: Snapshot, instance: VocabularyInstance, text: string, prefixOnly: boolean): SearchHit[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const found: { hit: SearchHit; rank: Rank; alt: boolean }[] = [];
  for (const c of s.byUri.values()) {
    const ref = refOf(c, instance);
    const usable = (label: string): Rank | null => {
      const r = rank(label, q);
      return r === null || (prefixOnly && r === 3) ? null : r;
    };
    // A match on the preferred label wins over any other; otherwise the best other label, and other languages'
    // preferred labels and alternative labels say which label matched, while hidden labels match silently.
    const own = usable(ref.prefLabel);
    if (own !== null) {
      found.push({ hit: ref, rank: own, alt: false });
      continue;
    }
    let best: { rank: Rank; matched?: string } | undefined;
    const others: [string, string | undefined][] = [
      ...Object.entries(c.labels).filter(([lang]) => lang !== (ref.lang ?? "")).map(([, l]): [string, string] => [l, l]),
      ...c.altLabels.map((l): [string, string] => [l.value, l.value]),
      ...c.hiddenLabels.map((l): [string, undefined] => [l.value, undefined])
    ];
    for (const [label, matched] of others) {
      const r = usable(label);
      if (r !== null && (!best || r < best.rank)) best = { rank: r, ...(matched !== undefined ? { matched } : {}) };
    }
    if (best) found.push({ hit: { ...ref, ...(best.matched !== undefined ? { matchedLabel: best.matched } : {}) }, rank: best.rank, alt: true });
  }
  const order = byLabel(instance);
  // Preferred-label matches first, then the rest; within each, exact, prefix, word start, inside a word.
  found.sort((a, b) => Number(a.alt) - Number(b.alt) || a.rank - b.rank || order(a.hit, b.hit));
  return found.map((f) => f.hit);
}

function concept(s: Snapshot, c: SnapConcept, instance: VocabularyInstance): Concept | undefined {
  const broader = refs(s, c.broader, instance);
  const narrower = refs(s, c.narrower, instance);
  const related = refs(s, c.related, instance);
  const path = pathTo(s, c, instance);
  if (!broader || !narrower || !related || !path) return undefined;
  return {
    ...refOf(c, instance),
    altLabels: c.altLabels,
    hiddenLabels: c.hiddenLabels,
    notes: c.notes,
    broader,
    narrower,
    related,
    mappings: c.mappings,
    path,
    ...(c.created ? { created: c.created } : {}),
    ...(c.modified ? { modified: c.modified } : {}),
    ext: { snapshot: { ...(s.lastModified ? { lastModified: s.lastModified } : {}) } }
  };
}

/**
 * `live` with answers from the snapshot at `url` where the snapshot can give them. Same contract as any adapter; the
 * snapshot changes where an answer comes from, not what a tool may return.
 */
export function withSnapshot(live: VocabularyAdapter, url: string): VocabularyAdapter {
  async function answer<T>(ctx: EngineContext, instance: VocabularyInstance, fromSnapshot: (s: Snapshot) => T | undefined, fromLive: () => Promise<T>): Promise<T> {
    // Just after a write (src/fresh.ts) the file may not have it yet: the live service answers.
    const s = mustReadFresh(instance.baseUrl) ? undefined : await loadSnapshot(ctx, url);
    const value = s ? fromSnapshot(s) : undefined;
    if (value !== undefined) {
      ctx.telemetry.note({ source: "snapshot" });
      return value;
    }
    ctx.telemetry.note({ source: "live" });
    return fromLive();
  }
  const nonEmpty = <T>(list: T[]) => (list.length ? list : undefined);

  return {
    id: live.id,
    async schemeInfo(ctx, instance) {
      const info = await live.schemeInfo(ctx, instance);
      // The live service may count alternative terms too; a loaded snapshot knows its concepts. Never loaded for this.
      const s = mustReadFresh(instance.baseUrl) ? undefined : loadedSnapshot(ctx, url);
      if (!s?.complete) return info;
      return {
        ...info,
        conceptCount: s.byUri.size,
        ext: { ...info.ext, snapshot: { ...(s.lastModified ? { lastModified: s.lastModified } : {}) } }
      };
    },
    search: (ctx, instance, query) =>
      answer(ctx, instance, (s) => nonEmpty(matches(s, instance, query, false)), () => live.search(ctx, instance, query)),
    suggest: (ctx, instance, prefix) =>
      answer(ctx, instance, (s) => nonEmpty(matches(s, instance, prefix, true).slice(0, MAX_SUGGESTIONS)), () => live.suggest(ctx, instance, prefix)),
    getConcept: (ctx, instance, id) =>
      answer(ctx, instance, (s) => {
        const c = find(s, id, instance);
        return c ? concept(s, c, instance) : undefined;
      }, () => live.getConcept(ctx, instance, id)),
    broader: (ctx, instance, id) =>
      answer(ctx, instance, (s) => {
        const c = find(s, id, instance);
        return c ? refs(s, c.broader, instance) : undefined;
      }, () => live.broader(ctx, instance, id)),
    narrower: (ctx, instance, id) =>
      answer(ctx, instance, (s) => {
        const c = find(s, id, instance);
        return c ? refs(s, c.narrower, instance) : undefined;
      }, () => live.narrower(ctx, instance, id)),
    related: (ctx, instance, id) =>
      answer(ctx, instance, (s) => {
        const c = find(s, id, instance);
        return c ? refs(s, c.related, instance) : undefined;
      }, () => live.related(ctx, instance, id)),
    // Picked among the snapshot's concepts with equal chance, without a request; a concept the snapshot cannot answer
    // whole (a relation outside it) is read from the live service, and if that service no longer has it, the service
    // picks. Without a snapshot the live service picks.
    async randomConcept(ctx, instance) {
      const s = mustReadFresh(instance.baseUrl) ? undefined : await loadSnapshot(ctx, url);
      if (s) {
        s.list ??= [...s.byUri.values()];
        const c = s.list[Math.floor(Math.random() * s.list.length)];
        const value = concept(s, c, instance);
        ctx.telemetry.note({ source: value ? "snapshot" : "live" });
        if (value) return value;
        // Read live by its id; if the live service no longer has it (a concept removed since the file was written),
        // let the live service pick, so the answer is never "no concept" for a vocabulary that has some.
        const byId = await live.getConcept(ctx, instance, idOf(c.uri, instance));
        if (byId || !live.randomConcept) return byId;
        return live.randomConcept(ctx, instance);
      }
      ctx.telemetry.note({ source: "live" });
      if (!live.randomConcept) throw new RandomConceptNotOfferedError(instance.id);
      return live.randomConcept(ctx, instance);
    },
    topConcepts: (ctx, instance) =>
      answer(ctx, instance, (s) => {
        // Without topConceptOf the snapshot cannot tell a top concept from a concept outside the hierarchy (TemaTres
        // lists neither concepts without broader and narrower ones), so the live service answers.
        if (!s.hasTopConceptOf) return undefined;
        return nonEmpty([...s.byUri.values()].filter((c) => c.top).map((c) => refOf(c, instance)).sort(byLabel(instance)));
      }, () => live.topConcepts(ctx, instance)),
    // Changes go to the live service; the snapshot only reads.
    ...(live.proposeChanges ? { proposeChanges: live.proposeChanges.bind(live) } : {}),
    ...(live.applyChanges ? { applyChanges: live.applyChanges.bind(live) } : {}),
    ...(live.batchStatus ? { batchStatus: live.batchStatus.bind(live) } : {})
  };
}
