/**
 * Contract tests: the tools against a fake `ctx.http`. They check what the profile asks of the
 * engine (URL, headers, options) and what it does with the answer, with no network and no
 * guards. The end-to-end test (profile.test.ts) covers the same tools through the real engine.
 */
import { describe, it, expect } from "vitest";
import { createEngine } from "@ondata-extended/core";
import type { EngineContext, EngineHttp, FetchOptions, HttpResponse, ToolResult } from "@ondata-extended/profile-contract";
import { EXAMPLE_TOOLS, createExampleProfile } from "../src/index.js";

interface Call { url: string; init?: RequestInit; opts?: FetchOptions }

function fakeHttp(answer: (url: string) => HttpResponse | unknown): { http: EngineHttp; calls: Call[] } {
  const calls: Call[] = [];
  const http: EngineHttp = {
    async request(url, init, opts) {
      calls.push({ url, init, opts });
      return answer(url) as HttpResponse;
    },
    async json(url, init, opts) {
      calls.push({ url, init, opts });
      const a = answer(url);
      if (a instanceof Error) throw a;
      return a as never;
    },
    validateUrl() {}
  };
  return { http, calls };
}

function context(http: EngineHttp, env: Record<string, string> = {}): EngineContext & { notes: Record<string, unknown>[] } {
  const engine = createEngine({ configPrefixes: ["AKN"], configSource: env, cacheOrigin: "https://t.internal" });
  const real = engine.contextFor(createExampleProfile(), {});
  const notes: Record<string, unknown>[] = [];
  return { ...real, http, telemetry: { note: (f) => void notes.push(f) }, notes };
}

const tool = (name: string) => EXAMPLE_TOOLS.find((t) => t.name === name)!;
const response = (text: string, status = 200): HttpResponse => ({ url: "", status, statusText: status === 200 ? "OK" : "Not Found", headers: {}, text, fromCache: false });

describe("akn_list_files", () => {
  it("asks the contents API, as a fixed upstream, cached, with the honest agent", async () => {
    const { http, calls } = fakeHttp(() => [{ name: "emend", type: "dir" }, { name: "README.MD", type: "file", size: 10 }]);
    const ctx = context(http);
    const r = await tool("akn_list_files").rows!({ legislature: 19, ddl: 60233 }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/SenatoDellaRepubblica/AkomaNtosoBulkData/contents/Leg19/Atto00060233");
    expect(calls[0].opts).toMatchObject({ fixedUpstream: true, userAgent: "honest", cache: { ttlSeconds: 3600 } });
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBeNull();
    expect(r.columns).toEqual(["name", "type", "title"]);
    expect(r.rows).toEqual([{ name: "emend", type: "dir", size: "", title: "amendments in the Assembly" }, { name: "README.MD", type: "file", size: "10", title: "" }]);
    expect(ctx.notes).toEqual([{ result_count: 2 }]);
  });

  it("sends the configured token to the API, and only there", async () => {
    const { http, calls } = fakeHttp(() => []);
    await tool("akn_list_files").rows!({ legislature: 19, ddl: 1, kind: "emend" }, context(http, { AKN_GITHUB_TOKEN: "t0ken" }));
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer t0ken");
  });

  it("says when GitHub's 1000-entry listing cap may have cut the folder", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ name: `${String(i).padStart(8, "0")}-em.akn.xml`, type: "file", size: 1 }));
    const r = await tool("akn_list_files").rows!({ legislature: 18, ddl: 52873, kind: "emend" }, context(fakeHttp(() => many).http));
    expect(r.notice).toMatch(/at most 1000 entries/);
    const few = await tool("akn_list_files").rows!({ legislature: 18, ddl: 52873, kind: "emend" }, context(fakeHttp(() => many.slice(1)).http));
    expect(few.notice).toBeUndefined();
  });

  it("turns a 404 into the profile's own error, and refuses an answer that is not a listing", async () => {
    const { HttpStatusError } = await import("@ondata-extended/core");
    const missing = fakeHttp(() => new HttpStatusError(404, "Not Found", "u", null)).http;
    await expect(tool("akn_list_files").rows!({ legislature: 19, ddl: 9999999 }, context(missing))).rejects.toThrow(/Ddl 9999999 \(legislature 19\) is not in/);
    const file = fakeHttp(() => ({ name: "x", type: "file" })).http;
    await expect(tool("akn_list_files").rows!({ legislature: 19, ddl: 1 }, context(file))).rejects.toThrow(/not answer with a folder listing/);
  });
});

describe("akn_document", () => {
  const xml = `<an:meta><an:FRBRname value="Emendamento"/><an:FRBRnumber value="1.4"/><an:FRBRsubtype value="EMEND"/><an:FRBRdate date="2026-06-30" name="presentazione"/></an:meta><an:p>${"parola ".repeat(100)}</an:p>`;
  const args = { legislature: 19, ddl: 60233, kind: "emendc", file: "01511402-em.akn.xml", max_chars: 200, response_format: "json" };

  it("reads the raw file, never with the token, and cuts the text at max_chars", async () => {
    const { http, calls } = fakeHttp(() => response(xml));
    const r = await tool("akn_document").handler!(args, context(http, { AKN_GITHUB_TOKEN: "t0ken" })) as ToolResult;
    expect(calls[0].url).toBe("https://raw.githubusercontent.com/SenatoDellaRepubblica/AkomaNtosoBulkData/master/Leg19/Atto00060233/emendc/01511402-em.akn.xml");
    expect(calls[0].init?.headers).toBeUndefined();
    expect(calls[0].opts).toMatchObject({ fixedUpstream: true });
    const out = JSON.parse(r.content[0].text);
    expect(out).toMatchObject({ name: "Emendamento", number: "1.4", subtype: "EMEND", date: "2026-06-30", truncated: true, text_length: 699 });
    expect(out.text).toHaveLength(201);
  });

  it("maps 404 to the profile's error and other statuses to the core's", async () => {
    await expect(tool("akn_document").handler!(args, context(fakeHttp(() => response("", 404)).http))).rejects.toThrow(/File emendc\/01511402-em.akn.xml of ddl 60233/);
    await expect(tool("akn_document").handler!(args, context(fakeHttp(() => ({ ...response("", 503), statusText: "Service Unavailable" })).http))).rejects.toThrow(/^HTTP 503 Service Unavailable$/);
  });
});

describe("akn_document cutting", () => {
  it("never splits a surrogate pair at max_chars", async () => {
    const body = `<an:meta></an:meta><an:p>${"a".repeat(199)}😀tail</an:p>`;
    const r = await tool("akn_document").handler!({ legislature: 19, ddl: 1, kind: "emend", file: "00000001-em.akn.xml", max_chars: 200, response_format: "json" }, context(fakeHttp(() => response(body)).http)) as ToolResult;
    const out = JSON.parse(r.content[0].text);
    expect(out.text).toBe(`${"a".repeat(199)}…`);
  });
});

describe("describeError", () => {
  const profile = createExampleProfile();
  it("hints at the rate limit for 403 and 429, and leaves other errors to the core", async () => {
    const { HttpStatusError } = await import("@ondata-extended/core");
    const api = "https://api.github.com/repos/x/contents/y";
    const raw = "https://raw.githubusercontent.com/x/master/y";
    expect(profile.describeError!(new HttpStatusError(403, "Forbidden", api, null), "akn_list_files")).toMatch(/60 an hour/);
    expect(profile.describeError!(new HttpStatusError(429, "", api, null), "akn_list_files")).toMatch(/request limit/);
    expect(profile.describeError!(new HttpStatusError(429, "", raw, null), "akn_document")).toBe("→ GitHub refused or limited the file download. Retry later.");
    expect(profile.describeError!(new HttpStatusError(500, "", "u", null), "akn_list_files")).toBeNull();
    expect(profile.describeError!(new Error("x"), "akn_list_files")).toBeNull();
  });
});
