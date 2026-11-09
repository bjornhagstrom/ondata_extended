/**
 * Our CKAN profile behind an in-memory MCP client, configured as ondata is in the tests (no
 * CKAN_* settings; cache and rate limit off under Vitest), with DNS stubbed to a public address
 * because the replayed exchanges stand in for the network. Core, SDK and profile are all
 * imported inside `ourClient`, after the caller's `vi.resetModules()`, so one fresh instance of
 * each serves a case (no cross-instance `instanceof`).
 */

import type { Profile } from "@ondata-extended/profile-contract";
import type { ParityCase } from "./cases.js";
import { observe, type McpCaller } from "./ondata.js";
import * as ckanAtCollection from "../../src/index.js";

type ProfileModule = { createCkanProfile?: () => Profile };

/** `ckan://{server}/dataset/{id}` and `ckan://dati.example/dataset/x` match; variables match one segment. */
export function templateMatches(template: string, uri: string): boolean {
  const pattern = template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\\?\}/g, "[^/]+");
  return new RegExp(`^${pattern}$`).test(uri);
}

/** Whether the profile already registers what a case exercises (decided at collection time). */
export function implemented(c: ParityCase): boolean {
  const create = (ckanAtCollection as ProfileModule).createCkanProfile;
  if (!create) return false;
  const p = create();
  if (c.kind === "tool") return p.tools.some((t) => t.name === c.name);
  if (c.kind === "prompt") return (p.prompts ?? []).some((x) => x.name === c.name);
  return (p.resources ?? []).some((r) => templateMatches(r.uriTemplate, c.uri));
}

export async function ourClient(): Promise<McpCaller> {
  const { createCkanProfile } = (await import("../../src/index.js")) as ProfileModule;
  const core = await import("@ondata-extended/core");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  core.__setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
  const engine = core.createEngine({ configPrefixes: ["CKAN"], configSource: { VITEST: "true" }, cacheOrigin: "https://ckan-mcp-cache.internal" });
  const server = core.createMcpServer({ name: "ckan-mcp-server", version: "0.4.138" });
  core.registerProfiles(server, [createCkanProfile!()], engine);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parity", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return observe(client as never);
}
