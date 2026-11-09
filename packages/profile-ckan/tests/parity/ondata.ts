/**
 * ondata/ckan-mcp-server at 09e8cdc, loaded in-process from a local clone, as the reference for
 * the black-box parity check (docs/test-parity.md, principle 3).
 *
 * Its HTTP layer takes the axios path on Node and the fetch path elsewhere, deciding per call
 * from `process.versions.node` (src/utils/http.ts:933-935). `withOndataFetchPath` hides that
 * value for the duration of a call, so ondata uses its fetch path, the one its hosted Worker
 * runs, and both servers can be fed from the same recorded `fetch` answers. Side effect: ondata's
 * stderr audit log (http.ts:893) is off during the call; it writes nothing to tool output.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const ONDATA_REPO = process.env.ONDATA_REPO ?? resolve(import.meta.dirname, "../../../../../ondata-ckan-mcp-server/repo");
export const ONDATA_COMMIT = "09e8cdc28ea5e36b5bf496deddb9f25e7dbba591";

/** True when the clone is present. Throws when it is present but on another commit: never a silent wrong reference. */
export function ondataAvailable(): boolean {
  if (!existsSync(`${ONDATA_REPO}/src/server.ts`) || !existsSync(`${ONDATA_REPO}/node_modules/@modelcontextprotocol/sdk`)) return false;
  const head = execFileSync("git", ["-C", ONDATA_REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== ONDATA_COMMIT) {
    throw new Error(`parity reference clone ${ONDATA_REPO} is at ${head}, expected ${ONDATA_COMMIT}`);
  }
  return true;
}

/** Everything a client can observe of one call, compared as a whole. */
export interface Observed {
  text: string;
  isError: boolean;
  /** Tools: `structuredContent`; resources: `mimeType` per content; prompts: `role` per message. */
  extra: unknown;
}

export interface McpCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<Observed>;
  readResource(uri: string): Promise<Observed>;
  getPrompt(name: string, args: Record<string, string>): Promise<Observed>;
}

type AnyClient = {
  callTool(req: unknown): Promise<{ content: { text?: string }[]; isError?: boolean; structuredContent?: unknown }>;
  readResource(req: unknown): Promise<{ contents: { text?: string; mimeType?: string; uri?: string }[] }>;
  getPrompt(req: unknown): Promise<{ messages: { role: string; content: { text?: string } }[] }>;
};

/** One observation shape for both servers' clients. */
export function observe(client: AnyClient): McpCaller {
  return {
    async callTool(name, args) {
      const r = await client.callTool({ name, arguments: args });
      return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: r.isError === true, extra: r.structuredContent ?? null };
    },
    async readResource(uri) {
      const r = await client.readResource({ uri });
      return { text: r.contents.map((c) => c.text ?? "").join("\n"), isError: false, extra: r.contents.map((c) => ({ uri: c.uri, mimeType: c.mimeType ?? null })) };
    },
    async getPrompt(name, args) {
      const r = await client.getPrompt({ name, arguments: args });
      return { text: r.messages.map((m) => m.content.text ?? "").join("\n"), isError: false, extra: r.messages.map((m) => m.role) };
    }
  };
}

/** Run `fn` with ondata on its fetch path. Never run two of these concurrently. */
export async function withOndataFetchPath<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.versions, "node")!;
  Object.defineProperty(process.versions, "node", { value: undefined, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process.versions, "node", original);
  }
}

/** ondata's server behind an in-memory MCP client from its own SDK copy. */
export async function ondataClient(): Promise<McpCaller & { setDnsResolver(fn: unknown): void; resetState(): void }> {
  const { createServer, registerAll } = await import(`${ONDATA_REPO}/src/server.ts`);
  const http = await import(`${ONDATA_REPO}/src/utils/http.ts`);
  const scheming = await import(`${ONDATA_REPO}/src/utils/scheming.ts`);
  const { Client } = await import(`${ONDATA_REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
  const { InMemoryTransport } = await import(`${ONDATA_REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js`);
  const server = createServer();
  registerAll(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parity", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const caller = observe(client);
  return {
    setDnsResolver: (fn) => http.__setDnsResolverForTests(fn),
    // Module state that would make a case depend on the cases before it: the remembered
    // "this portal has no scheming schema" (src/utils/scheming.ts:147-152).
    resetState: () => scheming.__resetSchemaCacheForTests(),
    callTool: (name, args) => withOndataFetchPath(() => caller.callTool(name, args)),
    readResource: (uri) => withOndataFetchPath(() => caller.readResource(uri)),
    getPrompt: (name, args) => withOndataFetchPath(() => caller.getPrompt(name, args))
  };
}
