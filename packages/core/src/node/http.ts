/**
 * Transport: Streamable HTTP on Node (Express), stateless: a new server per request.
 *
 * Derived from ondata/ckan-mcp-server src/transport/http.ts (commit 09e8cdc). Settings are
 * read through the deployment's config prefixes (HTTP_HOST, HTTP_ALLOWED_HOSTS,
 * HTTP_ALLOWED_ORIGINS); PORT stays unprefixed, as in the original.
 */

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EngineConfig } from "@ondata-extended/profile-contract";
import { readList } from "../config.js";
import { assertHttpAllowlistConfigured, netPolicyFromConfig, warnIfPrivateHostsOverHttp } from "../net/guards.js";

export interface HttpHostOptions {
  config: EngineConfig;
  buildServer: () => McpServer;
  label: string;
  /** Defaults to process.env.PORT, then 3000. */
  port?: number;
}

export async function runHttp(options: HttpHostOptions): Promise<void> {
  const { config } = options;
  // Network-exposed transport: require a domain allowlist unless explicitly opted out.
  assertHttpAllowlistConfigured(config);
  warnIfPrivateHostsOverHttp(netPolicyFromConfig(config));

  const port = options.port ?? parseInt(process.env.PORT || "3000", 10);
  // Loopback by default so the endpoint is not exposed on the LAN.
  const host = config.get("HTTP_HOST") || "127.0.0.1";

  // DNS-rebinding / cross-origin protection: Host and Origin headers must be listed.
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...readList(config, "HTTP_ALLOWED_HOSTS")];
  const allowedOrigins = readList(config, "HTTP_ALLOWED_ORIGINS");

  const app = express();
  app.use(express.json());

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.status(404).json({ error: "authorization_not_supported", error_description: "This server does not require authentication" });
  });

  app.post("/mcp", async (req, res) => {
    const server = options.buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts,
      ...(allowedOrigins.length > 0 ? { allowedOrigins } : {})
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  await new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      console.error(`${options.label} running on http://${host}:${port}/mcp`);
      resolve();
    });
  });
}
