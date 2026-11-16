/**
 * The services of this Worker, each with its own engine (config prefix, allowed hosts, cache, rate limit) and its own
 * MCP server, so nothing one service does reaches the other. No `ENGINE_*` alias: a setting names one service.
 */

import { createConfig, createEngine, createMcpServer, pickTelemetryFields, registerProfiles, serverInstructions, type ConfigSource, type Engine, type McpServer, type WorkerService, type AnalyticsEngineDataset } from "@ondata-extended/core";
import { createEcosystemProfile, PROFILE_VERSION as ECOSYSTEM_VERSION } from "@ondata-extended/profile-ckan-ecosystem";
import { createSkosProfile, PROFILE_VERSION as VOCAB_VERSION } from "@ondata-extended/profile-skos";
import type { InstanceEntry, Profile } from "@ondata-extended/profile-contract";
import type { VocabExt } from "@ondata-extended/profile-skos";

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

/** The Svada vocabulary, the vocabulary service's only known one (as in packages/host-vocab). */
const SVADA: InstanceEntry<VocabExt>[] = [{
  id: "svada", baseUrl: "https://begrepp.hagstrom.nu/",
  ext: { adapter: "tematres", defaultLang: "sv", title: "Svada - termer och begrepp", conceptUriBase: "https://begrepp.hagstrom.nu/skos/" }
}];

/**
 * A few of the vocabularies published on vocabularyserver.com, the TemaTres maintainer's own server, known by id; the
 * first is the default. Any other vocabulary there is reachable by its base URL (the allow-list is the host). The
 * concept URI base is TemaTres's default form, as these vocabularies' search answers write it; giving it saves a
 * request for the SKOS export, which that server puts behind a Cloudflare challenge.
 */
export const VOCABULARYSERVER: InstanceEntry<VocabExt>[] = [
  { id: "unesco", baseUrl: "https://vocabularyserver.com/unesco/en/", ext: { adapter: "tematres", conceptUriBase: "https://vocabularyserver.com/unesco/en/xml.php?schema=skos&term_id=", defaultLang: "en", title: "UNESCO Thesaurus (English)" } },
  { id: "unesco-es", baseUrl: "https://vocabularyserver.com/unesco/es/", ext: { adapter: "tematres", conceptUriBase: "https://vocabularyserver.com/unesco/es/xml.php?schema=skos&term_id=", defaultLang: "es", title: "UNESCO Thesaurus (Spanish)" } },
  { id: "unesco-fr", baseUrl: "https://vocabularyserver.com/unesco/fr/", ext: { adapter: "tematres", conceptUriBase: "https://vocabularyserver.com/unesco/fr/xml.php?schema=skos&term_id=", defaultLang: "fr", title: "UNESCO Thesaurus (French)" } },
  { id: "iso25964", baseUrl: "https://vocabularyserver.com/glossaries/iso25964/", ext: { adapter: "tematres", conceptUriBase: "https://vocabularyserver.com/glossaries/iso25964/xml.php?schema=skos&term_id=", defaultLang: "en", title: "ISO 25964-1 glossary: thesauri for information retrieval" } },
  { id: "z3919", baseUrl: "https://vocabularyserver.com/glossaries/z3919/", ext: { adapter: "tematres", conceptUriBase: "https://vocabularyserver.com/glossaries/z3919/xml.php?schema=skos&term_id=", defaultLang: "en", title: "ANSI/NISO Z39.19 glossary: monolingual controlled vocabularies" } }
];

/**
 * A lexicon on the TemaTres server of the Faculty of Philosophy and Letters, University of Buenos Aires
 * (terminologias.filo.uba.ar), which the maintainer pointed to in tematres/TemaTres-Vocabulary-Server#137: the
 * lexicon his text annotator uses for the tango "Cambalache". Read live and quoted, never copied; its rights field is
 * empty. The server asked for no limit; it gets at most two requests a second from each running copy (UBA_HOST_POLICY).
 * The allow-list is the host, so its other TemaTres vocabularies are reachable by address too, under the same limit.
 */
export const UBA_LEXICONS: InstanceEntry<VocabExt>[] = [
  { id: "lunfardo", baseUrl: "https://terminologias.filo.uba.ar/apps/dicrodriguez/", ext: { adapter: "tematres", conceptUriBase: "https://terminologias.filo.uba.ar/apps/dicrodriguez/xml.php?schema=skos&term_id=", defaultLang: "es", title: "Lexicón de 12.500 voces y locuciones lunfardas, populares, jergales y extranjeras (Adolfo Enrique Rodríguez, 1989)" } }
];
export const UBA_HOST_POLICY = { "terminologias.filo.uba.ar": { minIntervalMs: 500, maxQueueMs: 10_000 } } as const;

export const VOCAB: ServiceSetup = {
  id: "vocab", name: "vocab-mcp-server", version: VOCAB_VERSION, profile: createSkosProfile({
    vocabularies: SVADA,
    // The same sentence as packages/host-vocab/src/vocabularies.ts (INSTRUCTIONS); keep them alike.
    instructions: "Svada is a Swedish vocabulary of terms and concepts for the SVADA project. In work on SVADA, check terms " +
      "against it and use its preferred terms."
  }), configPrefix: "VOCAB",
  keyArgs: ["query", "prefix", "id"]
};
export const TEMATRES: ServiceSetup = {
  id: "tematres", name: "tematres-vocabularyserver-mcp-server", version: VOCAB_VERSION, profile: createSkosProfile({
    vocabularies: [...VOCABULARYSERVER, ...UBA_LEXICONS],
    instructions: "These vocabularies are published with TemaTres: most on vocabularyserver.com, the server of TemaTres's " +
      "maintainer, and the lunfardo lexicon on terminologias.filo.uba.ar (University of Buenos Aires).",
    hostPolicies: UBA_HOST_POLICY
  }),
  configPrefix: "TEMATRES", keyArgs: ["query", "prefix", "id"]
};
export const ECOSYSTEM: ServiceSetup = {
  id: "ecosystem", name: "ckan-ecosystem-mcp-server", version: ECOSYSTEM_VERSION, profile: createEcosystemProfile(), configPrefix: "ECOSYSTEM",
  keyArgs: ["query", "extension", "plugin"]
};

export function createServiceEngine(setup: ServiceSetup, source?: ConfigSource): Engine {
  return createEngine({ configPrefixes: [setup.configPrefix], configSource: source, cacheOrigin: `https://${setup.id}-service-cache.internal` });
}

export function buildServiceServer(setup: ServiceSetup, engine: Engine): McpServer {
  const server = createMcpServer({ name: setup.name, version: setup.version, instructions: serverInstructions([setup.profile]) });
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
  workerService(VOCAB, { secretPath: vocabSecretPath }),
  // Public since the issue to TemaTres's maintainer (docs/DECISIONS.md); private at a secret path before that.
  workerService(TEMATRES, { path: "tematres" })
];

/** What the landing page says about a public service. */
export const PUBLIC_SETUPS: Record<string, ServiceSetup> = { ecosystem: ECOSYSTEM, tematres: TEMATRES };
