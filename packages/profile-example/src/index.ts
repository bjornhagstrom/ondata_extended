/**
 * An example profile, written as the worked example of docs/writing-a-profile.md: the smallest
 * profile that still uses every part of the contract a real one needs (a rows tool, a handler
 * tool, host policies, a secret from config, telemetry fields, error hints, untrusted text).
 *
 * Source: the Italian Senate's Akoma Ntoso bulk data on GitHub (src/akn.ts). Not deployed.
 */

import type { Profile } from "@ondata-extended/profile-contract";
import { NotInRepositoryError, EXAMPLE_TOOLS } from "./tools.js";

export const PROFILE_ID = "akn-example";
export const TOOL_PREFIX = "akn_";
export const PROFILE_VERSION = "0.1.0";

export { EXAMPLE_TOOLS } from "./tools.js";
export * from "./akn.js";

export function createExampleProfile(): Profile {
  return {
    id: PROFILE_ID,
    version: PROFILE_VERSION,
    toolPrefix: TOOL_PREFIX,
    tools: EXAMPLE_TOOLS,
    // What each upstream host tolerates. The core applies it to every request to that host.
    hostPolicies: {
      "api.github.com": { minIntervalMs: 1000, timeoutMs: 15_000, retry: { attempts: 2 } },
      "raw.githubusercontent.com": { timeoutMs: 30_000, retry: { attempts: 2 } }
    },
    shrinkableKeys: [],
    // Arguments the host may log (capped at 200 characters). Never a secret.
    telemetryFields: ["legislature", "ddl", "kind", "file", "response_format"],
    untrustedSourceLabel: "the Senate's Akoma Ntoso files",
    honestUserAgent: `Akn-Example-MCP-Server/${PROFILE_VERSION}`,
    emptyText: "No entries. Do not assume documents exist that are not listed.",
    describeError(error) {
      if (error instanceof NotInRepositoryError) {
        return "→ Check the legislature and the ddl id (the number in http://dati.senato.it/ddl/<id>, not 'S.1944'). Call akn_list_files without `kind` to see the bill's folders.";
      }
      const e = error as { name?: string; status?: number; url?: string } | null;
      if (e?.name === "HttpStatusError" && (e.status === 403 || e.status === 429)) {
        // The token raises the API's limit only; the raw file host has its own and takes no token.
        const api = typeof e.url === "string" && e.url.startsWith("https://api.github.com/");
        return api
          ? "→ GitHub's API request limit was reached (60 an hour without a token). Retry later; the deployment can set a GitHub token to raise it."
          : "→ GitHub refused or limited the file download. Retry later.";
      }
      if ((error as { name?: string } | null)?.name === "TransportError") return "→ GitHub did not answer. Retry later.";
      return null;
    }
  };
}
