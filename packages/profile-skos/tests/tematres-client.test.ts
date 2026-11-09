/**
 * TemaTres envelope handling against responses recorded from begrepp.hagstrom.nu on
 * 2026-11-09 (tests/fixtures/tematres/*.body, with the URL and Content-Type in *.meta.json).
 * Each test names the quirk it pins down (docs/tematres-api-derisking.md).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineContext, HttpResponse } from "@ondata-extended/profile-contract";
import { HttpStatusError } from "@ondata-extended/core";
import {
  TemaTresProtocolError,
  asBool,
  asId,
  callTask,
  inOrder,
  parseEnvelope,
  servicesUrl
} from "../src/adapters/tematres/client.js";

const FIX = join(import.meta.dirname, "fixtures", "tematres");
const fixture = (name: string) => ({
  text: readFileSync(join(FIX, `${name}.body`), "utf8"),
  contentType: (JSON.parse(readFileSync(join(FIX, `${name}.meta.json`), "utf8")) as { contentType: string }).contentType
});
const parse = (task: string, name: string) => {
  const f = fixture(name);
  return parseEnvelope(task, f.contentType, f.text);
};

describe("parseEnvelope on recorded answers", () => {
  it("reads id-keyed rows in document order and the resume block", () => {
    const a = parse("fetchDown", "down-36");
    expect(a.rows.map((r) => asId(r.term_id))).toEqual(["10", "15", "38", "26", "25", "11"]);
    expect(a.resume.cant_result).toBe(6);
    expect(a.resume.version).toBe("TemaTres 3.6.1");
    expect(a.record).toBeNull();
  });

  it("reads a flat record (fetchVocabularyData)", () => {
    const a = parse("fetchVocabularyData", "vocabulary-data");
    expect(a.rows).toEqual([]);
    expect(a.record?.title).toBe("Svada - termer och begrepp");
    expect(a.record?.uri).toBe("https://begrepp.hagstrom.nu/");
  });

  it("treats a missing result as no rows, not an error (no hits and unknown id look the same)", () => {
    for (const [task, name] of [["search", "search-none"], ["fetchTerm", "term-missing"]]) {
      const a = parse(task, name);
      expect(a.rows).toEqual([]);
      expect(a.record).toBeNull();
      expect(a.resume.cant_result).toBe(0);
    }
  });

  it("reads fetchTerm's single nested row", () => {
    const a = parse("fetchTerm", "term-2");
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ string: "Dataområde", lang: "sv" });
  });

  it("reads fetchSimilar's bare string as a record", () => {
    expect(parse("fetchSimilar", "similar").record).toEqual({ string: "dataområde" });
  });

  it("refuses the XML help page TemaTres sends for an unknown task, even with output=json", () => {
    expect(() => parse("bogus", "invalid-task")).toThrow(TemaTresProtocolError);
    expect(() => parse("bogus", "invalid-task")).toThrow("did not answer");
  });

  it("refuses XML even when the content type claims JSON, and invalid JSON", () => {
    expect(() => parseEnvelope("x", "application/json", "<?xml version='1.0'?><a/>")).toThrow(TemaTresProtocolError);
    expect(() => parseEnvelope("x", "application/json", "{not json")).toThrow("invalid JSON");
    expect(() => parseEnvelope("x", "application/json", '{"result":{}}')).toThrow('without a "resume"');
  });
});

describe("normalizers for the API's inconsistent types", () => {
  it("search returns numeric ids and isMetaTerm, fetchUp string ones; both normalize the same", () => {
    const search = parse("search", "search-data").rows;
    const up = parse("fetchUp", "up-10").rows;
    expect(typeof search[0].term_id).toBe("number");
    expect(typeof up[0].term_id).toBe("string");
    expect(asId(search.find((r) => asId(r.term_id) === "10")!.term_id)).toBe("10");
    expect(asBool(up[0].isMetaTerm)).toBe(true);
    expect(asBool(search[0].isMetaTerm)).toBe(false);
    expect(asBool(null)).toBe(false);
  });

  it("orders rows by `order` when every row has one", () => {
    const rows = inOrder(parse("search", "search-data").rows);
    expect(rows.map((r) => Number(r.order))).toEqual([...rows.map((r) => Number(r.order))].sort((a, b) => a - b));
    expect(rows[0].string).toBe("Rättighetsinnehavare");
    const noOrder = parse("fetchDown", "down-36").rows;
    expect(inOrder(noOrder)).toBe(noOrder);
  });

  it("fetchUp gives the path from the top down to the term itself", () => {
    const path = inOrder(parse("fetchUp", "up-10").rows).map((r) => r.string);
    expect(path).toEqual(["Stadens roller (datastyrning)", "Dataägare"]);
  });

  it("notes come as HTML that the adapter must turn into text", () => {
    const note = parse("fetchNotes", "notes-2").rows[0];
    expect(note.note_type).toBe("DF");
    expect(String(note.note_text)).toContain("<h4>");
  });
});

describe("servicesUrl and callTask", () => {
  it("builds the services.php URL with an encoded argument", () => {
    expect(servicesUrl("https://begrepp.hagstrom.nu", "search", "data & mer"))
      .toBe("https://begrepp.hagstrom.nu/services.php?task=search&arg=data+%26+mer&output=json");
    expect(servicesUrl("https://example.org/vocab/", "fetchTopTerms"))
      .toBe("https://example.org/vocab/services.php?task=fetchTopTerms&output=json");
  });

  const fakeCtx = (answer: Partial<HttpResponse>, seen: { url?: string; opts?: unknown } = {}): EngineContext => ({
    http: {
      request: async (url: string, _init: unknown, opts: unknown) => {
        seen.url = url;
        seen.opts = opts;
        return { url, status: 200, statusText: "OK", headers: {}, text: "", fromCache: false, ...answer };
      },
      json: async () => { throw new Error("unused"); },
      validateUrl: () => undefined
    }
  } as unknown as EngineContext);

  it("goes through the engine's HTTP client with a cache TTL and parses the answer", async () => {
    const f = fixture("term-2");
    const seen: { url?: string; opts?: { cache?: { ttlSeconds: number } } } = {};
    const a = await callTask(fakeCtx({ text: f.text, headers: { "content-type": f.contentType } }, seen), "https://begrepp.hagstrom.nu", "fetchTerm", "2");
    expect(seen.url).toBe("https://begrepp.hagstrom.nu/services.php?task=fetchTerm&arg=2&output=json");
    expect(seen.opts?.cache?.ttlSeconds).toBe(300);
    expect(a.rows[0].string).toBe("Dataområde");
  });

  it("turns a non-2xx status into HttpStatusError without the body", async () => {
    const error = await callTask(fakeCtx({ status: 503, statusText: "Service Unavailable", text: "secret detail" }), "https://x.example", "fetchTerm", "2")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as HttpStatusError).body).toBeNull();
    expect((error as HttpStatusError).message).not.toContain("secret detail");
  });

  it("refuses a task outside the adapter's list before any request", async () => {
    const seen: { url?: string } = {};
    await expect(callTask(fakeCtx({}, seen), "https://x.example", "fetchTermFull" as never)).rejects.toThrow("not used by this adapter");
    expect(seen.url).toBeUndefined();
  });
});
