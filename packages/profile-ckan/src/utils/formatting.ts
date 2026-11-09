/**
 * The CKAN profile's output helpers. The generic ones (truncation, sanitizing, untrusted
 * blocks) are the core's, reached through `ctx.output`; only what is ondata's own lives here.
 *
 * Ported from ondata/ckan-mcp-server src/utils/formatting.ts at 09e8cdc (MIT, see NOTICE.md).
 */

import type { EngineContext } from "@ondata-extended/profile-contract";
import { isWorkers } from "@ondata-extended/core";

/** ondata's shrink order for JSON truncation: bulk result rows go first, structural metadata (fields) last. */
export const SHRINKABLE_KEYS = [
  'results', 'records', 'rows', 'datasets', 'resources', 'packages',
  'organizations', 'groups', 'portals', 'tags', 'facets', 'fields'
];

/** ondata's notice for its shared demo instance (src/utils/formatting.ts:221 at 09e8cdc). */
export const ONDATA_DEMO_NOTICE = "Demo instance (100k requests/day shared quota). For unlimited access: https://github.com/ondata/ckan-mcp-server#installation";

/**
 * Add the deployment's notice to markdown responses when running on Workers. The text is the
 * deployment's (`CKAN_DEMO_NOTICE`), ondata's by default, so an ondata deployment keeps its own.
 */
export function addDemoFooter(ctx: EngineContext, text: string): string {
  if (!isWorkers()) {
    return text;
  }

  const footer = `\n\n---\nℹ️ ${ctx.config.get("DEMO_NOTICE") || ONDATA_DEMO_NOTICE}`;
  return text + footer;
}

import { wrapUntrusted as coreWrapUntrusted } from "@ondata-extended/core";

/** Who untrusted text comes from, in the fence the core draws around it. */
export const UNTRUSTED_SOURCE = "the data portal";

/** ondata's `wrapUntrusted`: the core's fence, naming the data portal. */
export function wrapUntrusted(text: string): string {
  return coreWrapUntrusted(text, UNTRUSTED_SOURCE);
}
