/**
 * Node entry, the `ckan-mcp-server` binary: `TRANSPORT=http` for Streamable HTTP on /mcp, stdio
 * otherwise. As ondata/ckan-mcp-server src/index.ts at 09e8cdc, including the status lines.
 */

import { runHttp, runStdio } from "@ondata-extended/core/node";
import { buildServer, createCkanEngine } from "./server.js";

const LABEL = "CKAN MCP server";
const engine = createCkanEngine();

const transport = process.env.TRANSPORT || "stdio";
if (transport === "http") {
  runHttp({ config: engine.config, buildServer: () => buildServer(engine), label: LABEL }).catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
} else {
  runStdio(buildServer(engine), LABEL).catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
