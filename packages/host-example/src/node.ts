/**
 * stdio binary: `akn-example-mcp-server`, for Claude Desktop and other local clients.
 */

import { runStdio } from "@ondata-extended/core/node/stdio";
import { buildServer, createExampleEngine, SERVER_NAME } from "./server.js";

runStdio(buildServer(createExampleEngine()), SERVER_NAME).catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
