/**
 * The parliament deployment: the parliament profile under the original's name, with core settings
 * under `PARLIAMENT_*` (the original reads no environment variables). Shared by the stdio and
 * Workers entries.
 */

import { createEngine, createMcpServer, registerProfiles, type ConfigSource, type Engine, type McpServer } from "@ondata-extended/core";
import { createParliamentProfile } from "@ondata-extended/profile-parliament";

export const profile = createParliamentProfile();

/**
 * The original's server name; our own version (docs/DECISIONS.md: one semver for the platform, as D13
 * for CKAN). The behaviour reproduced is ondata/italianparliament-mcp 0.38.0 (commit fd46810).
 */
export const SERVER_NAME = "italianparliament-mcp";
export const SERVER_VERSION = profile.version;
export const CONFIG_PREFIXES = ["PARLIAMENT"];

export function createParliamentEngine(source?: ConfigSource): Engine {
  return createEngine({ configPrefixes: CONFIG_PREFIXES, configSource: source, cacheOrigin: "https://parliament-mcp-cache.internal" });
}

export function buildServer(engine: Engine): McpServer {
  const server = createMcpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerProfiles(server, [profile], engine);
  return server;
}
