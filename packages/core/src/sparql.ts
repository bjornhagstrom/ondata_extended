/**
 * Shared SPARQL helpers: read-only SELECT validation, LIMIT injection, safe string literals,
 * flattening of result bindings, and a SELECT call through the engine's HTTP client.
 *
 * Derived from ondata's italianparliament-mcp (MIT, Copyright (c) 2026 Andrea Borruso):
 * src/tools/sparql.ts (stripComments, stripLiteralsAndIris, validateSelectQuery, injectLimit),
 * src/core/sparql-literal.ts and src/core/flatten.ts at commit fd46810. Chosen over the variant
 * in ondata/ckan-mcp-server (src/tools/sparql.ts:31-38), which accepts
 * `INSERT DATA {...} ; SELECT ...` because it only checks that SELECT occurs somewhere.
 * Messages translated to English; behaviour unchanged.
 */

import type { EngineHttp, FetchOptions, Row } from "@ondata-extended/profile-contract";

export interface SparqlBindingValue {
  type: "uri" | "literal" | "typed-literal" | "bnode";
  value: string;
  "xml:lang"?: string;
  datatype?: string;
}

export interface SparqlResults {
  head: { vars: string[] };
  results: { bindings: Record<string, SparqlBindingValue>[] };
}

/**
 * Removes comments (from `#` to end of line) but not a `#` inside an IRI: the standard
 * rdfs/rdf/owl/xsd prefixes end in `#`, and on a one-line query a naive replace would cut
 * everything after them, SELECT included.
 */
function stripComments(query: string): string {
  let result = "";
  let inIri = false;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === "<") inIri = true;
    else if (ch === ">") inIri = false;
    if (ch === "#" && !inIri) {
      const nl = query.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    result += ch;
  }
  return result;
}

/** Literals and IRIs blanked out, so `FILTER(CONTAINS(?t, "delete"))` is not taken for a write. */
function stripLiteralsAndIris(query: string): string {
  return query
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ")
    .replace(/<[^>]*>/g, " ");
}

const WRITE_KEYWORDS = /\b(INSERT|DELETE|LOAD|CLEAR|DROP|CREATE|COPY|MOVE)\b/i;

export class SparqlValidationError extends Error {
  /**
   * The update keyword found (upper case), when that was the reason; absent when the query does
   * not start with SELECT. Lets a profile word the refusal in its own language.
   */
  constructor(message: string, readonly keyword?: string) {
    super(message);
    this.name = "SparqlValidationError";
  }
}

/**
 * A query must *start* with SELECT (after an optional prologue) and contain no update keyword.
 * A tool that declares itself read-only must guarantee it here, not hope the endpoint refuses.
 */
export function validateSelectQuery(query: string): void {
  const skeleton = stripLiteralsAndIris(stripComments(query));
  if (!/^\s*(?:(?:BASE\s+|PREFIX\s+\S*\s*)\s*)*SELECT\b/i.test(skeleton)) {
    throw new SparqlValidationError("Only SELECT queries are supported (not CONSTRUCT, ASK, DESCRIBE or updates).");
  }
  const write = skeleton.match(WRITE_KEYWORDS);
  if (write) {
    const keyword = write[1].toUpperCase();
    throw new SparqlValidationError(`Only SELECT queries are supported: found the update keyword ${keyword}.`, keyword);
  }
}

/** Appends `LIMIT n` unless the query has one. Returns whether it was injected. */
export function injectLimit(query: string, limit: number): { query: string; injected: boolean } {
  if (/\bLIMIT\b/i.test(query)) return { query, injected: false };
  return { query: `${query.trimEnd()}\nLIMIT ${limit}`, injected: true };
}

const SPARQL_ESC: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r" };

/**
 * A value as a SPARQL string literal, quotes included. Escapes only what STRING_LITERAL2
 * forbids; not JSON.stringify, whose \uXXXX escapes some SPARQL parsers reject.
 */
export const sparqlStringLiteral = (value: string): string =>
  `"${value.replace(/[\\"\n\r]/g, (c) => SPARQL_ESC[c] ?? c)}"`;

/** One row per binding, one string per variable (empty when unbound). */
export function flattenBindings(results: SparqlResults): Row[] {
  const bindings = results?.results?.bindings ?? [];
  const vars = results?.head?.vars ?? [];
  return bindings.map((b) => {
    const row: Row = {};
    for (const v of vars) row[v] = b[v]?.value ?? "";
    return row;
  });
}

/** A SELECT over GET with JSON results, through the engine's client (guards, caps, host policy). */
export async function sparqlSelect(http: EngineHttp, endpoint: string, query: string, opts: FetchOptions = {}): Promise<SparqlResults> {
  const url = new URL(endpoint);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "application/json");
  return http.json<SparqlResults>(url.toString(), {
    method: "GET",
    headers: { Accept: "application/sparql-results+json, application/json" }
  }, opts);
}
