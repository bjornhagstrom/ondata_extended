/**
 * Changes to a TemaTres vocabulary through its write endpoint: a dry run that returns the diff and a batch id, and an
 * apply that takes only that id.
 *
 * PROVISIONAL: TemaTres has no write API upstream. This speaks the format ondata_extended proposed to the project that
 * builds one (JSON, `{ action: "dryRun", batch }` and `{ action: "apply", batchId }`, a Bearer key, error codes); the
 * agreed format replaces it here, and only here. Nothing in a deployment points at it until then.
 *
 * The key is read from the core config at call time, sent only in the Authorization header (the core drops it on a
 * redirect, but a write never follows one: the endpoint is exactly where the deployment says), and never written into an answer, an error or the telemetry. An error answer is reduced to
 * its code; the service's own message text is not repeated.
 */

import type { EngineContext } from "@ondata-extended/profile-contract";
import { TransportError } from "@ondata-extended/core";
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
  rateLimited: "The vocabulary service has had too many write requests; it asks to wait."
};
const GENERIC_REFUSAL = "The vocabulary service refused the change.";

const MAX_TEXT = 100_000;
const asStr = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);
const asIndex = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined);
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const BATCH_ID = /^[A-Za-z0-9_-]{8,128}$/;

function writeAccess(ctx: EngineContext, instance: VocabularyInstance): { url: string; key: string } {
  const write = instance.write;
  const key = write ? ctx.config.get(write.keySetting)?.trim() : undefined;
  if (!write || !key) throw new ChangesNotOfferedError(instance.id);
  return { url: write.url, key };
}

async function post(ctx: EngineContext, instance: VocabularyInstance, body: unknown): Promise<Record<string, unknown>> {
  const { url, key } = writeAccess(ctx, instance);
  const res = await ctx.http.request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  }, { userAgent: "honest", httpsOnly: true, retry: { attempts: 1 }, maxHops: 0 });
  if ((res.status >= 520 && res.status <= 527) || res.status === 530) {
    throw new TransportError(`Network error: the vocabulary service could not be reached (HTTP ${res.status})`, url, true, "edge");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text ?? "");
  } catch {
    parsed = undefined;
  }
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  if (res.status < 200 || res.status >= 300 || !obj) {
    const code = typeof obj?.code === "string" && CODE.test(obj.code) ? obj.code : res.status === 401 ? "unauthorized" : res.status === 403 ? "forbidden" : res.status === 429 ? "rateLimited" : `http${res.status}`;
    throw new ChangeRefusedError(code, Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : GENERIC_REFUSAL);
  }
  return obj;
}

function selectorOf(v: unknown): NoteSelector | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  const heading = asStr(s.heading, 500);
  if (heading === undefined) return undefined;
  if (Number.isInteger(s.paragraph)) return { heading, paragraph: s.paragraph as number };
  const item = asStr(s.listItemContaining, 500);
  return item === undefined ? undefined : { heading, listItemContaining: item };
}

function changeOf(v: unknown): ProposedChange | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const index = asIndex(o.index);
  const op = asStr(o.op, 64);
  if (index === undefined || !op) return undefined;
  const out: ProposedChange = { index, op: op as ProposedChange["op"] };
  for (const key of ["conceptId", "conceptUri", "prefLabel", "noteType", "before", "after", "changeNote"] as const) {
    const s = asStr(o[key]);
    if (s !== undefined) out[key] = s;
  }
  const selector = selectorOf(o.selector);
  if (selector) out.selector = selector;
  return out;
}

function conflictOf(v: unknown): ChangeConflict | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const index = asIndex(o.index);
  const code = typeof o.code === "string" && CODE.test(o.code) ? o.code : undefined;
  if (index === undefined || !code) return undefined;
  const message = asStr(o.message, 1000);
  return { index, code, ...(message ? { message } : {}) };
}

function batchIdOf(v: unknown): string {
  if (typeof v !== "string" || !BATCH_ID.test(v)) throw new ChangeRefusedError("badAnswer", "The vocabulary service gave no usable batch id.");
  return v;
}

export async function proposeChanges(ctx: EngineContext, instance: VocabularyInstance, batch: ChangeBatch): Promise<ChangeProposal> {
  const a = await post(ctx, instance, { action: "dryRun", batch });
  const changes = Array.isArray(a.changes) ? a.changes : Array.isArray(a.operations) ? a.operations : [];
  return {
    batchId: batchIdOf(a.batchId),
    ...(asStr(a.expiresAt, 64) ? { expiresAt: a.expiresAt as string } : {}),
    changes: changes.map(changeOf).filter((c): c is ProposedChange => c !== undefined),
    conflicts: (Array.isArray(a.conflicts) ? a.conflicts : []).map(conflictOf).filter((c): c is ChangeConflict => c !== undefined)
  };
}

export async function applyChanges(ctx: EngineContext, instance: VocabularyInstance, batchId: string): Promise<ChangeResult> {
  let a: Record<string, unknown>;
  try {
    a = await post(ctx, instance, { action: "apply", batchId });
  } finally {
    // Whatever the answer (a timeout may come after the write), read this vocabulary fresh for a while.
    markWritten(instance.baseUrl);
  }
  if (a.applied !== true) throw new ChangeRefusedError("notApplied", "The vocabulary service did not confirm that the batch was written.");
  const ids = Array.isArray(a.changedConceptIds) ? a.changedConceptIds : [];
  const dump = asStr(a.dump, 300);
  const logId = typeof a.logId === "string" || typeof a.logId === "number" ? String(a.logId).slice(0, 64) : undefined;
  return {
    batchId: batchIdOf(a.batchId ?? batchId),
    applied: true,
    ...(dump ? { dump } : {}),
    changedConceptIds: ids.map((id) => String(id)).filter((id) => /^\d{1,12}$/.test(id)),
    ...(logId ? { logId } : {})
  };
}
