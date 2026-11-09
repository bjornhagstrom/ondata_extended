/**
 * THROWAWAY CONTRACT SPIKE. Four tools of ondata's italianparliament-mcp (MIT, Copyright (c)
 * 2026 Andrea Borruso, https://github.com/ondata/italianparliament-mcp, commit fd46810) run as
 * a profile on this core, to find out what the profile contract lacks for a third kind of
 * backend: fixed SPARQL endpoints, per-host throttle and retry, row output, unprefixed tool
 * names that are already a user contract. Queries, names and model-facing texts follow the
 * original (Italian) so the comparison is fair; ranking, birthplace parsing and other details
 * of the original are left out. Findings: docs/spike-parliament.md.
 *
 * Origin per tool: src/tools/legislatures.ts, deputies.ts, search.ts, sparql.ts; endpoints and
 * policies: src/core/endpoints.ts, src/core/client.ts; empty-result text: src/server.ts.
 */

import { z } from "zod";
import type { EngineContext, Profile, Row, ToolSpec } from "@ondata-extended/profile-contract";
// Row-level tools (`rows`): the host formats them, so the same definitions could serve the
// original's CLI as its `Tool.execute` does (runRowsTool in the core).
import { SparqlValidationError, flattenBindings, injectLimit, sparqlSelect, sparqlStringLiteral, validateSelectQuery } from "@ondata-extended/core";

export const CAMERA_ENDPOINT = "https://dati.camera.it/sparql";
export const SENATO_ENDPOINT = "https://dati.senato.it/sparql";

// Original: src/server.ts DEFAULT_EMPTY.
const DEFAULT_EMPTY =
  "Nessun risultato dai dati. NON dedurre né inventare il valore: se serve, riformula (termine normativo o radice più corta per le ricerche testuali, filtro più largo) o verifica gli identificatori (URI/numero/ramo). Un vuoto è spesso un mismatch, non un dato assente.";

const OCD_PREFIXES = `
  PREFIX ocd: <http://dati.camera.it/ocd/>
  PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
  PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
  PREFIX foaf: <http://xmlns.com/foaf/0.1/>
  PREFIX dc: <http://purl.org/dc/elements/1.1/>
  PREFIX dcterms: <http://purl.org/dc/terms/>
  PREFIX bio: <http://purl.org/vocab/bio/0.1/>
`;
const OSR_PREFIXES = `
  PREFIX osr: <http://dati.senato.it/osr/>
  PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Original: src/core/truncation.ts truncationNotice, simplified (no per-schema ceiling). */
function truncationNotice(limit: number, offset: number, max: number): string {
  const next = offset + limit;
  return limit >= max
    ? `[Risultato troncato dal limite di ${limit} righe: --limit è già al massimo (${max}): pagina con offset ${next} o restringi i filtri.]`
    : `[Risultato troncato dal limite di ${limit} righe: rilancia con limit più alto (max ${max}), pagina con offset ${next} o restringi i filtri.]`;
}

const camera = (ctx: EngineContext, query: string) => sparqlSelect(ctx.http, CAMERA_ENDPOINT, query);
const senato = (ctx: EngineContext, query: string) => sparqlSelect(ctx.http, SENATO_ENDPOINT, query);

const legislatures: ToolSpec<Record<string, never>> = {
  name: "legislatures",
  title: "Legislature (Camera)",
  description:
    "[CAMERA] Elenco di tutte le legislature della Camera dei Deputati, dal Regno d'Italia (1848) alla Repubblica (XIX legislatura in corso). Include date inizio/fine.",
  examples: ["italianparliament legislatures list"],
  inputSchema: {},
  annotations: { title: "Legislature (Camera)", ...READ_ONLY },
  async rows(_args, ctx) {
    const results = await camera(ctx, `${OCD_PREFIXES}
SELECT DISTINCT ?s ?label ?title ?date
WHERE {
  ?s a <http://dati.camera.it/ocd/legislatura> .
  ?s rdfs:label ?label .
  OPTIONAL { ?s dc:title ?title }
  OPTIONAL { ?s dc:date ?date }
}
ORDER BY ?date`);
    const rows = flattenBindings(results).map(({ s, ...rest }) => ({ uri: s ?? "", ...rest }));
    return { rows, columns: ["uri", "label", "title", "date"] };
  }
};

const deputiesInput = {
  legislature: z.number().int().min(1).optional().describe("Numero legislatura Camera (es. 19)"),
  region: z.string().max(100).optional().describe("Filtra per circoscrizione/regione (match case-insensitive, es. 'sicilia')"),
  gender: z.enum(["male", "female"]).optional().describe("Filtra per genere: 'male' o 'female'"),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().nonnegative().default(0)
};

const deputies: ToolSpec<typeof deputiesInput> = {
  name: "deputies",
  title: "Deputati (Camera)",
  description:
    "[CAMERA] Lista deputati della Camera dei Deputati. Filtrabile per legislatura e circoscrizione/regione. Restituisce nome, cognome, genere, mandato, elezione.",
  examples: ["italianparliament deputies list --legislature 19 --limit 50", "italianparliament deputies list --legislature 19 --region sicilia"],
  inputSchema: deputiesInput,
  annotations: { title: "Deputati (Camera)", ...READ_ONLY },
  async rows(args, ctx) {
    const filters = [
      args.legislature !== undefined
        ? `FILTER(?rif_leg = <http://dati.camera.it/ocd/legislatura.rdf/repubblica_${args.legislature}>)`
        : "",
      args.region ? `FILTER(CONTAINS(LCASE(STR(?election_label)), LCASE(${sparqlStringLiteral(args.region)})))` : "",
      args.gender ? `FILTER(?gender = ${sparqlStringLiteral(args.gender)})` : ""
    ].filter(Boolean).join("\n  ");
    const results = await camera(ctx, `${OCD_PREFIXES}
SELECT DISTINCT ?s ?label ?first_name ?last_name ?gender ?rif_leg ?mandate_uri ?mandate_start ?mandate_end ?election_label
WHERE {
  ?s a <http://dati.camera.it/ocd/deputato> .
  ?s rdfs:label ?label .
  OPTIONAL { ?s foaf:firstName ?first_name }
  OPTIONAL { ?s foaf:surname ?last_name }
  OPTIONAL { ?s foaf:gender ?gender }
  OPTIONAL { ?s <http://dati.camera.it/ocd/rif_leg> ?rif_leg }
  OPTIONAL {
    ?s <http://dati.camera.it/ocd/rif_mandatoCamera> ?mandate_uri .
    OPTIONAL { ?mandate_uri <http://dati.camera.it/ocd/startDate> ?mandate_start }
    OPTIONAL { ?mandate_uri <http://dati.camera.it/ocd/endDate> ?mandate_end }
    OPTIONAL { ?mandate_uri <http://dati.camera.it/ocd/rif_elezione> ?election_uri . ?election_uri rdfs:label ?election_label }
  }
  ${filters}
}
LIMIT ${args.limit}
OFFSET ${args.offset}`);
    const rows: Row[] = flattenBindings(results).map(({ s, rif_leg, ...rest }) => ({ uri: s ?? "", legislature_uri: rif_leg ?? "", ...rest }));
    return {
      rows,
      columns: ["uri", "label", "first_name", "last_name", "gender", "legislature_uri", "mandate_uri", "mandate_start", "mandate_end", "election_label"],
      ...(rows.length >= args.limit ? { notice: truncationNotice(args.limit, args.offset, 1000) } : {})
    };
  }
};

const tokens = (name: string) => name.trim().split(/\s+/).filter(Boolean);

const searchInput = {
  name: z.string().min(1).max(200).describe("Nome o cognome da cercare"),
  chamber: z.enum(["camera", "senato", "both"]).default("both").describe("Ramo del parlamento in cui cercare"),
  legislature: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(500).default(50)
};

const search: ToolSpec<typeof searchInput> = {
  name: "search",
  title: "Ricerca di parlamentari per nome",
  description:
    "[CAMERA+SENATO] Cerca parlamentari per nome/cognome in Camera, Senato o entrambi. Utile come primo passo per trovare l'URI di un parlamentare.",
  examples: ['italianparliament search find --name "rossi"', 'italianparliament search find --name "boschi" --chamber camera'],
  inputSchema: searchInput,
  annotations: { title: "Ricerca di parlamentari per nome", ...READ_ONLY },
  async rows(args, ctx) {
    const rows: Row[] = [];
    // Cut per chamber, as the original decides (src/tools/search.ts:166-184): the merged list can
    // hold up to twice `limit` rows without either query having been cut.
    let truncated = false;
    if (args.chamber !== "senato") {
      const nameFilters = tokens(args.name).map((t) => `FILTER(CONTAINS(LCASE(STR(?label)), LCASE(${sparqlStringLiteral(t)})))`).join("\n  ");
      const legFilter = args.legislature !== undefined
        ? `FILTER(?rif_leg = <http://dati.camera.it/ocd/legislatura.rdf/repubblica_${args.legislature}>)` : "";
      const r = await camera(ctx, `${OCD_PREFIXES}
SELECT DISTINCT ?s ?label ?first_name ?last_name ?gender ?rif_leg
WHERE {
  ?s a <http://dati.camera.it/ocd/deputato> .
  ?s rdfs:label ?label .
  OPTIONAL { ?s foaf:firstName ?first_name }
  OPTIONAL { ?s foaf:surname ?last_name }
  OPTIONAL { ?s foaf:gender ?gender }
  OPTIONAL { ?s <http://dati.camera.it/ocd/rif_leg> ?rif_leg }
  ${nameFilters}
  ${legFilter}
}
LIMIT ${args.limit}`);
      const found = flattenBindings(r);
      truncated ||= found.length >= args.limit;
      for (const b of found) {
        rows.push({ chamber: "camera", uri: b.s, label: b.label, first_name: b.first_name, last_name: b.last_name, gender: b.gender, legislature_uri: b.rif_leg });
      }
    }
    if (args.chamber !== "camera") {
      const nameFilters = tokens(args.name).map((t) => `FILTER(CONTAINS(LCASE(CONCAT(?fn, " ", ?ln)), LCASE(${sparqlStringLiteral(t)})))`).join("\n  ");
      const legFilter = args.legislature !== undefined ? `FILTER(?leg=${args.legislature})` : "FILTER(!bound(?me))";
      const r = await senato(ctx, `${OSR_PREFIXES}
SELECT DISTINCT ?s ?fn ?ln ?leg ?me ?gen
WHERE {
  ?s a osr:Senatore .
  ?s <http://xmlns.com/foaf/0.1/firstName> ?fn .
  ?s <http://xmlns.com/foaf/0.1/lastName> ?ln .
  ?s osr:mandato ?m .
  ?m osr:legislatura ?leg .
  OPTIONAL { ?m osr:fine ?me }
  OPTIONAL { ?s <http://xmlns.com/foaf/0.1/gender> ?gen }
  ${nameFilters}
  ${legFilter}
}
ORDER BY ?ln ?fn
LIMIT ${args.limit}`);
      const found = flattenBindings(r);
      truncated ||= found.length >= args.limit;
      for (const b of found) {
        rows.push({ chamber: "senato", uri: b.s, label: `${b.fn} ${b.ln}`.trim(), first_name: b.fn, last_name: b.ln, gender: b.gen, legislature_uri: b.leg ? `http://dati.senato.it/legislatura/${b.leg}` : "" });
      }
    }
    return {
      rows,
      columns: ["chamber", "uri", "label", "first_name", "last_name", "gender", "legislature_uri"],
      ...(truncated ? { notice: truncationNotice(args.limit, 0, 500) } : {})
    };
  }
};

const sparqlInput = {
  query: z.string().min(1).max(20000).describe("Query SPARQL SELECT da eseguire"),
  endpoint: z.enum(["camera", "senato"]).describe("Endpoint su cui eseguire la query: camera (dati.camera.it) o senato (dati.senato.it)"),
  limit: z.number().int().min(1).max(1000).default(25).describe("Numero massimo di righe (iniettato come LIMIT se assente nella query)")
};

const sparql: ToolSpec<typeof sparqlInput> = {
  name: "sparql",
  title: "Query SPARQL libera",
  description:
    "[CAMERA+SENATO] Esegui una query SPARQL SELECT libera sugli endpoint del Parlamento italiano. " +
    "Endpoint Camera: dati.camera.it/sparql (prefisso ocd:). Endpoint Senato: dati.senato.it/sparql (prefisso osr:). " +
    "Solo query SELECT (read-only). Timeout 60s.",
  examples: ['italianparliament sparql query --endpoint camera --query "PREFIX ocd: <http://dati.camera.it/ocd/> SELECT (COUNT(?s) AS ?n) WHERE { ?s a ocd:deputato }"'],
  inputSchema: sparqlInput,
  annotations: { title: "Query SPARQL libera", ...READ_ONLY },
  async rows(args, ctx) {
    validateSelectQuery(args.query);
    const { query, injected } = injectLimit(args.query, args.limit);
    const rows = flattenBindings(await (args.endpoint === "camera" ? camera : senato)(ctx, query));
    return {
      rows,
      // Only when the limit was ours: a query with its own LIMIT was not cut by `limit`.
      ...(injected && rows.length >= args.limit ? { notice: truncationNotice(args.limit, 0, 1000) } : {})
    };
  }
};

export function createParliamentSpikeProfile(): Profile {
  return {
    id: "parliament-spike",
    version: "0.0.0",
    // No prefix: the original's 43 unprefixed names are its users' contract.
    tools: [legislatures, deputies, search, sparql],
    hostPolicies: {
      // Original src/core/client.ts: Senato blocked the IP after ~9 quick queries (403, 2026-07-08) and the block
      // does not decay; >= 2 s between the start of two Senato requests. Both endpoints: 5 attempts, backoff
      // 250 ms doubling to 2 s, 60 s timeout. The original retries everything except a 4xx other than 429
      // (including an unparsable 200); the core retries only network/timeout, 5xx and 429.
      "dati.senato.it": { minIntervalMs: 2000, retry: { attempts: 5, baseDelayMs: 250, maxDelayMs: 2000 }, timeoutMs: 60000 },
      "dati.camera.it": { retry: { attempts: 5, baseDelayMs: 250, maxDelayMs: 2000 }, timeoutMs: 60000 }
    },
    shrinkableKeys: ["rows"],
    telemetryFields: ["name", "chamber", "legislature", "endpoint", "limit", "offset"],
    untrustedSourceLabel: "the parliament's open data service",
    // The original's text for an empty result (src/server.ts DEFAULT_EMPTY), applied by the host.
    emptyText: DEFAULT_EMPTY,
    honestUserAgent: "italianparliament-mcp-spike/0.0.0",
    describeError(error) {
      if (error instanceof SparqlValidationError) return "→ Solo SELECT: riscrivi la query senza operazioni di scrittura.";
      const { status, url } = (error ?? {}) as { status?: number; url?: string };
      if (status === 403) {
        return url?.includes("dati.senato.it")
          ? "→ Il Senato ha rifiutato la richiesta (403): blocca l'IP dopo raffiche di query. Non ripetere subito."
          : "→ L'endpoint ha rifiutato la richiesta (403). Non ripetere subito.";
      }
      return null;
    }
  };
}
