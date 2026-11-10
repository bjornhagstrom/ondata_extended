/**
 * Ported from ondata/italianparliament-mcp src/tools/tools.test.ts at fd46810 (MIT, see NOTICE.md):
 * the tests of the ported tools (lines 41-88 and 746-769: deputies x3, legislatures, search x2;
 * round 2: lines 1013-1089 and 1107-1248, bill-progress x14, in its "Senato tools" block).
 * The rest of that file tests tools not yet ported.
 *
 * Reach: the original queried the live endpoints ("Integration tests — hit real SPARQL
 * endpoints"); here each test reads the parity recording made with the same arguments (Camera,
 * recorded live 2026-11-10; Senato synthetic, shaped to what the original's tests assert of the live
 * source), and `execute` gets an engine context. Expectations unchanged.
 */

import { describe, it, expect } from "vitest";
import { deputiesTool } from "../../src/tools/deputies.js";
import { searchTool } from "../../src/tools/search.js";
import { legislaturesTool } from "../../src/tools/legislatures.js";
import { billProgressTool } from "../../src/tools/bill-progress.js";
import { withRecording } from "../helpers.js";

describe("Camera tools", () => {
  it("deputies: returns rows for legislature 19", async () => {
    const result = await withRecording("deputies-leg19-limit3", (ctx) => deputiesTool.execute({ legislature: 19, limit: 3, offset: 0 }, ctx));
    expect(result.rows.length).toBe(3);
    expect(result.rows[0]).toHaveProperty("first_name");
    expect(result.rows[0]).toHaveProperty("last_name");
  }, 30000);

  it("deputies: demographic filters (gender + birthplace) constrain output", async () => {
    // Deputate leg.19 nate in Sicilia. Alla Camera birth_place NON è la città ma
    // lo slug dell'URI del luogo `comune_provincia_regione` (es.
    // "messina_messina_sicilia"): la regione è codificata lì, ed è ciò che rende
    // filtrabile la regione di nascita (a differenza del Senato, solo città).
    const result = await withRecording("deputies-female-sicilia", (ctx) => deputiesTool.execute({
      legislature: 19,
      gender: "female",
      birthPlace: "sicilia",
      limit: 100,
      offset: 0,
    }, ctx));
    expect(result.rows.length).toBeGreaterThan(0);
    for (const r of result.rows) {
      expect(r.gender).toBe("female");
      // slug comune_provincia_regione che termina con la regione filtrata
      expect(r.birth_place).toMatch(/_sicilia$/);
      expect(r.birth_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  }, 30000);

  it("deputies: born-from/born-to bound the birth date", async () => {
    const result = await withRecording("deputies-born-1990s", (ctx) => deputiesTool.execute({
      legislature: 19,
      bornFrom: "1990-01-01",
      bornTo: "1999-12-31",
      limit: 100,
      offset: 0,
    }, ctx));
    expect(result.rows.length).toBeGreaterThan(0);
    for (const r of result.rows) {
      expect(r.birth_date >= "1990-01-01" && r.birth_date <= "1999-12-31").toBe(true);
    }
  }, 30000);

  it("legislatures: returns all legislatures", async () => {
    const result = await withRecording("legislatures", (ctx) => legislaturesTool.execute({}, ctx));
    expect(result.rows.length).toBeGreaterThan(30);
    expect(result.rows[0]).toHaveProperty("uri");
    expect(result.rows[0]).toHaveProperty("date");
  }, 30000);

  it("search: finds Meloni in camera", async () => {
    const result = await withRecording("search-meloni-camera", (ctx) => searchTool.execute({
      name: "meloni",
      chamber: "camera",
      limit: 10,
    }, ctx));
    expect(result.rows.length).toBeGreaterThan(0);
    const giorgia = result.rows.find((r) => r.first_name === "Giorgia");
    expect(giorgia).toBeDefined();
    expect(giorgia?.gender).toBe("female");
  }, 30000);

  // Regressione: "nome cognome" deve funzionare anche con un secondo nome in
  // mezzo (label anagrafica "Elena Ethel Schlein"). Prima falliva perché il
  // match era su sottostringa contigua invece che per token.
  it("search: finds middle-name person by 'first last'", async () => {
    const result = await withRecording("search-elena-schlein", (ctx) => searchTool.execute({
      name: "Elena Schlein",
      chamber: "camera",
      limit: 10,
    }, ctx));
    const schlein = result.rows.find((r) => r.last_name === "Schlein");
    expect(schlein).toBeDefined();
  }, 30000);
});

describe("Senato tools", () => {
  it("bill-progress: legge nata dal DDL su Senato (S.1055 → L. 177/2025) e Camera (C.703-B, riga finale)", async () => {
    const s = await withRecording("bill-progress-ddl-58034", (ctx) => billProgressTool.execute({ ddlUri: "http://dati.senato.it/ddl/58034", limit: 10, offset: 0 }, ctx));
    expect(s.rows[0]).toMatchObject({
      law_number: "177",
      law_date: "2025-11-13",
      law_url: "https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2025-11-13;177",
    });
    const c = await withRecording("bill-progress-camera-703-B", (ctx) => billProgressTool.execute({ uri: "http://dati.camera.it/ocd/attocamera.rdf/ac19_703-B", limit: 100, offset: 0 }, ctx));
    const last = c.rows[c.rows.length - 1];
    expect(last.status).toMatch(/^Approvato definitivamente/);
    expect(last).toMatchObject({ law_number: "177", law_date: "2025-11-13" });
    // Solo l'ultima riga porta la legge: gli stati precedenti restano vuoti.
    expect(c.rows.slice(0, -1).every((r) => r.law_number === "")).toBe(true);
  }, 60000);

  it("bill-progress: legge costituzionale → urn legge.costituzionale; coppia ambigua → valori grezzi senza link", async () => {
    const ok = await withRecording("bill-progress-ddl-59612", (ctx) => billProgressTool.execute({ ddlUri: "http://dati.senato.it/ddl/59612", limit: 10, offset: 0 }, ctx));
    expect(ok.rows[0].law_url).toBe(
      "https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge.costituzionale:2026-05-18;2",
    );
    const amb = await withRecording("bill-progress-ddl-49285", (ctx) => billProgressTool.execute({ ddlUri: "http://dati.senato.it/ddl/49285", limit: 10, offset: 0 }, ctx));
    expect(amb.rows[0]).toMatchObject({ law_number: "1;687", law_date: "2020-10-19;2100-01-01", law_url: "" });
    const inCorso = await withRecording("bill-progress-ddl-55479", (ctx) => billProgressTool.execute({ ddlUri: "http://dati.senato.it/ddl/55479", limit: 10, offset: 0 }, ctx));
    expect(inCorso.rows[0]).toMatchObject({ law_number: "", law_url: "" });
    expect(inCorso.notice).toBeUndefined();
  }, 60000);

  it("bill-progress: countOnly coincide con le righe elencate (Senato)", async () => {
    const filter = { legislature: 19, keyword: "autonomia" };
    const count = await withRecording("bill-progress-autonomia-count", (ctx) => billProgressTool.execute({ ...filter, countOnly: true, limit: 100, offset: 0 }, ctx));
    expect(count.columns).toEqual(["count"]);
    const rows = await withRecording("bill-progress-autonomia-list", (ctx) => billProgressTool.execute({ ...filter, limit: 1000, offset: 0 }, ctx));
    expect(Number(count.rows[0].count)).toBe(rows.rows.length);
  }, 60000);

  it("bill-progress: countOnly rifiutato sul ramo Camera e con --number", async () => {
    await expect(
      withRecording("bill-progress-countonly-branch-C", (ctx) => billProgressTool.execute({ number: "3053", branch: "C", countOnly: true, limit: 100, offset: 0 }, ctx)),
    ).rejects.toThrow(/solo sull'elenco dei DDL del Senato/i);
    await expect(
      withRecording("bill-progress-countonly-number", (ctx) => billProgressTool.execute({ number: "1353", branch: "S", countOnly: true, limit: 100, offset: 0 }, ctx)),
    ).rejects.toThrow(/--number/i);
  }, 30000);

  it("bill-progress: un URI di host sconosciuto è un errore, non l'elenco intero", async () => {
    // Prima l'URI veniva scartato in silenzio: l'elenco tornava con DDL a caso
    // e countOnly con l'intero corpus (58.588), come se fosse la risposta.
    await expect(
      withRecording("bill-progress-unknown-host", (ctx) => billProgressTool.execute({ uri: "https://example.com/ddl/123", limit: 3, offset: 0 }, ctx)),
    ).rejects.toThrow(/URI non riconosciuto/i);
    await expect(
      withRecording("bill-progress-unknown-host-count", (ctx) => billProgressTool.execute({
        uri: "https://example.com/ddl/123",
        countOnly: true,
        limit: 3,
        offset: 0,
      }, ctx)),
    ).rejects.toThrow(/URI non riconosciuto/i);
    // Host che *contiene* il dominio senza esserlo: prima passava il controllo
    // per sottostringa e finiva sull'endpoint della Camera, dove tornava vuoto
    // — un "non trovato" al posto di "URI non riconosciuto".
    await expect(
      withRecording("bill-progress-lookalike-host", (ctx) => billProgressTool.execute({
        uri: "https://dati.camera.it.example.org/ocd/attocamera.rdf/ac19_302",
        limit: 3,
        offset: 0,
      }, ctx)),
    ).rejects.toThrow(/URI non riconosciuto/i);
  }, 30000);

  it("bill-progress: returns DDL for legislature 19", async () => {
    const result = await withRecording("bill-progress-leg19-limit3", (ctx) => billProgressTool.execute({ legislature: 19, limit: 3, offset: 0 }, ctx));
    expect(result.rows.length).toBe(3);
    expect(result.rows[0]).toHaveProperty("status");
    expect(result.rows[0]).toHaveProperty("title");
    expect(result.rows[0].legislature).toBe("19");
  }, 30000);


  it("bill-progress: Camera atto returns iter timeline with same schema as Senato", async () => {
    const camera = await withRecording("bill-progress-camera-302", (ctx) => billProgressTool.execute({
      uri: "http://dati.camera.it/ocd/attocamera.rdf/ac19_302",
      limit: 100,
      offset: 0,
    }, ctx));
    const senato = await withRecording("bill-progress-leg19-limit1", (ctx) => billProgressTool.execute({
      legislature: 19,
      limit: 1,
      offset: 0,
    }, ctx));
    // schema colonne identico tra ramo Camera e ramo Senato (issue #11)
    expect(camera.columns).toEqual(senato.columns);
    expect(camera.rows.length).toBeGreaterThanOrEqual(2);
    const first = camera.rows[0];
    expect(first.ddl_uri).toBe(
      "http://dati.camera.it/ocd/attocamera.rdf/ac19_302",
    );
    expect(first).toHaveProperty("status");
    expect(first.status_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.phase).toBe("C.302");
  }, 30000);

  it("bill-progress: Camera keyword matches decoded HTML entities in atto titles", async () => {
    const result = await withRecording("bill-progress-camera-2696-keyword", (ctx) => billProgressTool.execute({
      uri: "http://dati.camera.it/ocd/attocamera.rdf/ac19_2696",
      keyword: "criminalità",
      limit: 10,
      offset: 0,
    }, ctx));
    expect(result.rows.length).toBeGreaterThan(0);
    expect(
      result.rows.every(
        (r) => r.ddl_uri === "http://dati.camera.it/ocd/attocamera.rdf/ac19_2696",
      ),
    ).toBe(true);
  }, 30000);

  it("bill-progress: --number + --branch C returns the Camera iter timeline (#41)", async () => {
    // dl Covid Camera 2020: --number 2617 --branch C --legislature 18 deve dare
    // la timeline dell'atto Camera (più stati datati), non il record di rimando
    // lato Senato (una riga, phase C.2617, senza date).
    const result = await withRecording("bill-progress-number-2617-C-leg18", (ctx) => billProgressTool.execute({
      number: "2617",
      branch: "C",
      legislature: 18,
      limit: 100,
      offset: 0,
    }, ctx));
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    expect(result.rows[0].ddl_uri).toBe(
      "http://dati.camera.it/ocd/attocamera.rdf/ac18_2617",
    );
    expect(result.rows[0].phase).toBe("C.2617");
    expect(result.rows[0].status_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // deve contenere lo stato finale "Legge"
    expect(result.rows.some((r) => /Legge/.test(r.status))).toBe(true);
  }, 30000);

  it("bill-progress: a Camera number on branch S falls back to all phases of the same DDL", async () => {
    // La numerazione non si conserva tra i rami: il DDL delega sul nucleare è
    // C.2669 alla Camera e S.1924 al Senato. Chiedere S.2669 dava un vuoto letto
    // come "il Senato non ha ancora l'atto" (report del 29/07/2026). Ora si
    // risale all'idDdl dalla fase C.2669 e si mostrano tutte le fasi.
    const result = await withRecording("bill-progress-number-2669-S", (ctx) => billProgressTool.execute({
      number: "2669",
      branch: "S",
      legislature: 19,
      limit: 100,
      offset: 0,
    }, ctx));
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    expect(result.rows.some((r) => r.phase === "C.2669")).toBe(true);
    expect(result.rows.some((r) => r.phase === "S.1924")).toBe(true);
    // Le righe non sono vuote, quindi la spiegazione va in `notice` (hint per
    // contratto parla solo sul vuoto).
    expect(result.notice).toMatch(/non esiste un DDL S\.2669/);
    expect(result.hint).toBeUndefined();
  }, 60000);

  it("bill-progress: the cross-branch notice does not claim completeness when the page is full", async () => {
    // Con --limit 1 su un DDL a due fasi si vede una riga sola: il notice non
    // deve chiamarle "TUTTE le fasi", altrimenti un iter incompleto viene letto
    // come completo — l'errore che questo aggancio esiste per evitare (review
    // Greptile P1 su PR #87).
    const result = await withRecording("bill-progress-number-2669-S-limit1", (ctx) => billProgressTool.execute({
      number: "2669",
      branch: "S",
      legislature: 19,
      limit: 1,
      offset: 0,
    }, ctx));
    expect(result.rows.length).toBe(1);
    expect(result.notice).toMatch(/non esiste un DDL S\.2669/);
    expect(result.notice).not.toMatch(/TUTTE le fasi/);
    expect(result.notice).toMatch(/tagliato dal limite/);
    // Su una pagina tagliata l'assenza di fasi S. non è affermabile.
    expect(result.notice).not.toMatch(/Nessuna fase al Senato/);
  }, 60000);

  it("bill-progress: a number that exists on branch S is NOT overridden by the fallback", async () => {
    // S.1511 (leg. 18) esiste come DDL autonomo, diverso da C.1511: il fallback
    // non deve scattare e non deve comparire alcuna nota cross-ramo.
    const result = await withRecording("bill-progress-number-1511-S-leg18", (ctx) => billProgressTool.execute({
      number: "1511",
      branch: "S",
      legislature: 18,
      limit: 10,
      offset: 0,
    }, ctx));
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((r) => r.phase.startsWith("S.1511"))).toBe(true);
    expect(result.notice).toBeUndefined();
  }, 60000);

  it("bill-progress: --number + --branch C honours pagination filters", async () => {
    const result = await withRecording("bill-progress-number-2617-C-limit1", (ctx) => billProgressTool.execute({
      number: "2617",
      branch: "C",
      legislature: 18,
      limit: 1,
      offset: 0,
    }, ctx));
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].ddl_uri).toBe(
      "http://dati.camera.it/ocd/attocamera.rdf/ac18_2617",
    );
  }, 30000);

  it("bill-progress: empty Camera timeline surfaces a branch-C specific hint", async () => {
    const result = await withRecording("bill-progress-number-2617-C-2035", (ctx) => billProgressTool.execute({
      number: "2617",
      branch: "C",
      legislature: 18,
      dateFrom: "2035-01-01",
      limit: 10,
      offset: 0,
    }, ctx));
    expect(result.rows.length).toBe(0);
    expect(result.hint).toContain("iter Camera");
    expect(result.hint).toContain("filtri");
  }, 30000);
});
