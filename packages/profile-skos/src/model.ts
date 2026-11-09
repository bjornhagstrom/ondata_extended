/**
 * The SKOS profile's model and the adapter contract.
 *
 * Tools speak SKOS (prefLabel, altLabel, broader, narrower, related, notes, mappings). An
 * adapter turns one backend (TemaTres first; Skosmos or plain SPARQL later) into this model.
 * What a backend has beyond SKOS passes through untouched under `ext.<adapter>`, so nothing
 * is lost, only sorted.
 */

import type { EngineContext } from "@ondata-extended/profile-contract";

export interface Label {
  value: string;
  lang?: string;
}

/** A note in SKOS terms; `type` is the SKOS note property, `sourceType` the backend's own code. */
export interface Note {
  type: "definition" | "scopeNote" | "historyNote" | "editorialNote" | "changeNote" | "example" | "note";
  value: string;
  lang?: string;
  sourceType?: string;
}

export interface ConceptRef {
  /** The backend's local id. */
  id: string;
  uri: string;
  prefLabel: string;
  lang?: string;
  /** Backend particulars of this reference (e.g. a relation sub-type), under the adapter's id. */
  ext?: Record<string, unknown>;
}

export interface Mapping {
  type: "exactMatch" | "closeMatch" | "broadMatch" | "narrowMatch" | "relatedMatch" | "unknown";
  uri?: string;
  label?: string;
  /** Target vocabulary name, when the backend says. */
  scheme?: string;
}

export interface Concept extends ConceptRef {
  altLabels: Label[];
  hiddenLabels: Label[];
  notes: Note[];
  broader: ConceptRef[];
  narrower: ConceptRef[];
  related: ConceptRef[];
  mappings: Mapping[];
  /** From the top of the hierarchy down to (and including) this concept. */
  path: ConceptRef[];
  created?: string;
  modified?: string;
  ext: Record<string, unknown>;
}

export interface SearchHit extends ConceptRef {
  /** The non-preferred label that matched, when the match was not on prefLabel. */
  matchedLabel?: string;
  ext?: Record<string, unknown>;
}

export interface SchemeInfo {
  uri: string;
  title: string;
  languages: string[];
  conceptCount?: number;
  created?: string;
  modified?: string;
  creator?: string;
  publisher?: string;
  rights?: string;
  description?: string;
  /** Backend name and version, e.g. "TemaTres 3.6.1". */
  software?: string;
  ext: Record<string, unknown>;
}

/** The instance a call goes to, with what the adapter needs to reach it. */
export interface VocabularyInstance {
  id: string;
  /** Base URL of the backend installation (for TemaTres: where services.php lives). */
  baseUrl: string;
  adapter: string;
  defaultLang?: string;
  /** The text before the id in this instance's concept URIs, when known. */
  conceptUriBase?: string;
}

/** One backend. Every method returns SKOS-model data; a missing concept is `null`, not an error. */
export interface VocabularyAdapter {
  readonly id: string;
  schemeInfo(ctx: EngineContext, instance: VocabularyInstance): Promise<SchemeInfo>;
  search(ctx: EngineContext, instance: VocabularyInstance, query: string): Promise<SearchHit[]>;
  suggest(ctx: EngineContext, instance: VocabularyInstance, prefix: string): Promise<SearchHit[]>;
  getConcept(ctx: EngineContext, instance: VocabularyInstance, id: string): Promise<Concept | null>;
  broader(ctx: EngineContext, instance: VocabularyInstance, id: string): Promise<ConceptRef[] | null>;
  narrower(ctx: EngineContext, instance: VocabularyInstance, id: string): Promise<ConceptRef[] | null>;
  related(ctx: EngineContext, instance: VocabularyInstance, id: string): Promise<ConceptRef[] | null>;
  topConcepts(ctx: EngineContext, instance: VocabularyInstance): Promise<ConceptRef[]>;
}
