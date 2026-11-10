/**
 * Transport: stdio. Derived from ondata/ckan-mcp-server src/transport/stdio.ts (commit 09e8cdc).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Without a label, no status line (a deployment whose original printed none). */
export async function runStdio(server: McpServer, label?: string): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the protocol; status goes to stderr.
  if (label) console.error(`${label} running on stdio`);
}
