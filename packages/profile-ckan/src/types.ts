/**
 * Ported from ondata/ckan-mcp-server src/types.ts at 09e8cdc (MIT, see NOTICE.md).
 * Fields the tools read but ondata's interfaces did not declare are added (types only: ondata is
 * built with esbuild, which does not typecheck). `CHARACTER_LIMIT` is the core's (`ctx.limits.characterLimit`, same default).
 */

import { z } from "zod";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json"
}

export const ResponseFormatSchema = z.nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");


// CKAN API domain types (compile-time only, no runtime validation)

export interface CkanTag {
  id?: string;
  name: string;
  display_name?: string;
  /** Some portals send this spelling (read in normalizePackage). */
  'display-name'?: string;
}

export interface CkanResource {
  id: string;
  name?: string;
  url?: string;
  format?: string;
  mimetype?: string;
  size?: number;
  created?: string;
  last_modified?: string;
  datastore_active?: boolean;
  access_services?: string;
  description?: string;
  [key: string]: unknown;
}

export interface CkanPackage {
  id: string;
  name: string;
  title?: string;
  notes?: string;
  metadata_created?: string;
  metadata_modified?: string;
  score?: number;
  organization?: { name: string; title?: string; id?: string };
  owner_org?: string;
  issued?: string;
  modified?: string;
  groups?: { name: string; title?: string }[];
  extras?: { key: string; value: unknown }[];
  tags?: CkanTag[];
  resources?: CkanResource[];
  /** DCAT-AP_IT dct:rightsHolder — actual owner of the dataset (may differ from organization/catalog). */
  holder_name?: string;
  /** DCAT-AP_IT dct:publisher — agent responsible for publishing the dataset (may differ from organization/catalog). */
  publisher_name?: string;
  [key: string]: unknown;
}

export interface CkanOrganization {
  id: string;
  name: string;
  title?: string;
  description?: string;
  image_url?: string;
  package_count?: number;
  [key: string]: unknown;
}

export interface CkanField {
  id: string;
  type: string;
}

export interface CkanDatastoreResult {
  resource_id?: string;
  fields: CkanField[];
  records: Record<string, unknown>[];
  total?: number;
  [key: string]: unknown;
}


import type { ToolSpec } from "@ondata-extended/profile-contract";
import type { ZodRawShape } from "zod";

/** A tool with its argument types inferred from its shape. */
export function defineTool<S extends ZodRawShape>(spec: ToolSpec<S>): ToolSpec<any> {
  return spec as ToolSpec<any>;
}

import type { PromptSpec } from "@ondata-extended/profile-contract";

/** A prompt with its argument types inferred from its shape. */
export function definePrompt<S extends ZodRawShape>(spec: PromptSpec<S>): PromptSpec<any> {
  return spec as PromptSpec<any>;
}
