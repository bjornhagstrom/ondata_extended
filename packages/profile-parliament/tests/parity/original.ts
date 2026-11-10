/**
 * ondata's italianparliament-mcp at fd46810, loaded in-process from a local copy with its
 * dependencies installed, as the reference for the black-box parity check (docs/parliament-port.md).
 * Its upstream calls use the global `fetch` (src/core/client.ts), so both servers can be fed from
 * the same recorded answers. Fresh modules per case (the caller's `vi.resetModules()`) also reset
 * its module state: the Senato throttle chain and the cached current legislature.
 *
 *   PARLIAMENT_REPO=/path/to/italianparliament-mcp   (a git checkout at fd46810, after `npm ci --ignore-scripts`)
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const PARLIAMENT_REPO = process.env.PARLIAMENT_REPO ?? resolve(import.meta.dirname, "../../../../../ondata-italianparliament-mcp/repo");
export const PARLIAMENT_COMMIT = "fd4681037c6fb0b7fe8369502d3e9ee03fd30e60";

/** True when the copy is present. Throws when it is present but on another commit: never a silent wrong reference. */
export function originalAvailable(): boolean {
  if (!existsSync(`${PARLIAMENT_REPO}/src/server.ts`) || !existsSync(`${PARLIAMENT_REPO}/node_modules/@modelcontextprotocol/sdk`)) return false;
  const head = execFileSync("git", ["-C", PARLIAMENT_REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== PARLIAMENT_COMMIT) {
    throw new Error(`parity reference ${PARLIAMENT_REPO} is at ${head}, expected ${PARLIAMENT_COMMIT}`);
  }
  return true;
}

/** Everything a client can observe of one call, compared as a whole. */
export interface Observed {
  text: string;
  isError: boolean;
  /** `structuredContent`, or null. */
  extra: unknown;
}

export interface McpCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<Observed>;
  /** tools/list as a client sees it, by name. */
  listTools(): Promise<Record<string, unknown>>;
}

type AnyClient = {
  callTool(req: unknown): Promise<{ content: { text?: string }[]; isError?: boolean; structuredContent?: unknown }>;
  listTools(): Promise<{ tools: { name: string }[] }>;
};

export function observe(client: AnyClient): McpCaller {
  return {
    async callTool(name, args) {
      const r = await client.callTool({ name, arguments: args });
      return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: r.isError === true, extra: r.structuredContent ?? null };
    },
    async listTools() {
      const r = await client.listTools();
      return Object.fromEntries(r.tools.map((t) => [t.name, t]));
    }
  };
}

/** The original server behind an in-memory MCP client from its own SDK copy. */
export async function originalClient(): Promise<McpCaller> {
  const { createServer, registerAll } = await import(`${PARLIAMENT_REPO}/src/server.ts`);
  const { Client } = await import(`${PARLIAMENT_REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
  const { InMemoryTransport } = await import(`${PARLIAMENT_REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js`);
  const server = createServer();
  registerAll(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parity", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return observe(client);
}
