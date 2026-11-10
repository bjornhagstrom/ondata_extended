// Bundle probe: the smallest Worker built from the core and every profile (SKOS, CKAN, parliament). Built by
// scripts/check-worker-bundle.mjs with esbuild's browser platform, as ondata's build:worker.
import { createEngine, createMcpServer, createWorkerHandler, registerProfiles, pickTelemetryFields } from "@ondata-extended/core";
import { createSkosProfile } from "@ondata-extended/profile-skos";
import { createParliamentProfile } from "@ondata-extended/profile-parliament";
import { createCkanProfile } from "@ondata-extended/profile-ckan";

type Env = Record<string, string | undefined>;
const profile = createSkosProfile();

let engine: ReturnType<typeof createEngine> | undefined; // one per isolate (see host-vocab/src/worker.ts)

export default createWorkerHandler<Env>({
  buildServer(env) {
    engine ??= createEngine({ configPrefixes: ["APP"], configSource: env, cacheOrigin: "https://probe-cache.internal" });
    const server = createMcpServer({ name: "probe", version: "0.0.0" });
    registerProfiles(server, [profile, createParliamentProfile(), createCkanProfile()], engine);
    return server;
  },
  health: () => ({ status: "ok" }),
  logEntry: (tool, args) => pickTelemetryFields(tool, args, profile.telemetryFields)
});
