/**
 * Known vocabularies and how a tool argument becomes one.
 *
 * `vocab` may be a registry id ("svada"), the base URL of a known instance, or the base URL
 * of any other TemaTres installation (then the TemaTres adapter is assumed). Every request
 * still goes through the core's guards, so a deployment's allowlist decides what is
 * reachable.
 */

import type { EngineConfig, InstanceEntry } from "@ondata-extended/profile-contract";
import { createInstanceRegistry } from "@ondata-extended/core";
import type { VocabularyAdapter, VocabularyInstance } from "./model.js";
import { temaTresAdapter } from "./adapters/tematres/adapter.js";

export interface VocabExt {
  adapter: string;
  defaultLang?: string;
  title?: string;
  /** The text before the id in concept URIs, as the instance's SKOS export writes them. */
  conceptUriBase?: string;
}

export const KNOWN_VOCABULARIES: InstanceEntry<VocabExt>[] = [
  {
    id: "svada",
    baseUrl: "https://begrepp.hagstrom.nu/",
    ext: { adapter: "tematres", defaultLang: "sv", title: "Svada - termer och begrepp", conceptUriBase: "https://begrepp.hagstrom.nu/skos/" }
  }
];

export const ADAPTERS: Record<string, VocabularyAdapter> = { [temaTresAdapter.id]: temaTresAdapter };

export class UnknownVocabularyError extends Error {
  constructor(value: string) {
    super(`Unknown vocabulary "${value}". Use a known id or the base URL of a vocabulary service.`);
    this.name = "UnknownVocabularyError";
  }
}

export function createResolver(config: EngineConfig, entries: InstanceEntry<VocabExt>[] = KNOWN_VOCABULARIES) {
  const registry = createInstanceRegistry(entries);
  const defaultId = config.get("DEFAULT_VOCAB") ?? entries[0]?.id;

  return {
    registry,
    resolve(value: string | undefined): { instance: VocabularyInstance; adapter: VocabularyAdapter } {
      const wanted = value?.trim() || defaultId;
      if (!wanted) throw new UnknownVocabularyError("");
      const entry = registry.find(wanted);
      if (entry) {
        const adapter = ADAPTERS[entry.ext.adapter];
        if (!adapter) throw new Error(`No adapter "${entry.ext.adapter}" for vocabulary "${entry.id}"`);
        return {
          instance: {
            id: entry.id,
            baseUrl: entry.baseUrl,
            adapter: entry.ext.adapter,
            ...(entry.ext.defaultLang ? { defaultLang: entry.ext.defaultLang } : {}),
            ...(entry.ext.conceptUriBase ? { conceptUriBase: entry.ext.conceptUriBase } : {})
          },
          adapter
        };
      }
      let url: URL;
      try {
        url = new URL(wanted);
      } catch {
        throw new UnknownVocabularyError(wanted);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnknownVocabularyError(wanted);
      return { instance: { id: url.toString(), baseUrl: url.toString(), adapter: temaTresAdapter.id }, adapter: temaTresAdapter };
    }
  };
}
