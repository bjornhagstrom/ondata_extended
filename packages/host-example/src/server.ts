/**
 * The deployment: which profiles, which config prefixes, which name. Shared by the stdio binary
 * and the Worker. A deployment of one profile is this file and two entry points.
 */

import { createEngine, createMcpServer, registerProfiles, type ConfigSource, type Engine, type McpServer } from "@ondata-extended/core";
import { createExampleProfile, PROFILE_VERSION } from "@ondata-extended/profile-example";

export const SERVER_NAME = "akn-example-mcp-server";
export const SERVER_VERSION = PROFILE_VERSION;
/** AKN_* first (AKN_GITHUB_TOKEN, AKN_TIMEOUT_MS, ...); ENGINE_* as a deployment-neutral alias. */
export const CONFIG_PREFIXES = ["AKN", "ENGINE"];

export const profile = createExampleProfile();

export function createExampleEngine(source?: ConfigSource): Engine {
  return createEngine({ configPrefixes: CONFIG_PREFIXES, configSource: source, cacheOrigin: "https://akn-example-cache.internal" });
}

export function buildServer(engine: Engine): McpServer {
  const server = createMcpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerProfiles(server, [profile], engine);
  return server;
}
