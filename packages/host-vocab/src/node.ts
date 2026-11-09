/**
 * Node entry: `TRANSPORT=http` for Streamable HTTP on /mcp, stdio otherwise.
 */

import { runHttp, runStdio } from "@ondata-extended/core/node";
import { buildServer, createVocabEngine, SERVER_NAME } from "./server.js";

const engine = createVocabEngine();

if ((process.env.TRANSPORT || "stdio") === "http") {
  runHttp({ config: engine.config, buildServer: () => buildServer(engine), label: SERVER_NAME }).catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
} else {
  runStdio(buildServer(engine), SERVER_NAME).catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
