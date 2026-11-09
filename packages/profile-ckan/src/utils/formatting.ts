/**
 * The CKAN profile's output helpers. The generic ones (truncation, sanitizing, untrusted
 * blocks) are the core's, reached through `ctx.output`; only what is ondata's own lives here.
 *
 * Ported from ondata/ckan-mcp-server src/utils/formatting.ts at 09e8cdc (MIT, see NOTICE.md).
 */

import { isWorkers } from "@ondata-extended/core";

/** ondata's shrink order for JSON truncation: bulk result rows go first, structural metadata (fields) last. */
export const SHRINKABLE_KEYS = [
  'results', 'records', 'rows', 'datasets', 'resources', 'packages',
  'organizations', 'groups', 'portals', 'tags', 'facets', 'fields'
];

/**
 * Add demo instance footer to markdown responses when running on Workers
 */
export function addDemoFooter(text: string): string {
  if (!isWorkers()) {
    return text;
  }

  const footer = '\n\n---\nℹ️ Demo instance (100k requests/day shared quota). For unlimited access: https://github.com/ondata/ckan-mcp-server#installation';
  return text + footer;
}

import { wrapUntrusted as coreWrapUntrusted } from "@ondata-extended/core";

/** Who untrusted text comes from, in the fence the core draws around it. */
export const UNTRUSTED_SOURCE = "the data portal";

/** ondata's `wrapUntrusted`: the core's fence, naming the data portal. */
export function wrapUntrusted(text: string): string {
  return coreWrapUntrusted(text, UNTRUSTED_SOURCE);
}
