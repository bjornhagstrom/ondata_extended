/**
 * The SKOS vocabulary profile. Tools are prefixed `vocab_` and speak SKOS; backends are
 * adapters (TemaTres first).
 *
 * MVP: eight tools (src/tools.ts) over one adapter (TemaTres).
 */

import type { HostPolicy, InstanceEntry, Profile } from "@ondata-extended/profile-contract";
import { TemaTresProtocolError } from "./adapters/tematres/client.js";
import { ConceptNotFoundError, ForeignConceptUriError, createSkosTools, skosInstructions } from "./tools.js";
import { UnknownVocabularyError, type VocabExt } from "./vocabularies.js";

export const PROFILE_ID = "skos";
export const TOOL_PREFIX = "vocab_";
export const PROFILE_VERSION = "0.1.0";

export * from "./model.js";
export { createResolver, type VocabExt } from "./vocabularies.js";
export { createSkosTools, localId, skosInstructions, vocabArgDescription } from "./tools.js";
export { htmlToText } from "./text.js";

export interface SkosProfileOptions {
  /** The deployment's known vocabularies: ids usable as `vocab`; the first is the default. */
  vocabularies?: readonly InstanceEntry<VocabExt>[];
  /**
   * The deployment's own sentence for the server instructions, appended to the generated ones: what its vocabularies
   * are for (e.g. "Vocabulary X holds the terms of project Y; in work on Y, use its preferred terms").
   */
  instructions?: string;
  /**
   * The deployment's limits per vocabulary host (hostname -> policy), e.g. a minimum interval between requests to a
   * server that asked for gentle use. The core applies them to every request to that host.
   */
  hostPolicies?: Readonly<Record<string, HostPolicy>>;
}

export function createSkosProfile(options: SkosProfileOptions = {}): Profile {
  return {
    id: PROFILE_ID,
    version: PROFILE_VERSION,
    toolPrefix: TOOL_PREFIX,
    tools: createSkosTools(options.vocabularies ?? []),
    instructions: skosInstructions(options.vocabularies ?? [], options.instructions),
    ...(options.hostPolicies
      ? { hostPolicies: Object.fromEntries(Object.entries(options.hostPolicies).map(([host, policy]) => [host.toLowerCase(), policy])) }
      : {}),
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
      if (error instanceof UnknownVocabularyError) {
        return error.noDefault
          ? "→ Pass a vocabulary service's base URL as `vocab`."
          : "→ Use one of the ids listed in the `vocab` argument's description, or a vocabulary service's base URL.";
      }
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
