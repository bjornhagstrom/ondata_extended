/**
 * Parity cases: every tool (Markdown and JSON where it has both), every resource template and
 * every prompt of ondata/ckan-mcp-server at 09e8cdc, plus ondata's own smoke cases
 * (tests/smoke/cases.json, read from the clone). IDs point at old, stable records where possible
 * (Milan's 2002 air-quality dataset, a 2026-11-09 snapshot of the rest).
 */

import { readFileSync } from "node:fs";
import { ONDATA_REPO } from "./ondata.js";

export type ParityCase =
  | { id: string; kind: "tool"; name: string; args: Record<string, unknown> }
  | { id: string; kind: "resource"; uri: string }
  | { id: string; kind: "prompt"; name: string; args: Record<string, string> };

const ITALY = "https://www.dati.gov.it/opendata";
const MILAN = "https://dati.comune.milano.it";
const CANADA = "https://open.canada.ca/data";
const MILAN_DATASET = "ds475_rilevazione_qualita_aria_2002";
const MILAN_RESOURCE = "7301d0f4-0394-41f6-ad91-5191dc4933a8";
const ITALY_DATASET = "aria-pollini1";

/** Tool calls in both formats, when the tool has `response_format`. */
function both(id: string, name: string, args: Record<string, unknown>, formats = true): ParityCase[] {
  return formats
    ? [
        { id: `${id}-md`, kind: "tool", name, args: { ...args, response_format: "markdown" } },
        { id: `${id}-json`, kind: "tool", name, args: { ...args, response_format: "json" } }
      ]
    : [{ id, kind: "tool", name, args }];
}

export const COVERAGE_CASES: ParityCase[] = [
  ...both("package-search", "ckan_package_search", { server_url: ITALY, q: "aria", rows: 3 }),
  ...both("package-search-facets", "ckan_package_search", { server_url: MILAN, q: "aria", rows: 2, facet_field: ["organization", "res_format"], facet_limit: 5 }),
  ...both("find-relevant", "ckan_find_relevant_datasets", { server_url: MILAN, query: "qualità aria", limit: 3 }),
  ...both("package-show", "ckan_package_show", { server_url: MILAN, id: MILAN_DATASET }),
  ...both("package-show-italy", "ckan_package_show", { server_url: ITALY, id: ITALY_DATASET }),
  ...both("package-show-missing", "ckan_package_show", { server_url: MILAN, id: "no-such-dataset-parity" }),
  ...both("list-resources", "ckan_list_resources", { server_url: MILAN, id: MILAN_DATASET }),
  ...both("organization-list", "ckan_organization_list", { server_url: MILAN, limit: 5 }),
  ...both("organization-show", "ckan_organization_show", { server_url: MILAN, id: "comunedimilano" }),
  ...both("organization-search", "ckan_organization_search", { server_url: ITALY, pattern: "friuli" }),
  ...both("datastore-search", "ckan_datastore_search", { server_url: MILAN, resource_id: MILAN_RESOURCE, limit: 3 }),
  ...both("datastore-sql", "ckan_datastore_search_sql", { server_url: MILAN, sql: `SELECT * FROM "${MILAN_RESOURCE}" LIMIT 2` }),
  ...both("status", "ckan_status_show", { server_url: MILAN }, false),
  ...both("tag-list", "ckan_tag_list", { server_url: MILAN, limit: 10 }),
  ...both("group-list", "ckan_group_list", { server_url: MILAN, limit: 5 }),
  ...both("group-show", "ckan_group_show", { server_url: MILAN, id: "envi" }),
  ...both("group-search", "ckan_group_search", { server_url: ITALY, pattern: "ambiente" }),
  ...both("mqa", "ckan_get_mqa_quality", { server_url: ITALY, dataset_id: ITALY_DATASET }),
  ...both("mqa-details", "ckan_get_mqa_quality_details", { server_url: ITALY, dataset_id: ITALY_DATASET }),
  ...both("analyze", "ckan_analyze_datasets", { server_url: MILAN, q: "aria", rows: 3 }),
  ...both("catalog-stats", "ckan_catalog_stats", { server_url: MILAN, facet_limit: 5 }),
  ...both("sparql", "sparql_query", { endpoint_url: "https://lod.dati.gov.it/sparql", query: "SELECT ?s WHERE { ?s ?p ?o }", limit: 3 }),
  ...both("find-portals", "ckan_find_portals", { country: "Italy", limit: 5 }, false),
  ...both("migrated-portal", "ckan_package_search", { server_url: "https://catalog.data.gov", q: "water", rows: 2 }),
  // id from ondata's smoke case "scheming portal" (tests/smoke/cases.json)
  ...both("canada-show", "ckan_package_show", { server_url: CANADA, id: "01313060-f926-4460-a537-4204e47c88a5" }),
  // Added in CKAN round 2 (2026-11-09): branches the first set did not reach.
  ...both("organization-show-missing", "ckan_organization_show", { server_url: MILAN, id: "no-such-organization-parity" }),
  ...both("organization-list-count", "ckan_organization_list", { server_url: MILAN, limit: 0 }),
  ...both("organization-list-all", "ckan_organization_list", { server_url: MILAN, all_fields: true, limit: 3 }),
  ...both("tag-list-query", "ckan_tag_list", { server_url: MILAN, tag_query: "aria", limit: 5 }),
  // Added in CKAN round 3 (2026-11-09).
  ...both("package-search-or", "ckan_package_search", { server_url: MILAN, q: "aria OR acqua", rows: 2 }),
  ...both("package-search-page", "ckan_package_search", { server_url: ITALY, q: "trasporti", page: 2, page_size: 2 }),
  ...both("datastore-search-filters", "ckan_datastore_search", { server_url: MILAN, resource_id: MILAN_RESOURCE, filters: { inquinante: "SO2" }, fields: ["data", "valore"], sort: "valore desc", limit: 3 }),
  ...both("datastore-search-columns", "ckan_datastore_search", { server_url: MILAN, resource_id: MILAN_RESOURCE, limit: 0 }),
  ...both("datastore-sql-bad-column", "ckan_datastore_search_sql", { server_url: MILAN, sql: `SELECT no_such_column FROM "${MILAN_RESOURCE}" LIMIT 1` }),
  ...both("datastore-search-missing", "ckan_datastore_search", { server_url: MILAN, resource_id: "00000000-0000-0000-0000-000000000000", limit: 1 }),
  ...both("group-show-missing", "ckan_group_show", { server_url: MILAN, id: "no-such-group-parity" }),
  ...both("list-resources-italy", "ckan_list_resources", { server_url: ITALY, id: ITALY_DATASET }),
  // No network: argument validation and the guards, where the SDK versions (1.27.1 there,
  // 1.32.2 here) or the core's guards could word things differently.
  { id: "offline-unknown-arg", kind: "tool", name: "ckan_status_show", args: { server_url: MILAN, bogus: 1 } },
  { id: "offline-bad-url", kind: "tool", name: "ckan_status_show", args: { server_url: "not a url" } },
  { id: "offline-limit-range", kind: "tool", name: "ckan_tag_list", args: { server_url: MILAN, limit: 5000 } },
  ...both("offline-private-host", "ckan_organization_show", { server_url: "http://127.0.0.1", id: "x" }),
  { id: "offline-metadata-host", kind: "tool", name: "ckan_organization_list", args: { server_url: "http://169.254.169.254/latest" } },
  { id: "offline-file-scheme", kind: "tool", name: "ckan_tag_list", args: { server_url: "file:///etc/passwd" } },
  { id: "res-dataset", kind: "resource", uri: `ckan://dati.comune.milano.it/dataset/${MILAN_DATASET}` },
  { id: "res-resource", kind: "resource", uri: `ckan://dati.comune.milano.it/resource/${MILAN_RESOURCE}` },
  { id: "res-organization", kind: "resource", uri: "ckan://dati.comune.milano.it/organization/comunedimilano" },
  { id: "res-group-datasets", kind: "resource", uri: "ckan://dati.comune.milano.it/group/envi/datasets" },
  { id: "res-org-datasets", kind: "resource", uri: "ckan://dati.comune.milano.it/organization/comunedimilano/datasets" },
  // a tag with datasets (tag "aria" has none on this portal, so it rendered nothing)
  { id: "res-tag-datasets", kind: "resource", uri: "ckan://dati.comune.milano.it/tag/serie_storica/datasets" },
  { id: "res-format-datasets", kind: "resource", uri: "ckan://dati.comune.milano.it/format/CSV/datasets" },
  { id: "prompt-theme", kind: "prompt", name: "ckan-search-by-theme", args: { server_url: MILAN, theme: "ambiente", rows: "5" } },
  { id: "prompt-organization", kind: "prompt", name: "ckan-search-by-organization", args: { server_url: MILAN, organization: "comunedimilano", rows: "5" } },
  { id: "prompt-format", kind: "prompt", name: "ckan-search-by-format", args: { server_url: MILAN, format: "CSV", rows: "5" } },
  { id: "prompt-recent", kind: "prompt", name: "ckan-recent-datasets", args: { server_url: MILAN, rows: "5" } },
  { id: "prompt-analyze", kind: "prompt", name: "ckan-analyze-dataset", args: { server_url: MILAN, id: MILAN_DATASET } },
  { id: "prompt-hvd", kind: "prompt", name: "ckan-search-hvd", args: { server_url: ITALY, rows: "5" } }
];

/** ondata's smoke cases as parity cases (same tool, same arguments, the case's portal). */
export function smokeCases(): ParityCase[] {
  const { cases } = JSON.parse(readFileSync(`${ONDATA_REPO}/tests/smoke/cases.json`, "utf8")) as {
    cases: { name: string; server: string; tool: string; args: Record<string, unknown>; compare_with?: { tool: string; args: Record<string, unknown> } }[];
  };
  return cases.flatMap((c, i) => {
    const id = `smoke-${String(i + 1).padStart(2, "0")}`;
    const main: ParityCase = { id, kind: "tool", name: c.tool, args: { server_url: c.server, ...c.args, response_format: "json" } };
    // A case that compares two tools (scripts/smoke.mjs) records the second call as its own case.
    return c.compare_with
      ? [main, { id: `${id}b`, kind: "tool", name: c.compare_with.tool, args: { server_url: c.server, ...c.compare_with.args, response_format: "json" } }]
      : [main];
  });
}

export const allCases = (): ParityCase[] => [...COVERAGE_CASES, ...smokeCases()];
