/**
 * The CKAN deployment: the CKAN profile under ondata's name, with `CKAN_*` settings.
 * Shared by the stdio, Node HTTP and Workers entries.
 */

import { createEngine, createMcpServer, registerProfiles, type ConfigSource, type Engine, type McpServer } from "@ondata-extended/core";
import { createCkanProfile } from "@ondata-extended/profile-ckan";

import { PROFILE_VERSION } from "@ondata-extended/profile-ckan";

/**
 * ondata's server name; our own version (docs/DECISIONS.md: one semver for the platform). The
 * behaviour reproduced is ondata/ckan-mcp-server 0.4.138 (commit 09e8cdc), stated in README and DECISIONS.
 */
export const SERVER_NAME = "ckan-mcp-server";
export const SERVER_VERSION = PROFILE_VERSION;
/** ondata's names, `CKAN_*`, unchanged. */
export const CONFIG_PREFIXES = ["CKAN"];

export const profile = createCkanProfile();

export function createCkanEngine(source?: ConfigSource): Engine {
  return createEngine({ configPrefixes: CONFIG_PREFIXES, configSource: source, cacheOrigin: "https://ckan-mcp-cache.internal" });
}

export function buildServer(engine: Engine): McpServer {
  const server = createMcpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerProfiles(server, [profile], engine);
  return server;
}
