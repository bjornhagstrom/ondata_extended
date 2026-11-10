/**
 * Our parliament profile behind an in-memory MCP client, on an engine configured as in the tests
 * (no settings; cache and rate limit off under Vitest), with DNS stubbed to a public address
 * because the replayed exchanges stand in for the network. Everything is imported inside
 * `ourClient`, after the caller's `vi.resetModules()`, so a case gets fresh module state (the
 * cached current legislature) as the original does.
 */

import { observe, type McpCaller } from "./original.js";

export async function ourClient(): Promise<McpCaller> {
  const { createParliamentProfile } = await import("../../src/index.js");
  const core = await import("@ondata-extended/core");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  core.__setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
  const engine = core.createEngine({ configPrefixes: ["PARLIAMENT"], configSource: { VITEST: "true" }, cacheOrigin: "https://parliament-mcp-cache.internal" });
  const server = core.createMcpServer({ name: "italianparliament-mcp", version: "0.38.0" });
  core.registerProfiles(server, [createParliamentProfile()], engine);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parity", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return observe(client as never);
}
