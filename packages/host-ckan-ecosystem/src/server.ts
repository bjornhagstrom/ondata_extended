/**
 * The CKAN ecosystem deployment: which profiles, which config prefixes, which name.
 * Shared by the stdio, Node HTTP and Workers entries.
 */

import { createEngine, createMcpServer, registerProfiles, type ConfigSource, type Engine, type McpServer } from "@ondata-extended/core";
import { createEcosystemProfile, PROFILE_VERSION } from "@ondata-extended/profile-ckan-ecosystem";

export const SERVER_NAME = "ckan-ecosystem-mcp-server";
export const SERVER_VERSION = PROFILE_VERSION;
/** ECOSYSTEM_* first; ENGINE_* as a deployment-neutral alias. */
export const CONFIG_PREFIXES = ["ECOSYSTEM", "ENGINE"];

export const profile = createEcosystemProfile();

export function createEcosystemEngine(source?: ConfigSource): Engine {
  return createEngine({ configPrefixes: CONFIG_PREFIXES, configSource: source, cacheOrigin: "https://ckan-ecosystem-mcp-cache.internal" });
}

export function buildServer(engine: Engine): McpServer {
  const server = createMcpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerProfiles(server, [profile], engine);
  return server;
}
