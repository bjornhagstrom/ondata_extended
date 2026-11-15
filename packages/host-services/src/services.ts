/**
 * The services of this Worker, each with its own engine (config prefix, allowed hosts, cache, rate limit) and its own
 * MCP server, so nothing one service does reaches the other. No `ENGINE_*` alias: a setting names one service.
 */

import { createConfig, createEngine, createMcpServer, pickTelemetryFields, registerProfiles, type ConfigSource, type Engine, type McpServer, type WorkerService, type AnalyticsEngineDataset } from "@ondata-extended/core";
import { createEcosystemProfile, PROFILE_VERSION as ECOSYSTEM_VERSION } from "@ondata-extended/profile-ckan-ecosystem";
import { createSkosProfile, PROFILE_VERSION as VOCAB_VERSION } from "@ondata-extended/profile-skos";
import type { Profile } from "@ondata-extended/profile-contract";

export type Env = ConfigSource & { ANALYTICS?: AnalyticsEngineDataset };

interface ServiceSetup {
  id: string;
  name: string;
  version: string;
  profile: Profile;
  configPrefix: string;
  /** The first argument logged after the tool name, for the Analytics data point. */
  keyArgs: readonly string[];
}

export const VOCAB: ServiceSetup = {
  id: "vocab", name: "vocab-mcp-server", version: VOCAB_VERSION, profile: createSkosProfile(), configPrefix: "VOCAB",
  keyArgs: ["query", "prefix", "id"]
};
export const ECOSYSTEM: ServiceSetup = {
  id: "ecosystem", name: "ckan-ecosystem-mcp-server", version: ECOSYSTEM_VERSION, profile: createEcosystemProfile(), configPrefix: "ECOSYSTEM",
  keyArgs: ["query", "extension", "plugin"]
};

export function createServiceEngine(setup: ServiceSetup, source?: ConfigSource): Engine {
  return createEngine({ configPrefixes: [setup.configPrefix], configSource: source, cacheOrigin: `https://${setup.id}-service-cache.internal` });
}

export function buildServiceServer(setup: ServiceSetup, engine: Engine): McpServer {
  const server = createMcpServer({ name: setup.name, version: setup.version });
  registerProfiles(server, [setup.profile], engine);
  return server;
}

/** The private path of the vocabulary service, from the secret SERVICES_VOCAB_PATH. */
export const vocabSecretPath = (env: Env) => createConfig(env, ["SERVICES"]).get("VOCAB_PATH");

/**
 * A service of the Worker. The engine is built once per isolate, not per request: it holds the cache, the rate
 * limiter and the per-host throttle, which must span requests. `env` is the same for every request of a Worker
 * version, so building from the first one is safe.
 */
export function workerService(setup: ServiceSetup, where: { path: string } | { secretPath: (env: Env) => string | undefined }): WorkerService<Env> {
  let engine: Engine | undefined;
  const { profile } = setup;
  return {
    id: setup.id,
    ...where,
    buildServer: (env) => buildServiceServer(setup, (engine ??= createServiceEngine(setup, env))),
    health: () => ({
      status: "ok", name: setup.name, version: setup.version, tools: profile.tools.length,
      resources: profile.resources?.length ?? 0, prompts: profile.prompts?.length ?? 0, runtime: "cloudflare-workers"
    }),
    logEntry: (tool, args) => ({ service: setup.id, ...pickTelemetryFields(tool, args, profile.telemetryFields) }),
    analytics: (env) => env.ANALYTICS,
    dataPoint: (entry) => ({
      blobs: [setup.id, String(entry.tool ?? ""), String(setup.keyArgs.map((k) => entry[k]).find((v) => v !== undefined) ?? ""), String(entry.status ?? "")],
      doubles: [Number(entry.duration_ms ?? 0), entry.cache_hit ? 1 : 0],
      indexes: [`${setup.id}:${String(entry.tool ?? "")}`]
    })
  };
}

export const SERVICES = [
  workerService(ECOSYSTEM, { path: "ecosystem" }),
  workerService(VOCAB, { secretPath: vocabSecretPath })
];

/** What the landing page says about a public service. */
export const PUBLIC_SETUPS: Record<string, ServiceSetup> = { ecosystem: ECOSYSTEM };
