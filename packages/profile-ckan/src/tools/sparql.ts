/**
 * Generic SPARQL query tool for any public HTTPS SPARQL endpoint
 *
 * Ported from ondata/ckan-mcp-server src/tools/sparql.ts at 09e8cdc (MIT, see NOTICE.md), with ondata's
 * fix 3369eac (#593, 2026-11-12) ported ahead of the baseline: a `#` inside an IRI or string is not a
 * comment, a failed query carries the endpoint's own reason, a timeout says so (docs/test-parity.md, D14).
 */

import { z } from "zod";
import type { EngineContext } from "@ondata-extended/profile-contract";
import { formatError } from "@ondata-extended/core";
import { ResponseFormatSchema, ResponseFormat, defineTool } from "../types.js";
import { getSparqlConfig } from "../utils/portal-config.js";
import { fetchAsResponse } from "../utils/fetch.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 1000;
const TIMEOUT_MS = 15000;
const ERROR_HEAD_BYTES = 4 * 1024;
const MAX_REASON_LENGTH = 300;

interface SparqlBinding {
  type: string;
  value: string;
  datatype?: string;
  "xml:lang"?: string;
}

interface SparqlResults {
  head: { vars: string[] };
  results: { bindings: Record<string, SparqlBinding>[] };
}

/**
 * Validates that the query is a SELECT statement.
 * Throws if it contains write operations or no SELECT keyword.
 */
export function validateSelectQuery(query: string): void {
  // A `#` starts a comment only outside IRIs and string literals: namespace IRIs such as
  // rdf-schema# end in one, and a PREFIX on the same line as SELECT must not hide it.
  const stripped = query.replace(
    /<[^<>"{}|^`\\\s]*>|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|#[^\n]*/g,
    match => (match.startsWith("#") ? "" : match)
  );
  if (!/\bSELECT\b/i.test(stripped)) {
    throw new Error(
      "Only SELECT queries are supported (not CONSTRUCT, ASK, DESCRIBE, or write operations)."
    );
  }
}

/**
 * Appends LIMIT to query if not already present (case-insensitive check).
 */
export function injectLimit(query: string, limit: number): string {
  if (/\bLIMIT\b/i.test(query)) return query;
  return `${query.trimEnd()}\nLIMIT ${limit}`;
}

export async function querySparqlEndpoint(ctx: EngineContext, endpointUrl: string, query: string): Promise<SparqlResults> {
  // ondata: validateServerUrl, then https only, then the DNS check (the core's request makes
  // that check on the first hop, D5)
  ctx.http.validateUrl(endpointUrl, { allowPrivateHosts: true });
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS endpoints are allowed");
  }

  const sparqlConfig = getSparqlConfig(endpointUrl);
  const method = sparqlConfig?.method ?? "POST";

  const commonHeaders = {
    "Accept": "application/sparql-results+json"
  };
  // ondata ran one 15 s timer across the POST and its GET fallback; here each request has 15 s (D11)
  const opts = { timeoutMs: TIMEOUT_MS, userAgent: { fixed: "Mozilla/5.0 (compatible; CKAN-MCP-Server/1.0)" }, httpsOnly: true, timeoutStyle: "controller" as const, checksDnsFirst: true, errorBodyPrefixBytes: ERROR_HEAD_BYTES };

  try {
    let response: Response;
    if (method === "GET") {
      const getUrl = new URL(endpointUrl);
      getUrl.searchParams.set("query", query);
      response = await fetchAsResponse(ctx, getUrl.toString(), {
        method: "GET",
        headers: commonHeaders
      }, opts);
    } else {
      response = await fetchAsResponse(ctx, endpointUrl, {
        method: "POST",
        headers: { ...commonHeaders, "Content-Type": "application/sparql-query; charset=utf-8" },
        body: query
      }, opts);
      // Fallback to GET if POST is rejected
      if (response.status === 403 || response.status === 405) {
        const getUrl = new URL(endpointUrl);
        getUrl.searchParams.set("query", query);
        response = await fetchAsResponse(ctx, getUrl.toString(), {
          method: "GET",
          headers: commonHeaders
        }, opts);
      }
    }

    if (!response.ok) {
      const reason = await readErrorReason(response);
      throw new Error(
        `SPARQL endpoint error (${response.status}): ${response.statusText}${reason ? `: ${reason}` : ""}`
      );
    }

    return (await response.json()) as SparqlResults;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `The endpoint did not answer within ${TIMEOUT_MS / 1000} seconds (timeout). Simplify the query (fewer VALUES, a LIMIT, no OPTIONAL over large sets) or retry later.`,
        { cause: error }
      );
    }
    throw error;
  }
}

/**
 * The endpoint's own explanation of a failed query, as one short line (ondata 3369eac). Wikidata
 * answers a parse error with an echo of the (possibly multiline) query and a Java stack trace;
 * Virtuoso puts the message first. HTML pages (gateways, proxies) carry nothing useful and are left
 * out. The core reads only the first 4 KB of an error body (`errorBodyPrefixBytes`), as ondata's
 * readHead does: the rest is never downloaded, and a body that stalls gives what had arrived by the
 * deadline, so no timer is needed here (D14).
 */
async function readErrorReason(response: Response): Promise<string> {
  try {
    if (/html/i.test(response.headers.get("content-type") ?? "")) return "";
    // Already cut to ERROR_HEAD_BYTES by the core; cutting the re-encoded text again could split a character.
    const text = await response.text();
    if (!text || /^\s*</.test(text)) return "";
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    // Wikidata echoes the query first, one line per query line, then the exception.
    const line = lines[0]?.startsWith("SPARQL-QUERY:")
      ? lines.find(l => /^[\w$.]+(?:Exception|Error): /.test(l))
      : lines[0];
    if (!line) return "";
    const reason = line
      .replace(/^(?:[\w$.]+(?:Exception|Error): )+/, "")
      .replace(/[\u0000-\u001f\u007f]/g, "");
    return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH)}…` : reason;
  } catch {
    return "";
  }
}

export function formatSparqlMarkdown(data: SparqlResults, endpointUrl: string): string {
  const vars = data.head.vars;
  const bindings = data.results.bindings;

  let md = `# SPARQL Query Results\n\n`;
  md += `**Endpoint**: ${endpointUrl}\n`;
  md += `**Rows**: ${bindings.length}\n\n`;

  if (bindings.length === 0) {
    return md + "_No results_\n";
  }

  // Table header
  md += `| ${vars.join(" | ")} |\n`;
  md += `| ${vars.map(() => "---").join(" | ")} |\n`;

  // Table rows
  for (const row of bindings) {
    const cells = vars.map(v => {
      const val = row[v]?.value ?? "";
      return val.replace(/\|/g, "\\|");
    });
    md += `| ${cells.join(" | ")} |\n`;
  }

  return md;
}

export function formatSparqlJson(data: SparqlResults): { count: number; columns: string[]; rows: Record<string, string>[] } {
  const vars = data.head.vars;
  const rows = data.results.bindings.map(row => {
    const obj: Record<string, string> = {};
    for (const v of vars) {
      obj[v] = row[v]?.value ?? "";
    }
    return obj;
  });
  return { count: rows.length, columns: vars, rows };
}

export const sparqlQuery = defineTool({
  name: "sparql_query",
  // ondata's name, without the profile prefix
  shared: true,
  title: "SPARQL Query",
  description: `Execute a SPARQL SELECT query against any public HTTPS SPARQL endpoint.

Useful for querying open data portals and knowledge graphs that expose SPARQL endpoints, including:
- data.europa.eu (European open data portal)
- publications.europa.eu (EU Publications Office)
- DBpedia, Wikidata
- Any DCAT-AP compliant data catalog

Only HTTPS endpoints are allowed. Queries timeout after 15 seconds.
Only SELECT queries are supported (read-only).

If the query does not contain a LIMIT clause, one is injected automatically (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT}).

Args:
  - endpoint_url (string): HTTPS URL of the SPARQL endpoint
  - query (string): SPARQL SELECT query to execute
  - limit (number): Max rows to return (default: ${DEFAULT_LIMIT}). Ignored if query already contains LIMIT.
  - response_format ('markdown' | 'json'): Output format

Examples:
  - Count Italian HVD datasets by publisher on data.europa.eu
  - Query Wikidata for entities related to a dataset topic
  - Explore EU controlled vocabularies on publications.europa.eu

Typical workflow: sparql_query (explore schema) → sparql_query (targeted query) → ckan_package_search (get dataset details)`,
  inputSchema: {
    endpoint_url: z.string().url().describe("HTTPS URL of the SPARQL endpoint"),
    query: z.string().min(1).describe("SPARQL SELECT query to execute"),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)
      .describe(`Max rows to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT}). Injected as SPARQL LIMIT if not already present in query.`),
    response_format: ResponseFormatSchema
  },
  strictInput: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  },
  async handler(params, ctx) {
    try {
      validateSelectQuery(params.query);
      const limitedQuery = injectLimit(params.query, params.limit);
      const data = await querySparqlEndpoint(ctx, params.endpoint_url, limitedQuery);

      if (params.response_format === ResponseFormat.JSON) {
        const result = formatSparqlJson(data);
        return ctx.output.json(result);
      }

      return {
        content: [{ type: "text", text: ctx.output.truncateText(formatSparqlMarkdown(data, params.endpoint_url)) }]
      };
    } catch (error) {
      const message = `SPARQL query failed:\n${error instanceof Error ? error.message : String(error)}`;
      return {
        content: [{
          type: "text",
          text: formatError(message, params.response_format === ResponseFormat.JSON)
        }],
        isError: true
      };
    }
  }
});

export const SPARQL_TOOLS = [sparqlQuery];
