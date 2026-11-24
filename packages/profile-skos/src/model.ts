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
  /**
   * The number of terms as the backend counts them: preferred and alternative (non-preferred) terms together, so not
   * the number of concepts (TemaTres's `cant_terms`).
   */
  termCount?: number;
  /** The number of concepts, only where it is known (e.g. counted in a loaded snapshot). */
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
  /**
   * The SKOS note property of the instance's own note types, by the backend's code (e.g. a TemaTres note type `CH` that
   * the instance exports as skos:changeNote). Used before the adapter's defaults; a private type stays hidden.
   */
  noteTypes?: Readonly<Record<string, Note["type"]>>;
  /**
   * Write access, when the deployment gives it: the backend's write endpoint and the name of the setting that holds the
   * key (read from the core config at call time, so the key itself never sits in an instance object).
   */
  write?: { url: string; keySetting: string };
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
  /**
   * One concept picked at random, never from a cache; null when the vocabulary has none. Optional: a backend that
   * cannot pick one leaves it out or throws RandomConceptNotOfferedError.
   */
  randomConcept?(ctx: EngineContext, instance: VocabularyInstance): Promise<Concept | null>;
  /** A dry run of a batch: what it would change and what stands in the way, written nowhere. Needs `instance.write`. */
  proposeChanges?(ctx: EngineContext, instance: VocabularyInstance, batch: ChangeBatch): Promise<ChangeProposal>;
  /** Writes exactly the proposed batch with this id, all or nothing. Needs `instance.write`. */
  applyChanges?(ctx: EngineContext, instance: VocabularyInstance, batchId: string): Promise<ChangeResult>;
  /** What became of a batch this server proposed, as the backend recorded it; writes nothing. Needs `instance.write`. */
  batchStatus?(ctx: EngineContext, instance: VocabularyInstance, batchId: string): Promise<BatchStatus>;
}

/** The vocabulary service cannot pick a random concept (the backend has no such call, or this version lacks it). */
export class RandomConceptNotOfferedError extends Error {
  constructor(vocab: string) {
    super(`The vocabulary service of "${vocab}" does not offer a random concept.`);
    this.name = "RandomConceptNotOfferedError";
  }
}

// ---------------------------------------------------------------------------------------
// Changes: a batch of operations, proposed (a dry run that writes nothing) and then applied by its id.

/**
 * The concept a change is about: its id in the vocabulary (`conceptId`) or the name (`conceptRef`) given to a concept
 * created earlier in the same batch; exactly one. A target (a broader or related concept) likewise, with `targetId` or
 * `targetRef`.
 */
export interface ConceptPointer { conceptId?: number; conceptRef?: string }
export interface TargetPointer { targetId?: number; targetRef?: string }

/** Where in a note: the element under a heading, by its number or by a text it contains; exactly one of the three. */
export interface NoteSelector { heading: string; paragraph?: number; listItemContaining?: string; paragraphContaining?: string }

/** For one change instead of the batch's: why, where from, and what the change note names as changed. */
export interface ChangeExtras { reason?: string; source?: string; field?: string }

export type ConceptStatus = "accepted" | "candidate" | "rejected";

/** A new note's text: sections with a heading, plain paragraphs and links. */
export interface NoteSectionInput { heading: string; paragraphs?: string[]; links?: { label: string; url: string }[] }

export type ChangeOperation = ChangeExtras & (
  | { op: "createConcept" | "createMetaTerm"; conceptRef: string; prefLabel: string; comment?: string }
  | ({ op: "addAltLabel"; label: string } & ConceptPointer)
  | ({ op: "addBroader" | "addRelated" } & ConceptPointer & TargetPointer)
  | ({ op: "moveConcept"; toTop?: true; expectedBroaderId: number | null } & ConceptPointer & TargetPointer)
  | ({ op: "setStatus"; status: ConceptStatus; expectedStatus: ConceptStatus } & ConceptPointer)
  | ({ op: "addNote"; noteType: string; lang?: string; sections?: NoteSectionInput[]; paragraphs?: string[] } & ConceptPointer)
  | ({ op: "replaceNoteSection"; noteType: string; lang?: string; expected: string; text: string } & NoteSelector & ConceptPointer)
  | ({ op: "replaceNoteText"; noteType: string; lang?: string; expected: string; find: string; replaceWith: string } & NoteSelector & ConceptPointer)
);

/** What the user's material gives for every change: why, and where it comes from. The server writes them into its change notes. */
export interface ChangeBatch {
  reason: string;
  source: string;
  operations: ChangeOperation[];
}

/** One operation as the dry run would carry it out. Texts are the backend's, as stored (e.g. HTML). */
export interface ProposedChange {
  index: number;
  op: ChangeOperation["op"];
  /** Absent for a concept the batch creates: it has an id only once written. */
  conceptId?: string;
  conceptRef?: string;
  conceptUri?: string;
  prefLabel?: string;
  noteType?: string;
  selector?: NoteSelector;
  before?: string;
  after?: string;
  /** The change note the server will write for this change. */
  changeNote?: string;
  /** The service's warning codes for this change (e.g. a link that the new text drops). */
  warnings?: string[];
}

/** Why an operation cannot be applied as proposed (e.g. the text it replaces has changed, a label exists). */
export interface ChangeConflict {
  index: number;
  code: string;
}

export interface ChangeProposal {
  /** Whether the batch can be written: no conflict. Only then is there a batch id. */
  applicable: boolean;
  /** The id `applyChanges` takes; single use, bound to the key that proposed it, valid until `expiresAt`. */
  batchId?: string;
  expiresAt?: string;
  changes: ProposedChange[];
  conflicts: ChangeConflict[];
}

export interface ChangeResult {
  batchId: string;
  applied: true;
  appliedAt?: string;
  /** The backup the backend took before writing, by name. */
  dump?: string;
  changedConceptIds: string[];
  /** The concepts the batch created, by the name the batch gave them. */
  created: { conceptRef: string; conceptId: string; conceptUri?: string }[];
  logId?: string;
}

/**
 * A batch as the backend recorded it. `proposed`: nothing written so far; `expired`, `stale` (a conflict at apply) and
 * `failed` (an error at apply): nothing written; `applied`: written, with `result` as the apply recorded it.
 */
export interface BatchStatus {
  batchId: string;
  status: "proposed" | "expired" | "stale" | "failed" | "applied";
  expiresAt?: string;
  result?: ChangeResult;
}

/** Changes are not offered for this vocabulary (no write access configured, or the backend has none). */
export class ChangesNotOfferedError extends Error {
  constructor(vocab: string) {
    super(`Changes to "${vocab}" are not offered by this server.`);
    this.name = "ChangesNotOfferedError";
  }
}

/** The vocabulary service refused a batch or an apply, with its code (our text, never the service's). */
export class ChangeRefusedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ChangeRefusedError";
    this.code = code;
  }
}
