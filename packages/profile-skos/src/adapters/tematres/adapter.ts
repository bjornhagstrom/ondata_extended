/**
 * The TemaTres adapter: TemaTres web services → the SKOS model.
 *
 * One concept = seven parallel, cached calls (fetchTermFull is an empty stub upstream):
 * fetchTerm, fetchDirectTerms (BT, RT, UF in one answer), fetchDown, fetchNotes, fetchUp,
 * fetchTargetTerms, fetchURI. Concept URIs follow the instance's own SKOS export, whose
 * pattern is configurable in TemaTres (`_URI_BASE_ID` + `_URI_SEPARATOR_ID` + id, upstream
 * fun.xml.php:312-323): a known instance declares it, otherwise it is read once from
 * `xml.php?skosMeta=1`, and the upstream default is the last resort.
 * TemaTres particulars (code, meta-term flag, relation sub-types, note types, target
 * vocabularies) pass through under `ext.tematres`.
 */

import type { EngineContext } from "@ondata-extended/profile-contract";
import type { Concept, ConceptRef, Label, Mapping, Note, SchemeInfo, SearchHit, VocabularyAdapter, VocabularyInstance } from "../../model.js";
import { htmlToText } from "../../text.js";
import { TTL, asBool, asId, asText, callTask, inOrder } from "./client.js";

const NOTE_TYPES: Record<string, Note["type"]> = {
  DF: "definition",
  NA: "scopeNote",
  NH: "historyNote",
  NB: "note",
  NC: "note"
};
/** Never shown: TemaTres private notes are editorial, even if an instance exposes them. */
const PRIVATE_NOTE_TYPES = new Set(["NP"]);

const MAPPING_TYPES = new Set(["exactMatch", "closeMatch", "broadMatch", "narrowMatch", "relatedMatch"]);

function isNumericId(id: string): boolean {
  return /^\d+$/.test(id);
}

const withSlash = (u: string) => (u.endsWith("/") ? u : `${u}/`);

/** The text before the id in this instance's concept URIs. */
export async function conceptUriBase(ctx: EngineContext, instance: VocabularyInstance): Promise<string> {
  if (instance.conceptUriBase) return instance.conceptUriBase;
  const base = withSlash(instance.baseUrl);
  try {
    const res = await ctx.http.request(`${base}xml.php?skosMeta=1`, { method: "GET" }, { cache: { ttlSeconds: TTL.scheme } });
    const m = res.status === 200 && res.text ? res.text.match(/hasTopConcept\s+rdf:resource="([^"]*?)(\d+)"/) : null;
    if (m) return m[1].replace(/&amp;/g, "&");
  } catch { /* fall through to the default */ }
  return `${base}xml.php?schema=skos&term_id=`;
}

function ref(row: Record<string, unknown>, base: string, idKey = "term_id"): ConceptRef {
  const id = asId(row[idKey]);
  const lang = asText(row.lang);
  return { id, uri: `${base}${id}`, prefLabel: String(row.string ?? ""), ...(lang ? { lang } : {}) };
}

/** Target-vocabulary tag → SKOS mapping property, as TemaTres' own export does (fun.xml.php:1584). */
function targetMappingType(tag: unknown): Mapping["type"] {
  const t = String(tag ?? "").toLowerCase();
  if (t === "partial") return "unknown"; // TemaTres would write skos:partialMatch, which SKOS does not define
  const known: Record<string, Mapping["type"]> = { exact: "exactMatch", close: "closeMatch", related: "relatedMatch", broad: "broadMatch", narrow: "narrowMatch" };
  return known[t] ?? "exactMatch";
}

/**
 * `metaFlag: false` for fetchDirectTerms rows: there `isMetaTerm` is the *queried* term's
 * flag, not the related term's (upstream fun.api.php:149 reads `tema.isMetaTerm`; the related
 * term's `BT_isMetaTerm` is selected in fun.sql.php:735 but not returned). See
 * docs/tematres-api-derisking.md.
 */
function relationExt(row: Record<string, unknown>, metaFlag: boolean): Record<string, unknown> | undefined {
  const ext: Record<string, unknown> = {};
  if (asText(row.relation_code)) ext.relationCode = row.relation_code;
  if (asText(row.relation_label)) ext.relationLabel = row.relation_label;
  if (metaFlag && asBool(row.isMetaTerm)) ext.isMetaTerm = true;
  return Object.keys(ext).length ? ext : undefined;
}

function refWithExt(row: Record<string, unknown>, base: string, metaFlag = true): ConceptRef {
  const ext = relationExt(row, metaFlag);
  return ext ? { ...ref(row, base), ext: { tematres: ext } } : ref(row, base);
}

function mappingType(raw: unknown): Mapping["type"] {
  const t = String(raw ?? "").replace(/^skos:/i, "");
  const match = [...MAPPING_TYPES].find((m) => m.toLowerCase() === t.toLowerCase());
  return (match as Mapping["type"]) ?? "unknown";
}

function hits(rows: Record<string, unknown>[], base: string): SearchHit[] {
  return inOrder(rows).map((row) => {
    const matched = asText(row.no_term_string);
    const ext: Record<string, unknown> = {};
    if (asBool(row.isMetaTerm)) ext.isMetaTerm = true;
    if (asText(row.index)) ext.index = row.index;
    return {
      ...ref(row, base),
      ...(matched ? { matchedLabel: matched } : {}),
      ...(Object.keys(ext).length ? { ext: { tematres: ext } } : {})
    };
  });
}

export const temaTresAdapter: VocabularyAdapter = {
  id: "tematres",

  async schemeInfo(ctx, instance): Promise<SchemeInfo> {
    const a = await callTask(ctx, instance.baseUrl, "fetchVocabularyData", undefined, TTL.scheme);
    const r = a.record ?? {};
    const base = asText(r.uri) ?? instance.baseUrl;
    // adminEmail is left out on purpose: a contact address is not ours to repeat.
    const ext: Record<string, unknown> = {};
    for (const key of ["vocabulary_id", "status", "status_date", "keywords", "contributor"]) {
      if (asText(r[key])) ext[key] = r[key];
    }
    return {
      uri: base,
      title: String(r.title ?? ""),
      languages: asText(r.lang) ? [String(r.lang)] : [],
      ...(Number.isFinite(Number(r.cant_terms)) ? { conceptCount: Number(r.cant_terms) } : {}),
      ...(asText(r.createDate) ? { created: String(r.createDate) } : {}),
      ...(asText(r.lastMod) ? { modified: String(r.lastMod) } : {}),
      ...(asText(r.author) ? { creator: String(r.author) } : {}),
      ...(asText(r.publisher) ? { publisher: String(r.publisher) } : {}),
      ...(asText(r.rights) ? { rights: String(r.rights) } : {}),
      ...(asText(r.scope) ? { description: String(r.scope) } : {}),
      ...(a.resume.version ? { software: a.resume.version } : {}),
      ext: { tematres: ext }
    };
  },

  async search(ctx, instance, query) {
    const [base, a] = await Promise.all([conceptUriBase(ctx, instance), callTask(ctx, instance.baseUrl, "search", query)]);
    return hits(a.rows, base);
  },

  async suggest(ctx, instance, prefix) {
    const [base, a] = await Promise.all([conceptUriBase(ctx, instance), callTask(ctx, instance.baseUrl, "suggestDetails", prefix)]);
    return hits(a.rows, base);
  },

  async getConcept(ctx, instance, id) {
    if (!isNumericId(id)) return null;
    const call = (task: Parameters<typeof callTask>[2]) => callTask(ctx, instance.baseUrl, task, id);
    // All in parallel; settled first, so an unknown id is "not found" even if the other
    // calls fail, and only then does a failure of a part count.
    const settled = await Promise.allSettled([
      conceptUriBase(ctx, instance),
      call("fetchTerm"), call("fetchDirectTerms"), call("fetchDown"), call("fetchNotes"),
      call("fetchUp"), call("fetchTargetTerms"), call("fetchURI")
    ]);
    const termResult = settled[1];
    if (termResult.status === "rejected") throw termResult.reason;
    const row = termResult.value.rows[0];
    if (!row) return null;
    const failed = settled.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
    type Answer = Awaited<ReturnType<typeof callTask>>;
    const values = settled.map((r) => (r as PromiseFulfilledResult<unknown>).value);
    const base = values[0] as string;
    const [direct, down, notes, up, target, uris] = values.slice(2) as Answer[];

    const self = ref(row, base);
    const altLabels: Label[] = [];
    const broader: ConceptRef[] = [];
    const related: ConceptRef[] = [];
    const otherRelations: Record<string, unknown>[] = [];
    for (const r of direct.rows) {
      const type = String(r.relation_type ?? "");
      if (type === "UF") {
        const lang = asText(r.lang);
        altLabels.push({ value: String(r.string ?? ""), ...(lang ? { lang } : {}) });
      } else if (type === "BT") broader.push(refWithExt(r, base, false));
      else if (type === "RT") related.push(refWithExt(r, base, false));
      // Other relation types (TemaTres' SQL also returns e.g. EQ) are kept, not dropped.
      else otherRelations.push({ id: asId(r.term_id), label: String(r.string ?? ""), relationTypeId: asId(r.relation_type_id), ...(asText(r.relation_label) ? { relationLabel: r.relation_label } : {}) });
    }

    const conceptNotes: Note[] = [];
    for (const n of notes.rows) {
      const sourceType = String(n.note_type ?? "");
      if (PRIVATE_NOTE_TYPES.has(sourceType)) continue;
      const lang = asText(n.note_lang);
      conceptNotes.push({
        type: NOTE_TYPES[sourceType] ?? "note",
        value: htmlToText(String(n.note_text ?? "")),
        ...(lang ? { lang } : {}),
        sourceType
      });
    }

    const mappings: Mapping[] = [
      ...target.rows.map((t): Mapping => ({
        // Terms linked in another vocabulary; the property comes from the target vocabulary's tag.
        type: targetMappingType(t.target_vocabulary_tag),
        ...(asText(t.uri) ? { uri: String(t.uri) } : asText(t.url) ? { uri: String(t.url) } : {}),
        ...(asText(t.string) ? { label: String(t.string) } : {}),
        ...(asText(t.target_vocabulary_title) ? { scheme: String(t.target_vocabulary_title) } : {})
      })),
      ...uris.rows.map((u): Mapping => ({ type: mappingType(u.link_type), ...(asText(u.link) ? { uri: String(u.link) } : {}) }))
    ];

    const path = inOrder(up.rows).map((r) => ref(r, base));
    const ext: Record<string, unknown> = {};
    if (asText(row.code)) ext.code = row.code;
    if (asBool(row.isMetaTerm)) ext.isMetaTerm = true;
    if (target.rows.length) ext.targetVocabularies = [...new Set(target.rows.map((t) => t.target_vocabulary_title).filter(Boolean))];
    const unknownUriTypes = uris.rows.map((u) => u.link_type).filter((t) => mappingType(t) === "unknown");
    if (unknownUriTypes.length) ext.uriLinkTypes = unknownUriTypes;
    if (otherRelations.length) ext.otherRelations = otherRelations;
    const partial = target.rows.filter((t) => String(t.target_vocabulary_tag ?? "").toLowerCase() === "partial");
    if (partial.length) ext.partialMatches = partial.map((t) => t.uri ?? t.url);

    return {
      ...self,
      altLabels,
      hiddenLabels: [],
      notes: conceptNotes,
      broader,
      narrower: inOrder(down.rows).map((r) => refWithExt(r, base)),
      related,
      mappings,
      path: path.length ? path : [self],
      ...(asText(row.date_create) ? { created: String(row.date_create) } : {}),
      ...(asText(row.date_mod) ? { modified: String(row.date_mod) } : {}),
      ext: { tematres: ext }
    } satisfies Concept;
  },

  async broader(ctx, instance, id) {
    if (!isNumericId(id)) return null;
    const [base, term, direct] = await Promise.all([
      conceptUriBase(ctx, instance), callTask(ctx, instance.baseUrl, "fetchTerm", id), callTask(ctx, instance.baseUrl, "fetchDirectTerms", id)
    ]);
    if (!term.rows[0]) return null;
    return direct.rows.filter((r) => r.relation_type === "BT").map((r) => refWithExt(r, base, false));
  },

  async narrower(ctx, instance, id) {
    if (!isNumericId(id)) return null;
    const [base, term, down] = await Promise.all([
      conceptUriBase(ctx, instance), callTask(ctx, instance.baseUrl, "fetchTerm", id), callTask(ctx, instance.baseUrl, "fetchDown", id)
    ]);
    if (!term.rows[0]) return null;
    return inOrder(down.rows).map((r) => refWithExt(r, base));
  },

  async related(ctx, instance, id) {
    if (!isNumericId(id)) return null;
    const [base, term, direct] = await Promise.all([
      conceptUriBase(ctx, instance), callTask(ctx, instance.baseUrl, "fetchTerm", id), callTask(ctx, instance.baseUrl, "fetchDirectTerms", id)
    ]);
    if (!term.rows[0]) return null;
    return direct.rows.filter((r) => r.relation_type === "RT").map((r) => refWithExt(r, base, false));
  },

  async topConcepts(ctx, instance) {
    const [base, a] = await Promise.all([conceptUriBase(ctx, instance), callTask(ctx, instance.baseUrl, "fetchTopTerms")]);
    return inOrder(a.rows).map((r) => refWithExt(r, base));
  }
};
