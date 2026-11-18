/**
 * The several-service Worker: three services from two real profiles (CKAN ecosystem and the TemaTres demo, public;
 * SKOS vocabulary Svada, private) in one Worker, kept apart by path and by engine. The network is replaced by answers recorded from begrepp.hagstrom.nu (the SKOS
 * profile's fixtures); every request still passes the core's guards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { __setDnsResolverForTests } from "@ondata-extended/core";
import en from "../src/i18n/en.json";
import sv from "../src/i18n/sv.json";
import { ECOSYSTEM, TEMATRES, VOCAB } from "../src/services.js";

const FIX = join(import.meta.dirname, "..", "..", "profile-skos", "tests", "fixtures", "tematres");
const recorded = new Map<string, { body: string; contentType: string }>();
for (const f of readdirSync(FIX).filter((n) => n.endsWith(".meta.json"))) {
  const meta = JSON.parse(readFileSync(join(FIX, f), "utf8")) as { url: string; contentType: string };
  recorded.set(meta.url, { body: readFileSync(join(FIX, f.replace(".meta.json", ".body")), "utf8"), contentType: meta.contentType });
}

// One answer recorded live from the lunfardo lexicon (TemaTres 4.0, web service 2.2), 2026-11-16.
recorded.set("https://terminologias.filo.uba.ar/apps/dicrodriguez/services.php?task=search&arg=chorro&output=json", {
  body: readFileSync(join(import.meta.dirname, "fixtures", "lunfardo-search-chorro.json"), "utf8"), contentType: "application/json"
});

// One answer recorded live from the project's own test instance (TemaTres 4.0, web service 2.2), 2026-11-17.
recorded.set("https://vocab.hagstrom.nu/unesco/services.php?task=search&arg=universal&output=json", {
  body: readFileSync(join(import.meta.dirname, "fixtures", "unesco-test-search-universal.json"), "utf8"), contentType: "application/json"
});

// The test instance's snapshot: 17 lines of its UNESCO dump (the SKOS profile's fixture), served where the dump lives.
const UNESCO_DUMP = "https://vocab.hagstrom.nu/dumps/unesco.ndjson";
const unescoDump = { body: readFileSync(join(import.meta.dirname, "..", "..", "profile-skos", "tests", "fixtures", "snapshot", "unesco-sample.ndjson"), "utf8"), contentType: "application/x-ndjson" };
recorded.set(UNESCO_DUMP, unescoDump);

const SVADA_DUMP = "https://begrepp.hagstrom.nu/dumps/svada.ndjson";
const SVADA_SCHEME = "https://begrepp.hagstrom.nu/services.php?task=fetchVocabularyData&output=json";
const isScheme = (u: string) => u.includes("task=fetchVocabularyData");
/** Requests for the answer itself, in order; the source line's scheme read (once an hour) is counted apart. */
const answerRequests = () => requested.filter((u) => !isScheme(u));
const schemeRequests = () => requested.filter(isScheme);

const SECRET = "k3P_9xQ-vR7tW2yZ5bN8mL4hJ6gF1dSa0cE"; // 35 characters
const ENV = { VOCAB_ALLOWED_DOMAINS: "begrepp.hagstrom.nu", ECOSYSTEM_ALLOWED_DOMAINS: "raw.githubusercontent.com", SERVICES_VOCAB_PATH: SECRET,
  TEMATRES_ALLOWED_DOMAINS: "vocabularyserver.com,terminologias.filo.uba.ar,vocab.hagstrom.nu",
  VOCAB_RATE_LIMIT_ENABLED: "false", ECOSYSTEM_RATE_LIMIT_ENABLED: "false", TEMATRES_RATE_LIMIT_ENABLED: "false" };

let requested: string[] = [];
let startedAt: { url: string; at: number }[] = [];
beforeEach(() => {
  requested = [];
  startedAt = [];
  __setDnsResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requested.push(url);
    startedAt.push({ url, at: Date.now() });
    const hit = recorded.get(url);
    if (!hit) return new Response(`no fixture for ${url}`, { status: 599 });
    return new Response(hit.body, { status: 200, headers: { "content-type": hit.contentType } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __setDnsResolverForTests(null);
});

/** A fresh Worker module, so each test gets new engines (the engines live per isolate). */
const worker = async () => { vi.resetModules(); return (await import("../src/worker.js")).default as { fetch(r: Request, env: Record<string, string>): Promise<Response> }; };
const post = (path: string, body: unknown) => new Request(`https://s.example${path}`, {
  method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body)
});
const call = async (w: Awaited<ReturnType<typeof worker>>, path: string, name: string, args: Record<string, unknown>) => {
  const body = await (await w.fetch(post(path, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), ENV)).json() as
    { result: { isError?: boolean; content: { text: string }[] } };
  return { text: body.result.content[0].text, isError: body.result.isError === true };
};
const tools = async (w: Awaited<ReturnType<typeof worker>>, path: string) =>
  ((await (await w.fetch(post(path, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), ENV)).json()) as { result: { tools: { name: string }[] } })
    .result.tools.map((t) => t.name).sort();

describe("two profiles in one Worker", () => {
  it("each path lists only its own service's tools", async () => {
    const w = await worker();
    expect(await tools(w, "/ecosystem/mcp")).toEqual(ECOSYSTEM.profile.tools.map((t) => t.name).sort());
    expect(await tools(w, `/${SECRET}/mcp`)).toEqual(VOCAB.profile.tools.map((t) => t.name).sort());
    for (const name of await tools(w, "/ecosystem/mcp")) expect(name.startsWith("ecosystem_")).toBe(true);
    for (const name of await tools(w, `/${SECRET}/mcp`)) expect(name.startsWith("vocab_")).toBe(true);
  });

  it("both services answer in the same isolate: a vocabulary search over the network, an extension search from the index", async () => {
    const w = await worker();
    const vocab = await call(w, `/${SECRET}/mcp`, "vocab_search_concepts", { query: "data" });
    expect(vocab.isError).toBe(false);
    // Svada's snapshot has no recording here, so the search goes to the live service after asking for it; the source
    // line reads the scheme alongside, counted apart.
    expect(answerRequests()).toEqual([SVADA_DUMP, "https://begrepp.hagstrom.nu/services.php?task=search&arg=data&output=json"]);
    expect(schemeRequests()).toEqual([SVADA_SCHEME]);
    const eco = await call(w, "/ecosystem/mcp", "ecosystem_search_extensions", { query: "harvest dcat", limit: 3 });
    expect(eco.text).toContain("ckan/ckanext-dcat");
    expect(requested).toHaveLength(3); // the ecosystem search made no request
  });

  it("answers Svada from its snapshot on begrepp.hagstrom.nu when there is one", async () => {
    recorded.set(SVADA_DUMP, { body: JSON.stringify({ uri: "https://begrepp.hagstrom.nu/skos/77", prefLabel: { sv: "Dataförmedlare" }, topConceptOf: ["https://begrepp.hagstrom.nu/"] }), contentType: "application/x-ndjson" });
    try {
      const w = await worker();
      const r = await call(w, `/${SECRET}/mcp`, "vocab_search_concepts", { query: "förmedl" });
      expect(r.text).toContain("Dataförmedlare (id `77`)");
      // The answer from the snapshot; only the source line's scheme read goes live.
      expect(answerRequests()).toEqual([SVADA_DUMP]);
      expect(schemeRequests()).toEqual([SVADA_SCHEME]);
    } finally {
      recorded.delete(SVADA_DUMP);
    }
  });

  it("keeps the allowed hosts apart: the vocabulary service may not reach a host only the ecosystem service may", async () => {
    const w = await worker();
    const r = await call(w, `/${SECRET}/mcp`, "vocab_search_concepts", { query: "data", vocab: "https://raw.githubusercontent.com/x/y/" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Domain "raw.githubusercontent.com" is not in the allowed list (VOCAB_ALLOWED_DOMAINS)');
    expect(requested).toEqual([]);
  });

  it("calling one service's tool on the other's path is an unknown tool", async () => {
    const w = await worker();
    const body = await (await w.fetch(post("/ecosystem/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vocab_search_concepts", arguments: { query: "data" } } }), ENV)).text();
    expect(body).toMatch(/not found|unknown/i);
    expect(requested).toEqual([]);
  });
});

describe("the TemaTres demo service", () => {
  it("reads the UNESCO Thesaurus by default and names its known vocabularies in the vocab argument", async () => {
    const w = await worker();
    const list = (await (await w.fetch(post("/tematres/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), ENV)).json()) as
      { result: { tools: { name: string; inputSchema: { properties: Record<string, { description?: string }> } }[] } };
    const desc = list.result.tools.find((t) => t.name === "vocab_search_concepts")!.inputSchema.properties.vocab.description!;
    expect(desc).toContain("'unesco' (UNESCO Thesaurus (English))");
    expect(desc).toContain("'iso25964'");
    expect(desc).not.toContain("svada");
    await call(w, "/tematres/mcp", "vocab_search_concepts", { query: "libraries" });
    expect(requested.length).toBeGreaterThan(0);
    for (const url of requested) expect(url.startsWith("https://vocabularyserver.com/unesco/en/"), url).toBe(true);
  });

  it("names the lunfardo lexicon on terminologias.filo.uba.ar and keeps UNESCO the default", async () => {
    const w = await worker();
    const list = (await (await w.fetch(post("/tematres/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), ENV)).json()) as
      { result: { tools: { name: string; inputSchema: { properties: Record<string, { description?: string }> } }[] } };
    const desc = list.result.tools.find((t) => t.name === "vocab_search_concepts")!.inputSchema.properties.vocab.description!;
    expect(desc).toContain("'lunfardo' (Lexicón de 12.500 voces");
    expect(desc.indexOf("'unesco'")).toBeLessThan(desc.indexOf("'lunfardo'"));
    const found = await call(w, "/tematres/mcp", "vocab_search_concepts", { query: "chorro", vocab: "lunfardo" });
    expect(found.isError).toBe(false);
    expect(found.text).toContain("chorro (id `2753`)");
    expect(found.text).toContain("cachorro (id `2384`)");
    expect(requested.length).toBeGreaterThan(0);
    for (const url of requested) expect(url.startsWith("https://terminologias.filo.uba.ar/apps/dicrodriguez/"), url).toBe(true);
  });

  it("names the UNESCO test copy on vocab.hagstrom.nu after the lexicon, and answers from its snapshot", async () => {
    const w = await worker();
    const list = (await (await w.fetch(post("/tematres/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), ENV)).json()) as
      { result: { tools: { name: string; inputSchema: { properties: Record<string, { description?: string }> } }[] } };
    const desc = list.result.tools.find((t) => t.name === "vocab_search_concepts")!.inputSchema.properties.vocab.description!;
    expect(desc).toContain("'unesco-test' (UNESCO Thesaurus (English), test copy on vocab.hagstrom.nu)");
    expect(desc.indexOf("'lunfardo'")).toBeLessThan(desc.indexOf("'unesco-test'"));
    const found = await call(w, "/tematres/mcp", "vocab_search_concepts", { query: "universal", vocab: "unesco-test" });
    expect(found.isError).toBe(false);
    expect(found.text).toContain("Universal education (id `5`)");
    const asJson = JSON.parse((await call(w, "/tematres/mcp", "vocab_search_concepts", { query: "universal", vocab: "unesco-test", response_format: "json" })).text) as
      { concepts: { id: string; uri: string }[] };
    // The instance's own URI form, as its SKOS export writes it (hasTopConcept .../unesco/skos/1, checked 2026-11-17).
    expect(asJson.concepts.find((c) => c.id === "5")?.uri).toBe("https://vocab.hagstrom.nu/unesco/skos/5");
    // One request for the snapshot and one for the source line's scheme read, none for the second call.
    expect(answerRequests()).toEqual([UNESCO_DUMP]);
    expect(schemeRequests()).toEqual(["https://vocab.hagstrom.nu/unesco/services.php?task=fetchVocabularyData&output=json"]);
  });

  it("reads the UNESCO test copy live, only from its base, while its snapshot cannot be had", async () => {
    recorded.delete(UNESCO_DUMP);
    try {
      const w = await worker();
      const found = await call(w, "/tematres/mcp", "vocab_search_concepts", { query: "universal", vocab: "unesco-test" });
      expect(found.isError).toBe(false);
      expect(found.text).toContain("Universal education (id `5`)");
      expect(found.text).toContain("Internet universality (id `4819`)");
      expect(answerRequests()[0]).toBe(UNESCO_DUMP);
      expect(answerRequests().length).toBeGreaterThan(1);
      for (const url of requested.filter((u) => u !== UNESCO_DUMP)) expect(url.startsWith("https://vocab.hagstrom.nu/unesco/"), url).toBe(true);
    } finally {
      recorded.set(UNESCO_DUMP, unescoDump);
    }
  });

  it("spaces requests to terminologias.filo.uba.ar at least 500 ms apart, and leaves vocabularyserver.com unthrottled", async () => {
    expect(TEMATRES.profile.hostPolicies).toEqual({ "terminologias.filo.uba.ar": { minIntervalMs: 500, maxQueueMs: 30_000 } });
    const w = await worker();
    await Promise.all([
      call(w, "/tematres/mcp", "vocab_search_concepts", { query: "chorro", vocab: "lunfardo" }),
      call(w, "/tematres/mcp", "vocab_search_concepts", { query: "merengue", vocab: "lunfardo" })
    ]);
    const uba = startedAt.filter((s) => s.url.startsWith("https://terminologias.filo.uba.ar/")).map((s) => s.at);
    expect(uba.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < uba.length; i++) expect(uba[i] - uba[i - 1]).toBeGreaterThanOrEqual(450);
    startedAt = [];
    await Promise.all([
      call(w, "/tematres/mcp", "vocab_search_concepts", { query: "libraries" }),
      call(w, "/tematres/mcp", "vocab_search_concepts", { query: "archives" })
    ]);
    const vs = startedAt.filter((s) => s.url.startsWith("https://vocabularyserver.com/")).map((s) => s.at);
    expect(vs.length).toBeGreaterThanOrEqual(2);
    expect(vs[1] - vs[0]).toBeLessThan(300);
  }, 20_000);

  it("is kept apart from the Svada service both ways", async () => {
    const w = await worker();
    const fromVocab = await call(w, `/${SECRET}/mcp`, "vocab_search_concepts", { query: "libraries", vocab: "https://vocabularyserver.com/unesco/en/" });
    expect(fromVocab.text).toContain("not in the allowed list (VOCAB_ALLOWED_DOMAINS)");
    const fromDemo = await call(w, "/tematres/mcp", "vocab_search_concepts", { query: "data", vocab: "https://begrepp.hagstrom.nu/" });
    expect(fromDemo.text).toContain("not in the allowed list (TEMATRES_ALLOWED_DOMAINS)");
    const svadaId = await call(w, "/tematres/mcp", "vocab_search_concepts", { query: "data", vocab: "svada" });
    expect(svadaId.isError).toBe(true);
    expect(requested).toEqual([]);
    // The demo's refused call to Svada's base URL leaves Svada's own source untouched (each service keeps its own
    // memory of sources, pinned in profile-skos's tests; here the whole Worker is checked).
    const svada = JSON.parse((await call(w, `/${SECRET}/mcp`, "vocab_search_concepts", { query: "data", response_format: "json" })).text) as { source: { title: string; creator?: string } };
    expect(svada.source).toMatchObject({ title: "Svada - termer och begrepp", creator: "Testredaktion" });
  });
});

describe("server instructions", () => {
  it("each service sends its own: the demo names UNESCO, the Svada service names Svada, the ecosystem service none", async () => {
    const w = await worker();
    const init = async (path: string) => ((await (await w.fetch(post(path, { jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }), ENV)).json()) as
      { result: { instructions?: string } }).result.instructions;
    const demo = await init("/tematres/mcp");
    expect(demo).toContain("'unesco' (UNESCO Thesaurus (English))");
    expect(demo).toContain("vocabularyserver.com");
    expect(demo).not.toMatch(/svada/i);
    const vocab = await init(`/${SECRET}/mcp`);
    expect(vocab).toContain("'svada'");
    expect(vocab).toContain("for the SVADA project");
    expect(vocab).not.toMatch(/unesco/i);
    expect(await init("/ecosystem/mcp")).toBeUndefined();
  });
});

describe("visibility", () => {
  it("GET / and /health name the two public services (ecosystem, TemaTres demo) and nothing of the private one", async () => {
    const w = await worker();
    const page = await (await w.fetch(new Request("https://s.example/"), ENV)).text();
    const health = await (await w.fetch(new Request("https://s.example/health"), ENV)).text();
    expect(page).toContain("https://s.example/ecosystem/mcp");
    expect(page).toContain("<code>ecosystem_search_extensions</code>");
    expect(JSON.parse(health)).toEqual({ status: "ok", runtime: "cloudflare-workers", services: [{ id: "ecosystem", endpoint: "/ecosystem/mcp" }, { id: "tematres", endpoint: "/tematres/mcp" }] });
    expect(page).toContain("https://s.example/tematres/mcp");
    expect(page).toContain(en.tematresTitle);
    for (const text of [page, health]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/svada|begrepp/i);
    }
  });

  it("without the secret the vocabulary service is off and the ecosystem service still answers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = await worker();
    const env = { ...ENV, SERVICES_VOCAB_PATH: "" };
    expect((await w.fetch(post(`/${SECRET}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), env)).status).toBe(404);
    expect((await w.fetch(post("/ecosystem/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), env)).status).toBe(200);
  });

  it("logs a call with the service id and never the secret path", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const w = await worker();
    await call(w, `/${SECRET}/mcp`, "vocab_search_concepts", { query: "data" });
    const lines = log.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(lines).toContain('"service":"vocab"');
    expect(lines).toContain('"query":"data"');
    expect(lines).not.toContain(SECRET);
  });
});

describe("landing page", () => {
  it("has the same keys in en and sv, and is Swedish for ?lang=sv", async () => {
    expect(Object.keys(sv).sort()).toEqual(Object.keys(en).sort());
    const w = await worker();
    const page = await (await w.fetch(new Request("https://s.example/?lang=sv"), ENV)).text();
    expect(page).toContain(`<html lang="sv">`);
    expect(page).toContain(sv.limits);
  });
});
