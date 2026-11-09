// Bundle probe: the smallest Worker built from the core and the SKOS profile. Built by
// scripts/check-worker-bundle.mjs with esbuild's browser platform, as ondata's build:worker.
import { createEngine, createMcpServer, createWorkerHandler, registerProfiles, pickTelemetryFields } from "@ondata-extended/core";
import { createSkosProfile } from "@ondata-extended/profile-skos";
import { createParliamentSpikeProfile } from "@ondata-extended/spike-parliament";

type Env = Record<string, string | undefined>;
const profile = createSkosProfile();

let engine: ReturnType<typeof createEngine> | undefined; // one per isolate (see host-vocab/src/worker.ts)

export default createWorkerHandler<Env>({
  buildServer(env) {
    engine ??= createEngine({ configPrefixes: ["APP"], configSource: env, cacheOrigin: "https://probe-cache.internal" });
    const server = createMcpServer({ name: "probe", version: "0.0.0" });
    registerProfiles(server, [profile, createParliamentSpikeProfile()], engine);
    return server;
  },
  health: () => ({ status: "ok" }),
  logEntry: (tool, args) => pickTelemetryFields(tool, args, profile.telemetryFields)
});
