/**
 * The vocabulary deployment: which profiles, which config prefixes, which name.
 * Shared by the stdio, Node HTTP and Workers entries.
 */

import { createEngine, createMcpServer, registerProfiles, type ConfigSource, type Engine, type McpServer } from "@ondata-extended/core";
import { createSkosProfile, PROFILE_VERSION } from "@ondata-extended/profile-skos";

export const SERVER_NAME = "vocab-mcp-server";
export const SERVER_VERSION = PROFILE_VERSION;
/** VOCAB_* first; ENGINE_* as a deployment-neutral alias. */
export const CONFIG_PREFIXES = ["VOCAB", "ENGINE"];

export const profile = createSkosProfile();

export function createVocabEngine(source?: ConfigSource): Engine {
  return createEngine({ configPrefixes: CONFIG_PREFIXES, configSource: source, cacheOrigin: "https://vocab-mcp-cache.internal" });
}

export function buildServer(engine: Engine): McpServer {
  const server = createMcpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerProfiles(server, [profile], engine);
  return server;
}
