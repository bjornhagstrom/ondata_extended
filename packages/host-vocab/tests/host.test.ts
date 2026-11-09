/**
 * The vocabulary deployment: Worker routes, generated health and landing page (en/sv).
 */
import { describe, it, expect } from "vitest";
import worker, { landingPage } from "../src/worker.js";
import en from "../src/i18n/en.json";
import sv from "../src/i18n/sv.json";
import { profile, SERVER_NAME } from "../src/server.js";

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

  it("lists every registered tool and the endpoint, generated from the profile", async () => {
    const page = await landingPage(new Request("https://v.example/")).text();
    for (const t of profile.tools) expect(page).toContain(`<code>${t.name}</code>`);
    expect(page).toContain("https://v.example/mcp");
  });
});

describe("worker routes", () => {
  it("/health reports counts taken from the profile", async () => {
    const res = await worker.fetch(new Request("https://v.example/health"), {});
    expect(await res.json()).toMatchObject({ status: "ok", name: SERVER_NAME, tools: profile.tools.length, prompts: 0, resources: 0 });
  });

  it("/mcp lists the eight vocab_ tools", async () => {
    const res = await worker.fetch(new Request("https://v.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    }), {});
    const body = await res.json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools).toHaveLength(8);
    expect(body.result.tools.every((t) => t.name.startsWith("vocab_"))).toBe(true);
  });
});
