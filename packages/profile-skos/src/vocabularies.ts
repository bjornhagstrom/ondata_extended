/**
 * Known vocabularies and how a tool argument becomes one.
 *
 * The profile knows no vocabulary itself: a deployment passes its own list (`createSkosProfile({ vocabularies })`).
 * `vocab` may be an id from that list, the base URL of a listed instance, or the base URL of any other TemaTres
 * installation (then the TemaTres adapter is assumed). Every request still goes through the core's guards, so a
 * deployment's allowlist decides what is reachable.
 */

import type { InstanceEntry } from "@ondata-extended/profile-contract";
import { createInstanceRegistry } from "@ondata-extended/core";
import type { VocabularyAdapter, VocabularyInstance } from "./model.js";
import { temaTresAdapter } from "./adapters/tematres/adapter.js";
import { withSnapshot } from "./snapshot.js";

export interface VocabExt {
  adapter: string;
  defaultLang?: string;
  title?: string;
  /** The text before the id in concept URIs, as the instance's SKOS export writes them. */
  conceptUriBase?: string;
  /**
   * A full snapshot of the vocabulary (NDJSON, one SKOS concept per line), kept in memory and revalidated at most once a
   * minute; the adapter answers what the snapshot cannot (src/snapshot.ts). Its host must be allowed like any other.
   */
  snapshotUrl?: string;
}

export const ADAPTERS: Record<string, VocabularyAdapter> = { [temaTresAdapter.id]: temaTresAdapter };

export class UnknownVocabularyError extends Error {
  /** True when no vocabulary was given and the deployment has no default. */
  readonly noDefault: boolean;
  constructor(value: string) {
    super(value
      ? `Unknown vocabulary "${value}". Use a known id or the base URL of a vocabulary service.`
      : "No vocabulary given, and this server has no default vocabulary. Pass the base URL of a vocabulary service as `vocab`.");
    this.name = "UnknownVocabularyError";
    this.noDefault = value === "";
  }
}

export function createResolver(entries: readonly InstanceEntry<VocabExt>[] = []) {
  const registry = createInstanceRegistry(entries);
  // The deployment's first vocabulary is the default; the order of its list is the setting (no config override, so
  // the `vocab` argument's description, written from the same list, always names the right default).
  const defaultId = entries[0]?.id;

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
          adapter: entry.ext.snapshotUrl ? withSnapshot(adapter, entry.ext.snapshotUrl) : adapter
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
