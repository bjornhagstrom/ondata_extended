/**
 * Node entry, the `italianparliament-mcp` binary: MCP over stdio, as ondata/italianparliament-mcp
 * src/index.ts at fd46810 (MIT, see NOTICE.md): no status line, and `Fatal: <message>` with exit
 * code 1 when the server cannot start. The original has no HTTP transport on Node; neither has this.
 */

// The stdio module alone: the core's Node index also loads the HTTP transport (express), which this binary has not.
import { runStdio } from "@ondata-extended/core/node/stdio";
import { buildServer, createParliamentEngine } from "./server.js";

async function main(): Promise<void> {
  await runStdio(buildServer(createParliamentEngine()));
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
