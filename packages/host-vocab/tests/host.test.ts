/**
 * The vocabulary deployment: Worker routes, generated health and landing page (en/sv).
 */
import { describe, it, expect } from "vitest";
import worker, { landingPage } from "../src/worker.js";
import en from "../src/i18n/en.json";
import sv from "../src/i18n/sv.json";
import { profile, SERVER_NAME } from "../src/server.js";
import { INSTRUCTIONS, VOCABULARIES } from "../src/vocabularies.js";

describe("language files", () => {
  it("have the same keys in en and sv", () => {
    expect(Object.keys(sv).sort()).toEqual(Object.keys(en).sort());
    for (const v of Object.values(sv)) expect(String(v).length).toBeGreaterThan(0);
  });
});

describe("landing page", () => {
  it("is English by default and Swedish for ?lang=sv or Accept-Language sv", async () => {
    const enPage = await landingPage(new Request("https://v.example/")).text();
    expect(enPage).toContain(`<html lang="en">`);
    expect(enPage).toContain(en.title);
    const svPage = await landingPage(new Request("https://v.example/?lang=sv")).text();
    expect(svPage).toContain(sv.title);
    const svHeader = await landingPage(new Request("https://v.example/", { headers: { "accept-language": "sv-SE,sv;q=0.9" } })).text();
    expect(svHeader).toContain(`<html lang="sv">`);
  });

  it("says test service unless the deployment declares itself the production service", async () => {
    expect(await landingPage(new Request("https://v.example/")).text()).toContain(en.statusTest);
    expect(await landingPage(new Request("https://v.example/"), { VOCAB_SERVICE_STATUS: "other" }).text()).toContain(en.statusTest);
    const service = await landingPage(new Request("https://v.example/?lang=sv"), { VOCAB_SERVICE_STATUS: "service" }).text();
    expect(service).toContain(sv.statusService);
    expect(service).not.toContain(sv.statusTest);
  });

  it("lists every registered tool and the endpoint, generated from the profile", async () => {
    const page = await landingPage(new Request("https://v.example/")).text();
    for (const t of profile.tools) expect(page).toContain(`<code>${t.name}</code>`);
    expect(page).toContain("https://v.example/mcp");
  });
});

describe("server instructions", () => {
  it("/mcp sends the profile's instructions with this deployment's sentence about Svada", async () => {
    const res = await worker.fetch(new Request("https://v.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })
    }), {});
    const instructions = ((await res.json()) as { result: { instructions?: string } }).result.instructions ?? "";
    expect(instructions).toContain("'svada' (Svada - termer och begrepp)");
    expect(instructions.endsWith(INSTRUCTIONS)).toBe(true);
  });
});

describe("worker routes", () => {
  it("/health reports counts taken from the profile", async () => {
    const res = await worker.fetch(new Request("https://v.example/health"), {});
    expect(await res.json()).toMatchObject({ status: "ok", name: SERVER_NAME, tools: profile.tools.length, prompts: 0, resources: 0 });
  });

  it("/ passes the deployment's env to the landing page, so production says it is the service", async () => {
    const service = await (await worker.fetch(new Request("https://v.example/"), { VOCAB_SERVICE_STATUS: "service" })).text();
    expect(service).toContain(en.statusService);
    const test = await (await worker.fetch(new Request("https://v.example/"), {})).text();
    expect(test).toContain(en.statusTest);
  });

  it("/mcp lists the nine vocab_ tools", async () => {
    const res = await worker.fetch(new Request("https://v.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    }), {});
    const body = await res.json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools).toHaveLength(9);
    expect(body.result.tools.every((t) => t.name.startsWith("vocab_"))).toBe(true);
  });
});

describe("Svada's own note types", () => {
  it("declares its change notes (CH) as skos:changeNote, as its SKOS export writes them", () => {
    expect(VOCABULARIES[0].ext.noteTypes).toEqual({ CH: "changeNote" });
  });
});
