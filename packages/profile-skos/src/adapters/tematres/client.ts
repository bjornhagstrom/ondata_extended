/**
 * TemaTres web services (services.php) over the engine's HTTP client.
 *
 * Shapes and quirks are recorded in docs/tematres-api-derisking.md. In short:
 * - `GET {base}/services.php?task=…&arg=…&output=json`
 * - success: `{ result: { <id>: {...} }, resume: { cant_result, version, ... } }`
 * - no hits / unknown id: HTTP 200, no `result`, `cant_result: 0`
 * - invalid task: HTTP 200 **XML** even with output=json
 * - types vary between tasks (term_id number or string; isMetaTerm 0/"0"/null)
 */

import type { EngineContext } from "@ondata-extended/profile-contract";
import { HttpStatusError, TransportError } from "@ondata-extended/core";

/** The tasks this adapter uses. Others are refused before a request is made. */
export const TEMATRES_TASKS = [
  "fetchVocabularyData", "fetchTopTerms", "search", "suggestDetails", "fetch", "fetchSimilar",
  "fetchTerm", "fetchUp", "fetchDown", "fetchRelated", "fetchAlt", "fetchNotes",
  "fetchTargetTerms", "fetchSourceTerms", "fetchURI", "fetchDirectTerms", "fetchCentralTerms"
] as const;
export type TemaTresTask = (typeof TEMATRES_TASKS)[number];

export interface TemaTresResume {
  status?: string;
  web_service_version?: string;
  version?: string;
  cant_result: number;
}

export interface TemaTresAnswer {
  /** Rows of `result` in document order (the API keys them by id). Empty when there are none. */
  rows: Record<string, unknown>[];
  /** `result` itself when it is a flat object (fetchVocabularyData, fetchSimilar). */
  record: Record<string, unknown> | null;
  resume: TemaTresResume;
}

/** The service answered, but not with a TemaTres JSON envelope. */
export class TemaTresProtocolError extends Error {
  constructor(message: string, readonly task: string) {
    super(message);
    this.name = "TemaTresProtocolError";
  }
}

/** Cache TTLs in seconds: vocabularies change slowly; metadata about them even slower. */
export const TTL = { term: 300, scheme: 3600 } as const;

export function servicesUrl(baseUrl: string, task: TemaTresTask, arg?: string): string {
  const u = new URL("services.php", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  u.searchParams.set("task", task);
  if (arg !== undefined) u.searchParams.set("arg", arg);
  u.searchParams.set("output", "json");
  return u.toString();
}

/** Interpret a services.php body. Pure; exported for tests. */
export function parseEnvelope(task: string, contentType: string | undefined, text: string): TemaTresAnswer {
  const ct = (contentType ?? "").toLowerCase();
  const trimmed = text.trimStart();
  if (ct.includes("xml") || trimmed.startsWith("<")) {
    throw new TemaTresProtocolError(
      `The vocabulary service did not answer task "${task}" as JSON (it sent XML or HTML, which TemaTres does for an unknown task).`,
      task
    );
  }
  let body: unknown;
  try {
    // `result` is keyed by term id, and JavaScript orders integer-like keys ascending, which
    // would replace the service's order (e.g. alphabetical in fetchDown) with id order.
    // Prefixing the keys keeps document order. Only object-valued keys are touched; an
    // unescaped quote cannot occur inside a JSON string, so string values are never matched
    // (a key ending in an escaped quote and digits could be, harmlessly renamed).
    body = JSON.parse(text.replace(/"(\d+)":\{/g, '"#$1":{'));
  } catch {
    throw new TemaTresProtocolError(`The vocabulary service answered task "${task}" with invalid JSON.`, task);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TemaTresProtocolError(`The vocabulary service answered task "${task}" with an unexpected shape.`, task);
  }
  const { result, resume } = body as { result?: unknown; resume?: unknown };
  if (!resume || typeof resume !== "object") {
    throw new TemaTresProtocolError(`The vocabulary service answered task "${task}" without a "resume" block.`, task);
  }
  const r = resume as Record<string, unknown>;
  const parsedResume: TemaTresResume = {
    status: typeof r.status === "string" ? r.status : undefined,
    web_service_version: typeof r.web_service_version === "string" ? r.web_service_version : undefined,
    version: typeof r.version === "string" ? r.version : undefined,
    cant_result: Number(r.cant_result) || 0
  };

  if (result === undefined || result === null) return { rows: [], record: null, resume: parsedResume };
  if (typeof result !== "object") {
    throw new TemaTresProtocolError(`The vocabulary service answered task "${task}" with an unexpected result.`, task);
  }
  // A list of rows keyed by id, or a flat record. Rows are objects; a record has scalar values.
  const values = Array.isArray(result) ? result : Object.values(result as Record<string, unknown>);
  const isRows = values.length > 0 && values.every((v) => v !== null && typeof v === "object" && !Array.isArray(v));
  if (isRows) return { rows: values as Record<string, unknown>[], record: null, resume: parsedResume };
  return { rows: [], record: result as Record<string, unknown>, resume: parsedResume };
}

export async function callTask(
  ctx: EngineContext,
  baseUrl: string,
  task: TemaTresTask,
  arg?: string,
  ttlSeconds: number = TTL.term
): Promise<TemaTresAnswer> {
  if (!(TEMATRES_TASKS as readonly string[]).includes(task)) {
    throw new TemaTresProtocolError(`Task "${task}" is not used by this adapter.`, task);
  }
  const url = servicesUrl(baseUrl, task, arg);
  const res = await ctx.http.request(url, { method: "GET" }, { cache: { ttlSeconds }, userAgent: "browser" });
  if (res.status < 200 || res.status >= 300) {
    // An edge answering for an origin it could not reach: no answer from the service (as the core's json()).
    if ((res.status >= 520 && res.status <= 527) || res.status === 530) {
      throw new TransportError(`Network error: the vocabulary service could not be reached (HTTP ${res.status})`, url, true, "edge");
    }
    throw new HttpStatusError(res.status, res.statusText, url, null);
  }
  return parseEnvelope(task, res.headers["content-type"], res.text ?? "");
}

// ---------------------------------------------------------------------------------------
// Normalizers for the inconsistent field types

export const asId = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
export const asBool = (v: unknown): boolean => v === 1 || v === "1" || v === true;
export const asText = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Sort rows by their `order` field when every row has one; otherwise keep document order. */
export function inOrder(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!rows.every((r) => Number.isFinite(Number(r.order)))) return rows;
  return [...rows].sort((a, b) => Number(a.order) - Number(b.order));
}
