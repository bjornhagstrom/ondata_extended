/**
 * The SKOS vocabulary profile. Tools are prefixed `vocab_` and speak SKOS; backends are
 * adapters (TemaTres first).
 *
 * Nine reading tools (src/tools.ts), and two change tools where a vocabulary is writable and the deployment offers them (src/change-tools.ts), over one adapter (TemaTres), optionally answered from a snapshot (src/snapshot.ts).
 */

import type { HostPolicy, InstanceEntry, Profile } from "@ondata-extended/profile-contract";
import { TemaTresProtocolError } from "./adapters/tematres/client.js";
import { ConceptNotFoundError, ForeignConceptUriError, createSkosTools, skosInstructions } from "./tools.js";
import { UnknownVocabularyError, type VocabExt } from "./vocabularies.js";
import { ChangeRefusedError, ChangesNotOfferedError, RandomConceptNotOfferedError } from "./model.js";
import { NotWritableVocabularyError } from "./change-tools.js";

export const PROFILE_ID = "skos";
export const TOOL_PREFIX = "vocab_";
export const PROFILE_VERSION = "0.1.0";

export * from "./model.js";
export { createResolver, type VocabExt } from "./vocabularies.js";
export { createSkosTools, localId, skosInstructions, vocabArgDescription } from "./tools.js";
export { htmlToText } from "./text.js";
export { createChangeTools, NotWritableVocabularyError } from "./change-tools.js";

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
  /**
   * Offer the change tools (vocab_propose_changes, vocab_apply_changes) for the vocabularies with write access. Off by
   * default: a deployment turns it on only for a service that no one reaches without logging in (core `login`), never
   * for an open one. A vocabulary's write access alone does not offer them.
   */
  offerChanges?: boolean;
}

export function createSkosProfile(options: SkosProfileOptions = {}): Profile {
  return {
    id: PROFILE_ID,
    version: PROFILE_VERSION,
    toolPrefix: TOOL_PREFIX,
    tools: createSkosTools(options.vocabularies ?? [], { changes: options.offerChanges === true }),
    instructions: skosInstructions(options.vocabularies ?? [], options.instructions),
    ...(options.hostPolicies
      ? { hostPolicies: Object.fromEntries(Object.entries(options.hostPolicies).map(([host, policy]) => [host.toLowerCase(), policy])) }
      : {}),
    // The core shrinks top-level lists only; one concept's lists sit inside `concept` and are fitted by the profile
    // (fitConceptAnswer in tools.ts).
    shrinkableKeys: ["concepts"],
    // Never the operations or their texts: only the batch id of a change.
    telemetryFields: ["vocab", "query", "prefix", "id", "limit", "response_format", "batch_id"],
    untrustedSourceLabel: "the vocabulary service",
    honestUserAgent: `Vocab-MCP-Server/${PROFILE_VERSION}`,
    describeError(error) {
      if (error instanceof ForeignConceptUriError) {
        return "→ Pass the vocabulary it belongs to as `vocab` (its id or base URL), or use the concept's id from a search in this vocabulary.";
      }
      if (error instanceof ConceptNotFoundError) {
        return "→ Find the concept's id with vocab_search_concepts or vocab_suggest; ids are local to one vocabulary.";
      }
      if (error instanceof RandomConceptNotOfferedError) {
        return "→ Pick a concept another way: browse from vocab_top_concepts, or find one with vocab_search_concepts.";
      }
      if (error instanceof NotWritableVocabularyError || error instanceof ChangesNotOfferedError) {
        return "→ Only the vocabularies named in the `vocab` argument's description can be changed here, and only by id. Do not try another way to write.";
      }
      if (error instanceof ChangeRefusedError) {
        if (error.code === "staleText" || error.code === "selectorNotFound" || error.code === "selectorAmbiguous" || error.code === "labelExists" || error.code === "unknownConcept") {
          return "→ Read the concepts again with vocab_get_concept, show the user what differs, and ask how to proceed; then propose a corrected batch.";
        }
        if (error.code === "batchExpired" || error.code === "batchUnknown") {
          return "→ Propose the batch again with vocab_propose_changes and show it to the user; a new batch needs the user's ok again.";
        }
        if (error.code === "batchUsed") return "→ The batch is already written: read the changed concepts back with vocab_get_concept.";
        if (error.code === "notApplied" || error.code === "unknownOutcome") {
          return "→ The batch may or may not have been written: do not apply it again. Read the concepts back with vocab_get_concept to see what changed, and tell the user.";
        }
        if (error.code === "unreadableProposal") return "→ Nothing can be applied from this dry run. Tell the user; do not apply its id.";
        if (error.code === "unavailable") return "→ Nothing was written. Retry the dry run later.";
        if (error.code === "unauthorized" || error.code === "forbidden") return "→ Tell the user: this server's write access must be checked by its operator.";
        return "→ Tell the user the service refused the change; do not retry with a different batch on your own.";
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
