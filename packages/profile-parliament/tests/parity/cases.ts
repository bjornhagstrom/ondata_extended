/**
 * Parity cases for the ported tools of ondata's italianparliament-mcp at fd46810: arguments,
 * filters, ranking, birthplace parsing, empty results, errors and truncation.
 *
 * Upstream answers come from two sources, and each exchange in a recording says which:
 * - dati.camera.it, recorded live once (sequential, >= 2 s apart, identical requests asked once).
 * - Synthetic: every dati.senato.it answer (Senato blocks an IP after a burst and the block does
 *   not decay; NO request may ever reach a senato.it host), and the Camera failures (HTTP errors,
 *   a broken body, a flapping endpoint) and a few edge answers that a live endpoint cannot be asked
 *   for on demand. Synthetic answers are shaped like the endpoints' SPARQL JSON (Virtuoso), from the
 *   original's queries and tests, and marked `synthetic: true` in the recording.
 */

export type Synthetic = (url: URL, n: number) => { status: number; body: string; contentType?: string } | undefined;

export interface ParityCase {
  id: string;
  kind: "tool";
  name: string;
  args: Record<string, unknown>;
  /** Answers some requests instead of the network; `n` counts earlier calls with the same URL. */
  synthetic?: Synthetic;
}

type Cell = string | { uri: string } | { int: string };

/** A SPARQL SELECT answer in the shape Virtuoso gives (dati.camera.it, dati.senato.it). */
export function sparqlJson(vars: string[], rows: Record<string, Cell>[]): string {
  const binding = (c: Cell) =>
    typeof c === "string" ? { type: "literal", value: c }
      : "uri" in c ? { type: "uri", value: c.uri }
      : { type: "typed-literal", datatype: "http://www.w3.org/2001/XMLSchema#integer", value: c.int };
  return JSON.stringify({
    head: { link: [], vars },
    results: { distinct: false, ordered: true, bindings: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, binding(v)]))) }
  });
}

const json = (body: string) => ({ status: 200, body, contentType: "application/sparql-results+json" });
const isSenato = (url: URL) => url.hostname === "dati.senato.it";
const isCamera = (url: URL) => url.hostname === "dati.camera.it";
const queryOf = (url: URL) => url.searchParams.get("query") ?? "";
/** The original's current-legislature probe (src/core/current-legislature.ts). */
const isCurrentLegislatureProbe = (url: URL) => isCamera(url) && queryOf(url).includes('FILTER(CONTAINS(STR(?s), "repubblica_"))');

const SENATO_VARS = ["s", "fn", "ln", "leg", "me", "gen"];
/** Synthetic senators: invented names and ids (9xxxx), Senato's shapes (typed legislature, M/F gender). */
const senator = (id: number, fn: string, ln: string, leg: string, gen: "M" | "F", me?: string): Record<string, Cell> => ({
  s: { uri: `http://dati.senato.it/senatore/${id}` }, fn, ln, leg: { int: leg }, ...(me ? { me } : {}), gen
});

export const CASES: ParityCase[] = [
  // legislatures
  { id: "legislatures", kind: "tool", name: "legislatures", args: {} },
  { id: "legislatures-empty", kind: "tool", name: "legislatures", args: {}, synthetic: (u) => (isCamera(u) ? json(sparqlJson(["s", "label", "title", "date"], [])) : undefined) },

  // deputies
  { id: "deputies-leg19-limit3", kind: "tool", name: "deputies", args: { legislature: 19, limit: 3, offset: 0 } },
  { id: "deputies-female-limit3", kind: "tool", name: "deputies", args: { legislature: 19, gender: "female", limit: 3 } },
  { id: "deputies-female-sicilia", kind: "tool", name: "deputies", args: { legislature: 19, gender: "female", birthPlace: "sicilia", limit: 100, offset: 0 } },
  { id: "deputies-born-1990s", kind: "tool", name: "deputies", args: { legislature: 19, bornFrom: "1990-01-01", bornTo: "1999-12-31", limit: 100, offset: 0 } },
  { id: "deputies-region-offset", kind: "tool", name: "deputies", args: { legislature: 19, region: "lombardia", limit: 5, offset: 10 } },
  { id: "deputies-estero", kind: "tool", name: "deputies", args: { legislature: 19, region: "estero", limit: 12 } },
  { id: "deputies-empty", kind: "tool", name: "deputies", args: { legislature: 19, birthPlace: "zzqx", limit: 5 } },
  // Birthplace slugs the live set may not hold: a two-part region (Aosta, Trentino), a foreign
  // country, one part, a query string on the IRI, and an 8-digit and an odd birth date.
  {
    id: "deputies-birthplace-shapes", kind: "tool", name: "deputies", args: { legislature: 10, limit: 6 },
    synthetic: (u) => {
      if (!isCamera(u)) return undefined;
      const vars = ["s", "label", "first_name", "last_name", "gender", "birth_date", "birth_place_uri", "description", "photo_url", "profile_url", "rif_leg", "mandate_uri", "mandate_start", "mandate_end", "mandate_termination_reason", "mandate_validation", "election_uri", "election_label"];
      const dep = (id: string, place: string, date: string): Record<string, Cell> => ({
        s: { uri: `http://dati.camera.it/ocd/deputato.rdf/d${id}_10` }, label: `DEPUTATO ${id}, X Legislatura della Repubblica`, first_name: "NOME", last_name: `COGNOME${id}`, gender: "male",
        birth_date: date, birth_place_uri: { uri: `http://dati.camera.it/ocd/luogo.rdf/${place}` }, rif_leg: { uri: "http://dati.camera.it/ocd/legislatura.rdf/repubblica_10" },
        mandate_uri: { uri: `http://dati.camera.it/ocd/mandatoCamera.rdf/mc${id}_10` }, mandate_start: "19870702"
      });
      return json(sparqlJson(vars, [
        dep("90001", "aosta_valle-d-aosta", "19400101"),
        dep("90002", "bozen_trentino-alto-adige", "1941"),
        dep("90003", "lugano_svizzera", "19420303"),
        dep("90004", "roma", ""),
        dep("90005", "cazzago-brabbia_varese_lombardia?x=1#y", "19440404"),
        { s: { uri: "http://dati.camera.it/ocd/deputato.rdf/d90006_10" }, label: "DEPUTATO 90006", rif_leg: { uri: "http://dati.camera.it/ocd/legislatura.rdf/repubblica_10" } }
      ]));
    }
  },

  // search
  { id: "search-meloni-camera", kind: "tool", name: "search", args: { name: "meloni", chamber: "camera", limit: 10 } },
  { id: "search-elena-schlein", kind: "tool", name: "search", args: { name: "Elena Schlein", chamber: "camera", limit: 10 } },
  { id: "search-boschi-leg19", kind: "tool", name: "search", args: { name: "boschi", chamber: "camera", legislature: 19, limit: 5 } },
  { id: "search-boschi-ranking", kind: "tool", name: "search", args: { name: "boschi", chamber: "camera", limit: 50 } },
  { id: "search-rossi-truncated", kind: "tool", name: "search", args: { name: "rossi", chamber: "camera", limit: 5 } },
  {
    id: "search-boschi-both", kind: "tool", name: "search", args: { name: "boschi", chamber: "both", limit: 50 },
    synthetic: (u) => (isSenato(u) ? json(sparqlJson(SENATO_VARS, [
      senator(90011, "ANNA", "BOSCHI", "19", "F"),
      senator(90012, "Carlo", "Tiraboschi", "18", "M"),
      senator(90013, "maria elena", "boschi", "19", "F")
    ])) : undefined)
  },
  {
    id: "search-senato-active", kind: "tool", name: "search", args: { name: "rossi", chamber: "senato", limit: 3 },
    synthetic: (u) => (isSenato(u) ? json(sparqlJson(SENATO_VARS, [
      senator(90021, "MARIO", "ROSSI", "19", "M"),
      senator(90022, "Paola", "De Rossi", "19", "F"),
      senator(90023, "Luca", "Rossini", "19", "M")
    ])) : undefined)
  },
  {
    id: "search-senato-leg18-all", kind: "tool", name: "search", args: { name: "Mario Rossi", chamber: "senato", legislature: 18, activeOnly: false, limit: 10 },
    synthetic: (u) => (isSenato(u) ? json(sparqlJson(SENATO_VARS, [
      senator(90031, "Mario", "Rossi", "18", "M", "2022-10-12"),
      senator(90032, "Rossi", "Mario", "18", "M")
    ])) : undefined)
  },
  {
    id: "search-senato-empty", kind: "tool", name: "search", args: { name: "zzqx", chamber: "senato" },
    synthetic: (u) => (isSenato(u) ? json(sparqlJson(SENATO_VARS, [])) : undefined)
  },
  {
    // The current-legislature probe fails (503 on every attempt): ranking falls back to 19.
    id: "search-current-leg-down", kind: "tool", name: "search", args: { name: 'x") } DROP GRAPH <g> #', chamber: "camera", limit: 5 },
    synthetic: (u) => {
      if (isCurrentLegislatureProbe(u)) return { status: 503, body: "Service Unavailable", contentType: "text/plain" };
      if (!isCamera(u)) return undefined;
      return json(sparqlJson(["s", "label", "first_name", "last_name", "gender", "rif_leg"], [
        { s: { uri: "http://dati.camera.it/ocd/deputato.rdf/d90041_18" }, label: "X Y, XVIII Legislatura della Repubblica", first_name: "X", last_name: "Y", gender: "male", rif_leg: { uri: "http://dati.camera.it/ocd/legislatura.rdf/repubblica_18" } },
        { s: { uri: "http://dati.camera.it/ocd/deputato.rdf/d90042_19" }, label: "X Z, XIX Legislatura della Repubblica", first_name: "X", last_name: "Z", gender: "female", rif_leg: { uri: "http://dati.camera.it/ocd/legislatura.rdf/repubblica_19" } }
      ]));
    }
  },

  // sparql
  { id: "sparql-camera-count", kind: "tool", name: "sparql", args: { query: "PREFIX ocd: <http://dati.camera.it/ocd/> SELECT (COUNT(?s) AS ?n) WHERE { ?s a ocd:legislatura }", endpoint: "camera", limit: 1 } },
  { id: "sparql-oneline-prefix", kind: "tool", name: "sparql", args: { query: "PREFIX ocd: <http://dati.camera.it/ocd/> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> SELECT ?label WHERE { ?o a ocd:legislatura ; rdfs:label ?label }", endpoint: "camera", limit: 1 } },
  { id: "sparql-own-limit", kind: "tool", name: "sparql", args: { query: "PREFIX ocd: <http://dati.camera.it/ocd/>\nSELECT ?s WHERE { ?s a ocd:legislatura } ORDER BY ?s LIMIT 3", endpoint: "camera", limit: 2 } },
  { id: "sparql-empty", kind: "tool", name: "sparql", args: { query: "SELECT ?s WHERE { ?s a <http://dati.camera.it/ocd/parity-no-such-class> }", endpoint: "camera" } },
  {
    id: "sparql-senato-count", kind: "tool", name: "sparql", args: { query: "PREFIX osr: <http://dati.senato.it/osr/> SELECT (COUNT(?s) AS ?n) WHERE { ?s a osr:Senatore }", endpoint: "senato", limit: 1 },
    synthetic: (u) => (isSenato(u) ? json(sparqlJson(["n"], [{ n: { int: "1234" } }])) : undefined)
  },
  {
    id: "sparql-at-ceiling", kind: "tool", name: "sparql", args: { query: "SELECT ?n WHERE { ?s ?p ?n }", endpoint: "camera", limit: 1000 },
    synthetic: (u) => (isCamera(u) ? json(sparqlJson(["n"], Array.from({ length: 1000 }, (_, i) => ({ n: String(i) })))) : undefined)
  },
  { id: "sparql-not-select", kind: "tool", name: "sparql", args: { query: "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }", endpoint: "camera", limit: 10 } },
  { id: "sparql-hidden-update", kind: "tool", name: "sparql", args: { query: "SELECT ?s WHERE { ?s ?p ?o } ; DROP GRAPH <http://x/g>", endpoint: "camera" } },
  {
    id: "sparql-camera-400", kind: "tool", name: "sparql", args: { query: "SELECT ?s WHERE { ?s ?p }", endpoint: "camera" },
    synthetic: (u) => (isCamera(u) ? { status: 400, body: "Virtuoso 37000 Error SP030: SPARQL compiler, line 3: syntax error", contentType: "text/plain" } : undefined)
  },
  {
    id: "sparql-senato-403", kind: "tool", name: "sparql", args: { query: "SELECT ?s WHERE { ?s ?p ?o }", endpoint: "senato" },
    synthetic: (u) => (isSenato(u) ? { status: 403, body: "<html><body>Forbidden</body></html>", contentType: "text/html" } : undefined)
  },
  {
    id: "sparql-camera-503-always", kind: "tool", name: "sparql", args: { query: "SELECT ?s WHERE { ?s ?p ?o }", endpoint: "camera", limit: 2 },
    synthetic: (u) => (isCamera(u) ? { status: 503, body: "Service Unavailable", contentType: "text/plain" } : undefined)
  },
  {
    id: "sparql-camera-flap", kind: "tool", name: "sparql", args: { query: "SELECT ?s WHERE { ?s ?p ?o }", endpoint: "camera", limit: 2 },
    synthetic: (u, n) => (!isCamera(u) ? undefined
      : n < 2 ? { status: 502, body: "Bad Gateway", contentType: "text/html" }
      : json(sparqlJson(["s"], [{ s: { uri: "http://dati.camera.it/ocd/a" } }])))
  },
  {
    id: "sparql-camera-broken-body", kind: "tool", name: "sparql", args: { query: "SELECT ?s WHERE { ?s ?p ?o }", endpoint: "camera", limit: 2 },
    synthetic: (u) => (isCamera(u) ? { status: 200, body: "<html><body>maintenance</body></html>", contentType: "text/html" } : undefined)
  },
  {
    id: "sparql-camera-429-then-ok", kind: "tool", name: "sparql", args: { query: "SELECT ?s WHERE { ?s ?p ?o }", endpoint: "camera", limit: 5 },
    synthetic: (u, n) => (!isCamera(u) ? undefined
      : n < 1 ? { status: 429, body: "Too Many Requests", contentType: "text/plain" }
      : json(sparqlJson(["s", "o"], [{ s: { uri: "http://dati.camera.it/ocd/a" }, o: "uno" }, { s: { uri: "http://dati.camera.it/ocd/b" } }])))
  },

  // Arguments the schema refuses (no request is made).
  { id: "offline-deputies-bad-date", kind: "tool", name: "deputies", args: { bornFrom: "1990" } },
  { id: "offline-search-bad-chamber", kind: "tool", name: "search", args: { name: "rossi", chamber: "regno" } },
  { id: "offline-sparql-limit-range", kind: "tool", name: "sparql", args: { query: "SELECT ?s WHERE { ?s ?p ?o }", endpoint: "camera", limit: 0 } }
];
