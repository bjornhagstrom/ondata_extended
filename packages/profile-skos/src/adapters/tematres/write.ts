/**
 * Changes to a TemaTres vocabulary through its write endpoint (`write.php` beside `services.php`): a dry run that returns
 * the diff and, when nothing stands in the way, a batch id; and an apply that takes only that id.
 *
 * The format is the one agreed for the write API (POST JSON, `Authorization: Bearer`, `{ action: "dryRun", vocabulary,
 * reason, source, operations }`, `{ action: "apply", batchId }` and `{ action: "status", batchId }`, answers `{ ok, ... }` or `{ ok: false, error: { code,
 * message } }`). TemaTres has no write API upstream; this speaks the one built for the project's own instances.
 *
 * The key is read from the core config at call time and must be 64 hex characters, the API's form (anything else is
 * treated as no key, so a malformed value can never reach a header or an error message). It is sent only in the
 * Authorization header of an HTTPS request that follows no redirect, and never written into an answer, an error or the
 * telemetry. An error answer is reduced to its code, shown with our own text; the service's message is never repeated.
 *
 * A dry run is read fail-closed: an answer that does not account for every operation, or that cannot be read whole, is
 * an error, never a proposal with fewer changes or conflicts than the batch has.
 */

import type { EngineContext } from "@ondata-extended/profile-contract";
import {
  ChangeRefusedError,
  ChangesNotOfferedError,
  type ChangeBatch,
  type ChangeConflict,
  type ChangeProposal,
  type ChangeResult,
  type BatchStatus,
  type NoteSelector,
  type ProposedChange,
  type VocabularyInstance
} from "../../model.js";
import { markWritten } from "../../fresh.js";

/** Our text for each code the service may answer with; an unknown code gets the generic one. */
const REFUSALS: Record<string, string> = {
  unauthorized: "The vocabulary service did not accept this server's write key.",
  forbidden: "This server's write key does not allow this change in this vocabulary.",
  unknownConcept: "A concept the batch names does not exist in the vocabulary.",
  staleText: "Something the batch builds on has changed since it was read.",
  labelExists: "A new concept or label in the batch already exists in the vocabulary.",
  selectorNotFound: "A place in a note that the batch names was not found.",
  selectorAmbiguous: "A place in a note that the batch names matches more than one place.",
  noteNotStructured: "A note the batch changes does not follow the heading-and-paragraph form, so no place in it can be named.",
  noteExists: "The concept already has a note of that type and language.",
  relationExists: "A relation the batch adds already exists.",
  invalidOperation: "The vocabulary service did not accept an operation of the batch.",
  unknownBatch: "No proposed batch has this id.",
  batchUsed: "The proposed batch has already been applied or used up.",
  batchExpired: "The proposed batch has expired.",
  busy: "Another batch is being written to this vocabulary.",
  invalidJson: "The vocabulary service could not read the request.",
  methodNotAllowed: "The vocabulary service could not read the request.",
  limitExceeded: "The batch is larger than the vocabulary service accepts.",
  vocabularyMismatch: "The write endpoint does not belong to the vocabulary this server names.",
  rateLimited: "The vocabulary service has had too many write requests from this server.",
  transactionsUnavailable: "This vocabulary cannot be written safely (its tables do not support transactions); nothing was written.",
  dumpFailed: "The vocabulary service could not take its backup, so it wrote nothing.",
  notInstalled: "Writing is not set up in this vocabulary; nothing was written.",
  serverError: "The vocabulary service had an unexpected error; this request changed nothing.",
  statusUnknown: "The vocabulary service did not say what became of the batch.",
  unavailable: "The vocabulary service did not answer the dry run; nothing was written."
};
const GENERIC_REFUSAL = "The vocabulary service refused the change.";
const UNKNOWN_OUTCOME = "The vocabulary service did not say whether the batch was written.";
const STATUS_UNKNOWN = "The vocabulary service did not say what became of the batch.";

/** Our text for the service's warnings on a proposed change; an unknown one is shown by its code. */
const WARNINGS: Record<string, string> = {
  linkRemoved: "a link in the replaced text is removed"
};

/** Our text for a code from the service. */
export function refusalText(code: string): string {
  return Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : GENERIC_REFUSAL;
}

/** Our text for a warning code from the service. */
export function warningText(code: string): string {
  return Object.hasOwn(WARNINGS, code) ? WARNINGS[code] : `the service flagged it (${code})`;
}

/** Codes with which the service says, at apply, that it wrote nothing: refusals before the transaction. */
const NOTHING_WRITTEN = new Set([
  "unauthorized", "forbidden", "unknownConcept", "staleText", "labelExists", "selectorNotFound", "selectorAmbiguous",
  "noteNotStructured", "noteExists", "relationExists", "invalidOperation", "unknownBatch", "batchUsed", "batchExpired",
  "busy", "invalidJson", "methodNotAllowed", "limitExceeded", "vocabularyMismatch", "rateLimited",
  "transactionsUnavailable", "dumpFailed", "notInstalled"
]);
/** Of those, the ones the service answers with 503: before any write, it says. */
const NOTHING_WRITTEN_5XX = new Set(["transactionsUnavailable", "dumpFailed", "notInstalled"]);
/**
 * A 500 with which the service says this request changed nothing (it rolled back). Not `outcomeUnknown`, its 500 after
 * a commit began. The batch may be `failed` or still `proposed` afterwards; vocab_change_status tells which.
 */
const NOTHING_WRITTEN_500 = "serverError";

const MAX_TEXT = 100_000;
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const BATCH_ID = /^[A-Za-z0-9_-]{8,128}$/;
/** The write API's key: 32 random bytes as hex. */
const KEY = /^[0-9A-Fa-f]{64}$/;
const ID = /^\d{1,10}$/;
const REF = /^[A-Za-z0-9_-]{1,64}$/;
/** An ISO 8601 date and time, as the service gives `appliedAt` and `expiresAt`. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

class UnreadableAnswer extends Error {}

function writeAccess(ctx: EngineContext, instance: VocabularyInstance): { url: string; key: string } {
  const write = instance.write;
  const key = write ? ctx.config.get(write.keySetting)?.trim() : undefined;
  if (!write || !key || !KEY.test(key)) throw new ChangesNotOfferedError(instance.id);
  let https = false;
  try {
    https = new URL(write.url).protocol === "https:";
  } catch {
    https = false;
  }
  if (!https) throw new ChangesNotOfferedError(instance.id);
  return { url: write.url, key };
}

type Answer = { status: number; obj: Record<string, unknown> | undefined; retryAfter?: number };

async function post(ctx: EngineContext, instance: VocabularyInstance, body: unknown): Promise<Answer> {
  const { url, key } = writeAccess(ctx, instance);
  const res = await ctx.http.request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  }, { userAgent: "honest", retry: { attempts: 1 }, maxHops: 0 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text ?? "");
  } catch {
    parsed = undefined;
  }
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  const wait = Number(Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === "retry-after")?.[1]);
  return { status: res.status, obj, ...(Number.isInteger(wait) && wait > 0 && wait <= 86_400 ? { retryAfter: wait } : {}) };
}

/** The service's code for a refusal, if it gave a well-formed one. */
function codeOf(a: Answer): string | undefined {
  const error = a.obj?.error;
  const code = error && typeof error === "object" ? (error as Record<string, unknown>).code : undefined;
  if (typeof code === "string" && CODE.test(code)) return code;
  if (a.status === 401) return "unauthorized";
  if (a.status === 403) return "forbidden";
  if (a.status === 429) return "rateLimited";
  return undefined;
}

/** The refusal for a code, with the place of a conflict and the wait the service asks for when it gave them. */
function refusal(a: Answer, code: string): ChangeRefusedError {
  let text = refusalText(code);
  const error = a.obj?.error as Record<string, unknown> | undefined;
  const at = error?.index ?? a.obj?.index;
  if (Number.isInteger(at) && (at as number) >= 0 && (at as number) < 1000) text = text.replace(/\.$/, ` (change ${(at as number) + 1}).`);
  if (code === "rateLimited" && a.retryAfter) text += ` It asks to wait ${a.retryAfter} seconds.`;
  return new ChangeRefusedError(code, text);
}

const str = (v: unknown, what: string, max = MAX_TEXT): string => {
  if (typeof v !== "string" || v.length > max) throw new UnreadableAnswer(what);
  return v;
};
const optStr = (v: unknown, what: string, max = MAX_TEXT): string | undefined => (v === undefined || v === null ? undefined : str(v, what, max));
const optId = (v: unknown, what: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === "number" && Number.isInteger(v) ? String(v) : typeof v === "string" ? v : "";
  if (!ID.test(s)) throw new UnreadableAnswer(what);
  return s;
};
const index = (v: unknown, count: number): number => {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= count) throw new UnreadableAnswer("index");
  return v as number;
};

function selectorOf(v: unknown): NoteSelector | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object") throw new UnreadableAnswer("selector");
  const s = v as Record<string, unknown>;
  const heading = str(s.heading, "selector", 500);
  if (Number.isInteger(s.paragraph)) return { heading, paragraph: s.paragraph as number };
  if (typeof s.listItemContaining === "string") return { heading, listItemContaining: str(s.listItemContaining, "selector", 500) };
  return { heading, paragraphContaining: str(s.paragraphContaining, "selector", 500) };
}

function changeOf(v: unknown, count: number): ProposedChange {
  if (!v || typeof v !== "object") throw new UnreadableAnswer("change");
  const o = v as Record<string, unknown>;
  const out: ProposedChange = { index: index(o.index, count), op: str(o.op, "op", 64) as ProposedChange["op"] };
  const conceptId = optId(o.conceptId, "conceptId");
  if (conceptId) out.conceptId = conceptId;
  if (o.conceptRef !== undefined && o.conceptRef !== null) {
    if (typeof o.conceptRef !== "string" || !REF.test(o.conceptRef)) throw new UnreadableAnswer("conceptRef");
    out.conceptRef = o.conceptRef;
  }
  for (const key of ["conceptUri", "prefLabel", "noteType", "before", "after", "changeNote"] as const) {
    const s = optStr(o[key], key);
    if (s !== undefined) out[key] = s;
  }
  const selector = selectorOf(o.selector);
  if (selector) out.selector = selector;
  if (o.warnings !== undefined && o.warnings !== null) {
    if (!Array.isArray(o.warnings) || o.warnings.length > 20) throw new UnreadableAnswer("warnings");
    const warnings = o.warnings.map((w) => str(w, "warning", 64));
    if (!warnings.every((w) => CODE.test(w))) throw new UnreadableAnswer("warning");
    if (warnings.length) out.warnings = warnings;
  }
  return out;
}

function conflictOf(v: unknown, count: number): ChangeConflict {
  if (!v || typeof v !== "object") throw new UnreadableAnswer("conflict");
  const o = v as Record<string, unknown>;
  const code = str(o.code, "code", 64);
  if (!CODE.test(code)) throw new UnreadableAnswer("code");
  // The service's message is not kept: a conflict is shown with our text for its code.
  return { index: index(o.index, count), code };
}

export async function proposeChanges(ctx: EngineContext, instance: VocabularyInstance, batch: ChangeBatch): Promise<ChangeProposal> {
  const a = await post(ctx, instance, { action: "dryRun", vocabulary: instance.baseUrl, ...batch });
  // A refusal is a non-2xx answer or `ok: false`; any other 2xx is read as a proposal, fail-closed.
  if (a.status < 200 || a.status >= 300 || a.obj?.ok === false) {
    const code = codeOf(a) ?? (a.status >= 500 ? "unavailable" : `http${a.status}`);
    throw refusal(a, code);
  }
  const count = batch.operations.length;
  try {
    const o = a.obj;
    if (!o || o.ok !== true) throw new UnreadableAnswer("ok");
    if (typeof o.applicable !== "boolean") throw new UnreadableAnswer("applicable");
    if (!Array.isArray(o.operations) || !Array.isArray(o.conflicts)) throw new UnreadableAnswer("lists");
    const changes = o.operations.map((c) => changeOf(c, count));
    const conflicts = o.conflicts.map((c) => conflictOf(c, count));
    // Every operation accounted for, in order: by a change or by a conflict.
    const covered = new Set([...changes.map((c) => c.index), ...conflicts.map((c) => c.index)]);
    if (covered.size !== count || changes.some((c, i) => i > 0 && c.index <= changes[i - 1].index)) throw new UnreadableAnswer("coverage");
    // Applicable exactly when there is no conflict, and only then with an id.
    if (o.applicable !== (conflicts.length === 0)) throw new UnreadableAnswer("applicable");
    if (!o.applicable) {
      if (o.batchId !== undefined && o.batchId !== null) throw new UnreadableAnswer("batchId");
      return { applicable: false, changes, conflicts };
    }
    const batchId = str(o.batchId, "batchId", 128);
    if (!BATCH_ID.test(batchId)) throw new UnreadableAnswer("batchId");
    const expiresAt = optStr(o.expiresAt, "expiresAt", 64);
    if (expiresAt !== undefined && !TIME.test(expiresAt)) throw new UnreadableAnswer("expiresAt");
    return { applicable: true, batchId, ...(expiresAt ? { expiresAt } : {}), changes, conflicts };
  } catch (error) {
    if (error instanceof UnreadableAnswer) {
      throw new ChangeRefusedError("unreadableProposal", "The vocabulary service's dry run could not be read whole; nothing can be applied from it.");
    }
    throw error;
  }
}

function createdOf(v: unknown): ChangeResult["created"] {
  if (!Array.isArray(v)) return [];
  const out: ChangeResult["created"] = [];
  for (const c of v.slice(0, 100)) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const ref = typeof o.conceptRef === "string" && REF.test(o.conceptRef) ? o.conceptRef : undefined;
    const id = typeof o.conceptId === "number" || typeof o.conceptId === "string" ? String(o.conceptId) : "";
    if (!ref || !ID.test(id)) continue;
    const uri = typeof o.conceptUri === "string" && o.conceptUri.length <= 500 && /^https?:\/\//.test(o.conceptUri) ? o.conceptUri : undefined;
    out.push({ conceptRef: ref, conceptId: id, ...(uri ? { conceptUri: uri } : {}) });
  }
  return out;
}

export async function applyChanges(ctx: EngineContext, instance: VocabularyInstance, batchId: string): Promise<ChangeResult> {
  writeAccess(ctx, instance); // no key or no HTTPS: nothing is sent, nothing to read fresh
  let a: Answer;
  try {
    a = await post(ctx, instance, { action: "apply", batchId });
  } catch (error) {
    // Sent, but no answer (a timeout, a lost connection, a guard after the fact): it may have been written.
    if ((error as { name?: string } | null)?.name === "SsrfGuardError") throw error;
    markWritten(instance.baseUrl);
    throw new ChangeRefusedError("unknownOutcome", UNKNOWN_OUTCOME);
  }
  // A 2xx answer with `applied: true` and without `ok: false` confirms the write, whatever else it says or lacks.
  const ok = a.status >= 200 && a.status < 300 && a.obj !== undefined && a.obj.ok !== false;
  const code = ok ? undefined : codeOf(a);
  // A refusal before the transaction: the service says nothing was written. Of the 5xx answers only a 503 with a code
  // the service gives before writing counts, and a 500 `serverError` (rolled back, the plan 2.6); any other (an
  // unknown outcome, a 5xx from elsewhere) may follow a write.
  // `batchUsed` says nothing was written now, but the batch may have been written before: read fresh after it too.
  if (code && ((NOTHING_WRITTEN.has(code) && ((a.status >= 400 && a.status < 500) || (a.status === 503 && NOTHING_WRITTEN_5XX.has(code))))
    || (a.status === 500 && code === NOTHING_WRITTEN_500))) {
    if (code === "batchUsed") markWritten(instance.baseUrl);
    throw refusal(a, code);
  }
  // From here on the batch may have been written: read this vocabulary fresh for a while, whatever follows.
  markWritten(instance.baseUrl);
  if (!ok || a.obj!.applied !== true) {
    throw new ChangeRefusedError(ok && a.obj!.applied === false ? "notApplied" : "unknownOutcome", ok && a.obj!.applied === false
      ? "The vocabulary service did not confirm that the batch was written."
      : UNKNOWN_OUTCOME);
  }
  // Written: the rest is reported as far as it can be read, never turned into a refusal.
  return resultOf(a.obj!, batchId);
}

/** A written batch's result, as far as it can be read. */
function resultOf(o: Record<string, unknown>, batchId: string): ChangeResult {
  const ids = Array.isArray(o.changedConceptIds) ? o.changedConceptIds : [];
  const dump = typeof o.dump === "string" && /^[A-Za-z0-9._-]{1,300}$/.test(o.dump) ? o.dump : undefined;
  const appliedAt = typeof o.appliedAt === "string" && TIME.test(o.appliedAt) ? o.appliedAt : undefined;
  const logId = (typeof o.logId === "string" || typeof o.logId === "number") && /^[A-Za-z0-9_-]{1,64}$/.test(String(o.logId)) ? String(o.logId) : undefined;
  return {
    batchId,
    applied: true,
    ...(appliedAt ? { appliedAt } : {}),
    ...(dump ? { dump } : {}),
    // Once each, whether the service lists a concept per operation or once: the answer counts concepts.
    changedConceptIds: [...new Set(ids.map((id) => String(id)).filter((id) => ID.test(id)))],
    created: createdOf(o.created),
    ...(logId ? { logId } : {})
  };
}

/** The refusals a status call passes on: the key, or the batch id. */
const STATUS_REFUSALS = new Set(["unauthorized", "forbidden", "unknownBatch"]);
const STATUSES = new Set<BatchStatus["status"]>(["proposed", "expired", "stale", "failed", "applied"]);

/**
 * What became of a batch, from the service's record (`status`): writes nothing. Read fail-closed: an answer without a
 * known status, or for another batch, is an error, never a guess. Of the result only `applied` carries one.
 */
export async function batchStatus(ctx: EngineContext, instance: VocabularyInstance, batchId: string): Promise<BatchStatus> {
  writeAccess(ctx, instance); // no key or no HTTPS: nothing is sent
  let a: Answer;
  try {
    a = await post(ctx, instance, { action: "status", batchId });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "SsrfGuardError") throw error;
    throw new ChangeRefusedError("statusUnknown", STATUS_UNKNOWN);
  }
  if (a.status < 200 || a.status >= 300 || a.obj?.ok === false) {
    const code = codeOf(a);
    // Only a refusal about the key or the batch id is passed on; anything else (a server error, a limit, a busy
    // service, a code meant for apply) says nothing about the batch (the plan, 2.5b): ask again.
    if (code && STATUS_REFUSALS.has(code) && a.status >= 400 && a.status < 500) throw new ChangeRefusedError(`status:${code}`, refusalText(code));
    throw new ChangeRefusedError("statusUnknown", STATUS_UNKNOWN + (a.retryAfter ? ` It asks to wait ${a.retryAfter} seconds.` : ""));
  }
  const o = a.obj;
  const status = o?.status;
  if (!o || o.ok !== true || o.batchId !== batchId || typeof status !== "string" || !STATUSES.has(status as BatchStatus["status"])) {
    throw new ChangeRefusedError("statusUnknown", STATUS_UNKNOWN);
  }
  const expiresAt = typeof o.expiresAt === "string" && TIME.test(o.expiresAt) ? o.expiresAt : undefined;
  // Written: read this vocabulary fresh for a while, as after an apply (the answer says so).
  if (status === "applied") markWritten(instance.baseUrl);
  return {
    batchId,
    status: status as BatchStatus["status"],
    ...(expiresAt ? { expiresAt } : {}),
    ...(status === "applied" ? { result: resultOf(o, batchId) } : {})
  };
}
