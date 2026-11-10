/**
 * The Italian Parliament profile: behaves like ondata's italianparliament-mcp at fd46810 (MIT,
 * Andrea Borruso; tool names without a prefix, arguments, Italian texts, queries, output), checked
 * case by case by the black-box parity test (tests/parity, docs/parliament-port.md). Ported in
 * rounds: round 1 has `legislatures`, `deputies`, `search` and `sparql`, in the original's
 * registration order.
 */

import type { Profile } from "@ondata-extended/profile-contract";
import { toToolSpec } from "./server.js";
import { USER_AGENT } from "./core/client.js";
import { DEFAULT_TIMEOUT_MS } from "./core/endpoints.js";
import { deputiesTool } from "./tools/deputies.js";
import { searchTool } from "./tools/search.js";
import { legislaturesTool } from "./tools/legislatures.js";
import { sparqlTool } from "./tools/sparql.js";
import type { Tool } from "./tools/types.js";

export { SparqlError, cdQuery, snQuery } from "./core/client.js";
export { CAMERA_ENDPOINT, SENATO_ENDPOINT } from "./core/endpoints.js";
export { deputiesTool, searchTool, legislaturesTool, sparqlTool };
export type { Tool, ToolResult } from "./tools/types.js";

/** The ported tools, in the order of the original's `registerAll` (src/server.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PARLIAMENT_TOOLS: Tool<any>[] = [deputiesTool, searchTool, legislaturesTool, sparqlTool];

export function createParliamentProfile(): Profile {
  return {
    id: "parliament",
    version: "0.1.0",
    // No prefix: the original's unprefixed names are its users' contract.
    tools: PARLIAMENT_TOOLS.map(toToolSpec),
    hostPolicies: {
      // Original src/core/client.ts: Senato blocked the IP after ~9 quick queries (403, 2026-07-08)
      // and the block does not decay: >= 2 s between the start of two Senato requests, for the
      // whole process (here: the engine). 60 s timeout on both endpoints. Retries are the original's
      // own loop in src/core/client.ts, not the core's (see there).
      "dati.senato.it": { minIntervalMs: 2000, timeoutMs: DEFAULT_TIMEOUT_MS },
      "dati.camera.it": { timeoutMs: DEFAULT_TIMEOUT_MS }
    },
    // The tools answer as text only (JSONL); no JSON output to shrink.
    shrinkableKeys: [],
    // No free text (names, queries) in a log line.
    telemetryFields: ["chamber", "legislature", "endpoint", "limit", "offset"],
    untrustedSourceLabel: "the parliament's open data service",
    honestUserAgent: USER_AGENT
  };
}
