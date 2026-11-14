/**
 * The CKAN ecosystem profile: search CKAN extensions, see one extension's card, list the portals running a plugin,
 * and an overview. A proof of concept for datHere's CKAN Ecosystem Catalog (docs/ckan-ecosystem-profile.md),
 * built only on open data: their pipeline's files (dathere/pose-ckanext-metadata, MIT) and GitHub's repository
 * descriptions, bundled as data/index.json, plus README openings read at call time.
 */

import type { Profile } from "@ondata-extended/profile-contract";
import { ECOSYSTEM_TOOLS, NotInIndexError } from "./tools.js";

export const PROFILE_ID = "ckan-ecosystem";
export const TOOL_PREFIX = "ecosystem_";
export const PROFILE_VERSION = "0.1.0";

export { ECOSYSTEM_TOOLS, NotInIndexError } from "./tools.js";
export { search, findExtensions, portalsUsing, usedWith, readmeOpening, UPKEEP } from "./data.js";
export type { EcosystemIndex, Extension, Plugin, Portal } from "./data.js";

export function createEcosystemProfile(): Profile {
  return {
    id: PROFILE_ID,
    version: PROFILE_VERSION,
    toolPrefix: TOOL_PREFIX,
    tools: ECOSYSTEM_TOOLS,
    hostPolicies: {
      "raw.githubusercontent.com": { timeoutMs: 15_000, retry: { attempts: 1 } }
    },
    shrinkableKeys: ["plugin_usage", "also_provided_by", "topics"],
    telemetryFields: ["query", "upkeep", "family", "min_portals", "limit", "extension", "plugin", "include_readme", "response_format"],
    untrustedSourceLabel: "the extension repositories on GitHub",
    honestUserAgent: `CKAN-Ecosystem-MCP-Server/${PROFILE_VERSION}`,
    emptyText: "Nothing found. Do not assume extensions or portals exist that are not listed.",
    describeError(error) {
      if (error instanceof NotInIndexError) {
        return "→ Use ecosystem_search_extensions to find the extension, then pass its 'owner/repo'. Only extensions in the CKAN Ecosystem Catalog's crawl are known.";
      }
      return null;
    }
  };
}
