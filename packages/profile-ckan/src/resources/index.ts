/**
 * MCP Resources: the CKAN resource templates for direct data access.
 *
 * Ported from ondata/ckan-mcp-server src/resources/{dataset,resource,organization,dataset-filters}.ts
 * at 09e8cdc (MIT, see NOTICE.md): same templates, titles, descriptions, requests and texts, in
 * ondata's registration order (src/resources/index.ts). The DataStore table UI resource is off in
 * ondata ("awaiting use-case design") and is not ported.
 */

import type { EngineContext, ResourceContents, ResourceSpec } from "@ondata-extended/profile-contract";
import { makeCkanRequest } from "../utils/http.js";
import { parseCkanUri } from "./uri.js";

/** ondata's resource handler: one CKAN call, its result as truncated JSON, or a plain-text error. */
function jsonResource(
  errorLabel: string,
  call: (ctx: EngineContext, serverUrl: string, variables: Record<string, string>) => Promise<unknown>
): ResourceSpec["read"] {
  return async (uri, variables, ctx): Promise<ResourceContents> => {
    try {
      const { server: serverUrl } = parseCkanUri(uri);
      const result = await call(ctx, serverUrl, variables as Record<string, string>);
      const content = ctx.output.truncateJson(result);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: content }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `Error fetching ${errorLabel}: ${errorMessage}` }] };
    }
  };
}

const datasetResource: ResourceSpec = {
  name: "ckan-dataset",
  uriTemplate: "ckan://{server}/dataset/{id}",
  title: "CKAN Dataset",
  description: "Access dataset metadata from any CKAN server. URI format: ckan://{server}/dataset/{id}",
  mimeType: "application/json",
  read: jsonResource("dataset", (ctx, serverUrl, v) => makeCkanRequest<any>(ctx, serverUrl, "package_show", { id: v.id }))
};

const resourceResource: ResourceSpec = {
  name: "ckan-resource",
  uriTemplate: "ckan://{server}/resource/{id}",
  title: "CKAN Resource",
  description: "Access resource metadata and download URL from any CKAN server. URI format: ckan://{server}/resource/{id}",
  mimeType: "application/json",
  read: jsonResource("resource", (ctx, serverUrl, v) => makeCkanRequest<any>(ctx, serverUrl, "resource_show", { id: v.id }))
};

const organizationResource: ResourceSpec = {
  name: "ckan-organization",
  uriTemplate: "ckan://{server}/organization/{name}",
  title: "CKAN Organization",
  description: "Access organization metadata from any CKAN server. URI format: ckan://{server}/organization/{name}",
  mimeType: "application/json",
  read: jsonResource("organization", (ctx, serverUrl, v) =>
    makeCkanRequest<any>(ctx, serverUrl, "organization_show", { id: v.name, include_datasets: false }))
};

// dataset-filters.ts

const escapeSolrTerm = (value: string): string => value.replace(/["\\]/g, "\\$&");

const buildFormatFilter = (rawFormat: string): string => {
  const format = rawFormat.trim();
  const variants = [format];
  const upper = format.toUpperCase();
  if (upper !== format) {
    variants.push(upper);
  }

  const fields = ["res_format", "distribution_format"];
  const clauses = fields.flatMap((field) =>
    variants.map((value) => `${field}:"${escapeSolrTerm(value)}"`)
  );

  return `(${clauses.join(" OR ")})`;
};

type FilterConfig = {
  name: string;
  template: string;
  title: string;
  description: string;
  buildFq: (variables: Record<string, string>) => string;
};

const datasetFilterResource = (config: FilterConfig): ResourceSpec => ({
  name: config.name,
  uriTemplate: config.template,
  title: config.title,
  description: config.description,
  mimeType: "application/json",
  read: jsonResource("datasets", (ctx, serverUrl, v) =>
    makeCkanRequest<any>(ctx, serverUrl, "package_search", { q: "*:*", fq: config.buildFq(v) }))
});

export const CKAN_RESOURCES: ResourceSpec[] = [
  datasetResource,
  resourceResource,
  organizationResource,
  datasetFilterResource({
    name: "ckan-group-datasets",
    template: "ckan://{server}/group/{name}/datasets",
    title: "CKAN Group Datasets",
    description: "List datasets in a CKAN group (theme). URI format: ckan://{server}/group/{name}/datasets",
    buildFq: (variables) => `groups:"${escapeSolrTerm(variables.name)}"`
  }),
  datasetFilterResource({
    name: "ckan-organization-datasets",
    template: "ckan://{server}/organization/{name}/datasets",
    title: "CKAN Organization Datasets",
    description: "List datasets for a CKAN organization. URI format: ckan://{server}/organization/{name}/datasets",
    buildFq: (variables) => `organization:"${escapeSolrTerm(variables.name)}"`
  }),
  datasetFilterResource({
    name: "ckan-tag-datasets",
    template: "ckan://{server}/tag/{name}/datasets",
    title: "CKAN Tag Datasets",
    description: "List datasets matching a CKAN tag. URI format: ckan://{server}/tag/{name}/datasets",
    buildFq: (variables) => `tags:"${escapeSolrTerm(variables.name)}"`
  }),
  datasetFilterResource({
    name: "ckan-format-datasets",
    template: "ckan://{server}/format/{format}/datasets",
    title: "CKAN Format Datasets",
    description: "List datasets by resource format. URI format: ckan://{server}/format/{format}/datasets",
    buildFq: (variables) => buildFormatFilter(variables.format)
  })
];
