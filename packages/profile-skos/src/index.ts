/**
 * The SKOS vocabulary profile. Tools are prefixed `vocab_` and speak SKOS; backends are
 * adapters (TemaTres first).
 *
 * MVP: eight tools (src/tools.ts) over one adapter (TemaTres).
 */

import type { Profile } from "@ondata-extended/profile-contract";
import { TemaTresProtocolError } from "./adapters/tematres/client.js";
import { ConceptNotFoundError, ForeignConceptUriError, SKOS_TOOLS } from "./tools.js";
import { UnknownVocabularyError } from "./vocabularies.js";

export const PROFILE_ID = "skos";
export const TOOL_PREFIX = "vocab_";
export const PROFILE_VERSION = "0.1.0";

export * from "./model.js";
export { KNOWN_VOCABULARIES, createResolver } from "./vocabularies.js";
export { SKOS_TOOLS, localId } from "./tools.js";
export { htmlToText } from "./text.js";

export function createSkosProfile(): Profile {
  return {
    id: PROFILE_ID,
    version: PROFILE_VERSION,
    toolPrefix: TOOL_PREFIX,
    tools: SKOS_TOOLS,
    shrinkableKeys: ["concepts", "results", "narrower", "related", "broader", "altLabels", "notes", "mappings"],
    telemetryFields: ["vocab", "query", "prefix", "id", "limit", "response_format"],
    untrustedSourceLabel: "the vocabulary service",
    honestUserAgent: `Vocab-MCP-Server/${PROFILE_VERSION}`,
    describeError(error) {
      if (error instanceof ForeignConceptUriError) {
        return "→ Pass the vocabulary it belongs to as `vocab` (its id or base URL), or use the concept's id from a search in this vocabulary.";
      }
      if (error instanceof ConceptNotFoundError) {
        return "→ Find the concept's id with vocab_search_concepts or vocab_suggest; ids are local to one vocabulary.";
      }
      if (error instanceof UnknownVocabularyError) return "→ Omit `vocab` to use the default vocabulary.";
      if (error instanceof TemaTresProtocolError) {
        // TemaTres answers a search text shorter than its minimum (CFG_MIN_SEARCH_SIZE) with the same XML page.
        if (error.task === "search" || error.task === "suggestDetails") {
          return "→ The service refused the search text: use a longer one (TemaTres has a minimum search length, often 2-3 characters). If that does not help, check the vocabulary address.";
        }
        return "→ The address may not be a TemaTres vocabulary service, or the service is misconfigured. Check the base URL.";
      }
      const name = (error as { name?: string } | null)?.name;
      if (name === "TransportError") return "→ The vocabulary service did not answer. Retry later.";
      if (name === "HttpStatusError") return "→ The vocabulary service refused the request. Retry later, or check the vocabulary address.";
      return null;
    }
  };
}
