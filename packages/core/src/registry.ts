/**
 * A registry of known backend instances, generic over the profile's own particulars.
 *
 * Generalized from ondata/ckan-mcp-server src/utils/portal-config.ts (commit 09e8cdc):
 * lookup by exact URL or alias (lines 53-63), by hostname (98-105), a migration notice per
 * instance (70-77) and an API path (127-130). What a profile stores beyond that goes under
 * `ext`.
 */

import type { InstanceEntry, InstanceRegistry } from "@ondata-extended/profile-contract";

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function createInstanceRegistry<Ext>(entries: readonly InstanceEntry<Ext>[]): InstanceRegistry<Ext> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) throw new Error(`Duplicate instance id "${e.id}"`);
    ids.add(e.id);
    new URL(e.baseUrl); // throws on a malformed registry entry
  }
  const frozen = Object.freeze([...entries]);
  return {
    all: () => frozen,
    find(idOrUrl: string) {
      const byId = frozen.find((e) => e.id === idOrUrl);
      if (byId) return byId;
      const target = normalizeUrl(idOrUrl);
      return frozen.find((e) =>
        normalizeUrl(e.baseUrl) === target || (e.aliases ?? []).some((a) => normalizeUrl(a) === target));
    },
    byHostname(hostname: string) {
      const h = hostname.toLowerCase();
      return frozen.find((e) =>
        hostnameOf(e.baseUrl) === h || (e.aliases ?? []).some((a) => hostnameOf(a) === h));
    }
  };
}
