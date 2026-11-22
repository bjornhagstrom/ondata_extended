/**
 * Changes to a TemaTres vocabulary through its write endpoint: a dry run that returns the diff and a batch id, and an
 * apply that takes only that id.
 *
 * PROVISIONAL: TemaTres has no write API upstream. This speaks the format ondata_extended proposed to the project that
 * builds one (JSON, `{ action: "dryRun", batch }` and `{ action: "apply", batchId }`, a Bearer key, error codes); the
 * agreed format replaces it here, and only here. Nothing in a deployment points at it until then.
 *
 * The key is read from the core config at call time and must be printable ASCII without spaces (anything else is
 * treated as no key, so a malformed value can never reach an error message). It is sent only in the Authorization
 * header of an HTTPS request that follows no redirect, and never written into an answer, an error or the telemetry.
 * An error answer is reduced to its code, shown with our own text; the service's message is never repeated.
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
  staleText: "A text the batch replaces has changed since it was read.",
  labelExists: "A new concept or label in the batch already exists in the vocabulary.",
  selectorNotFound: "A place in a note that the batch names was not found.",
  selectorAmbiguous: "A place in a note that the batch names matches more than one place.",
  batchExpired: "The proposed batch has expired.",
  batchUsed: "The proposed batch has already been applied.",
  batchUnknown: "No proposed batch has this id.",
  invalidOperation: "The vocabulary service did not accept an operation of the batch.",
  tooLarge: "The batch is larger than the vocabulary service accepts.",
  rateLimited: "The vocabulary service has had too many write requests; it asks to wait.",
  unavailable: "The vocabulary service did not answer the dry run; nothing was written."
};
const GENERIC_REFUSAL = "The vocabulary service refused the change.";
const UNKNOWN_OUTCOME = "The vocabulary service did not say whether the batch was written.";

/** Our text for a code from the service. */
export function refusalText(code: string): string {
  return Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : GENERIC_REFUSAL;
}

/** Codes with which the service says it wrote nothing. */
const NOTHING_WRITTEN = new Set(Object.keys(REFUSALS));

const MAX_TEXT = 100_000;
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const BATCH_ID = /^[A-Za-z0-9_-]{8,128}$/;
/** RFC 6750's token characters, in practice: printable ASCII without spaces. */
const KEY = /^[\x21-\x7e]{1,1024}$/;

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

type Answer = { status: number; obj: Record<string, unknown> | undefined };

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
  return { status: res.status, obj };
}

/** The service's code for a refusal, if it gave a well-formed one. */
function codeOf(a: Answer): string | undefined {
  if (typeof a.obj?.code === "string" && CODE.test(a.obj.code)) return a.obj.code;
  if (a.status === 401) return "unauthorized";
  if (a.status === 403) return "forbidden";
  if (a.status === 429) return "rateLimited";
  return undefined;
}

const str = (v: unknown, what: string, max = MAX_TEXT): string => {
  if (typeof v !== "string" || v.length > max) throw new UnreadableAnswer(what);
  return v;
};
const optStr = (v: unknown, what: string, max = MAX_TEXT): string | undefined => (v === undefined || v === null ? undefined : str(v, what, max));
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
  return { heading, listItemContaining: str(s.listItemContaining, "selector", 500) };
}

function changeOf(v: unknown, count: number): ProposedChange {
  if (!v || typeof v !== "object") throw new UnreadableAnswer("change");
  const o = v as Record<string, unknown>;
  const out: ProposedChange = { index: index(o.index, count), op: str(o.op, "op", 64) as ProposedChange["op"] };
  for (const key of ["conceptId", "conceptUri", "prefLabel", "noteType", "before", "after", "changeNote"] as const) {
    const s = optStr(o[key], key);
    if (s !== undefined) out[key] = s;
  }
  const selector = selectorOf(o.selector);
  if (selector) out.selector = selector;
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
  const a = await post(ctx, instance, { action: "dryRun", batch });
  if (a.status < 200 || a.status >= 300 || !a.obj) {
    const code = codeOf(a) ?? (a.status >= 500 ? "unavailable" : `http${a.status}`);
    throw new ChangeRefusedError(code, refusalText(code));
  }
  const count = batch.operations.length;
  try {
    const batchId = str(a.obj.batchId, "batchId", 128);
    if (!BATCH_ID.test(batchId)) throw new UnreadableAnswer("batchId");
    if (!Array.isArray(a.obj.changes) || !Array.isArray(a.obj.conflicts)) throw new UnreadableAnswer("lists");
    const changes = a.obj.changes.map((c) => changeOf(c, count));
    const conflicts = a.obj.conflicts.map((c) => conflictOf(c, count));
    // Every operation accounted for, once, in order: by a change or by a conflict.
    const covered = new Set([...changes.map((c) => c.index), ...conflicts.map((c) => c.index)]);
    if (covered.size !== count || changes.some((c, i) => i > 0 && c.index <= changes[i - 1].index)) throw new UnreadableAnswer("coverage");
    const expiresAt = optStr(a.obj.expiresAt, "expiresAt", 64);
    return { batchId, ...(expiresAt ? { expiresAt } : {}), changes, conflicts };
  } catch (error) {
    if (error instanceof UnreadableAnswer) {
      throw new ChangeRefusedError("unreadableProposal", "The vocabulary service's dry run could not be read whole; nothing can be applied from it.");
    }
    throw error;
  }
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
  const code = a.status >= 200 && a.status < 300 ? undefined : codeOf(a);
  if (code && NOTHING_WRITTEN.has(code) && a.status >= 400 && a.status < 500) {
    throw new ChangeRefusedError(code, refusalText(code));
  }
  // From here on the batch may have been written: read this vocabulary fresh for a while, whatever follows.
  markWritten(instance.baseUrl);
  if (a.status < 200 || a.status >= 300 || !a.obj || a.obj.applied !== true) {
    throw new ChangeRefusedError(a.obj?.applied === false ? "notApplied" : "unknownOutcome", a.obj?.applied === false
      ? "The vocabulary service did not confirm that the batch was written."
      : UNKNOWN_OUTCOME);
  }
  // Written: the rest is reported as far as it can be read, never turned into a refusal.
  const ids = Array.isArray(a.obj.changedConceptIds) ? a.obj.changedConceptIds : [];
  const dump = typeof a.obj.dump === "string" && a.obj.dump.length <= 300 ? a.obj.dump : undefined;
  const logId = typeof a.obj.logId === "string" || typeof a.obj.logId === "number" ? String(a.obj.logId).slice(0, 64) : undefined;
  return {
    batchId,
    applied: true,
    ...(dump ? { dump } : {}),
    changedConceptIds: ids.map((id) => String(id)).filter((id) => /^\d{1,12}$/.test(id)),
    ...(logId ? { logId } : {})
  };
}
