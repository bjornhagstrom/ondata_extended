/**
 * Configuration with per-deployment prefixes.
 *
 * A setting has an unprefixed name ("ALLOWED_DOMAINS"). The host decides which prefixes are
 * read and in which order, so a deployment can keep the variable names its users already
 * have (an alias) while a new one gets its own namespace. The first prefix is the primary
 * name, used in messages. The core never names a prefix itself.
 *
 * Replaces the direct `process.env.<NAME>` reads spread over ondata/ckan-mcp-server's
 * src/utils/{http,cache,rate-limiter}.ts and src/transport/http.ts.
 */

import type { EngineConfig } from "@ondata-extended/profile-contract";

export type ConfigSource = Record<string, string | undefined>;

export function createConfig(source: ConfigSource, prefixes: string[]): EngineConfig {
  if (prefixes.length === 0) throw new Error("createConfig needs at least one prefix");
  for (const p of prefixes) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(p)) throw new Error(`Invalid config prefix "${p}"`);
  }
  return {
    get(name: string): string | undefined {
      for (const prefix of prefixes) {
        const value = source[`${prefix}_${name}`];
        if (value !== undefined && value !== "") return value;
      }
      return undefined;
    },
    nameOf(name: string): string {
      return `${prefixes[0]}_${name}`;
    }
  };
}

/** The process environment on Node, an empty source elsewhere. */
export function processEnv(): ConfigSource {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/** Comma-separated list, trimmed, empty entries dropped. */
export function readList(config: EngineConfig, name: string): string[] {
  return (config.get(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function readNumber(config: EngineConfig, name: string, fallback: number): number {
  const n = Number(config.get(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** On unless the setting is "false"; off by default under Vitest so tests stay deterministic. */
export function readEnabled(config: EngineConfig, name: string, source: ConfigSource = processEnv()): boolean {
  const raw = config.get(name);
  if (raw !== undefined) return raw !== "false";
  return source.VITEST !== "true";
}
