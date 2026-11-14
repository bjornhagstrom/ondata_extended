/**
 * The vocab_ tool surface is frozen (docs/DECISIONS.md, 2026-11-14): tool names, argument names,
 * types, enums, ranges, defaults, which arguments are required, and the annotation hints. A change here
 * breaks clients of the production service and needs a decision and migration help, then a
 * deliberate update of tests/frozen-tools.json:
 *
 *   VOCAB_FREEZE_UPDATE=1 npx vitest run packages/profile-skos/tests/frozen-tools.test.ts
 *
 * Model-facing text (tool and annotation titles, tool and argument descriptions) is not frozen:
 * it may be improved.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEngine, createMcpServer, registerProfiles } from "@ondata-extended/core";
import { createSkosProfile } from "../src/index.js";

const FROZEN = join(import.meta.dirname, "frozen-tools.json");

/**
 * The schema without model-facing text, keys sorted, so only the contract remains. Inside
 * `properties` the keys are argument names, so an argument called `title` or `description` is kept.
 */
function contractOf(value: unknown, keysAreNames = false): unknown {
  if (Array.isArray(value)) return value.map((v) => contractOf(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (!keysAreNames && (key === "description" || key === "title")) continue;
      out[key] = contractOf((value as Record<string, unknown>)[key], !keysAreNames && key === "properties");
    }
    return out;
  }
  return value;
}

async function surface() {
  const engine = createEngine({ configPrefixes: ["VOCAB"], configSource: {}, cacheOrigin: "https://t.internal" });
  const server = createMcpServer({ name: "t", version: "0" });
  registerProfiles(server, [createSkosProfile()], engine);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  const { tools } = await c.listTools();
  return tools
    .map((t) => ({ name: t.name, inputSchema: contractOf(t.inputSchema), annotations: contractOf(t.annotations ?? {}) }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

describe("frozen vocab_ tool surface", () => {
  it("matches tests/frozen-tools.json", async () => {
    const now = await surface();
    if (process.env.VOCAB_FREEZE_UPDATE === "1") writeFileSync(FROZEN, JSON.stringify(now, null, 2) + "\n");
    expect(existsSync(FROZEN), "tests/frozen-tools.json is missing; create it with VOCAB_FREEZE_UPDATE=1").toBe(true);
    expect(now).toEqual(JSON.parse(readFileSync(FROZEN, "utf8")));
  });
});
