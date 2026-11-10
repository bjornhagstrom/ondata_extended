/**
 * Ported from ondata/italianparliament-mcp src/tools/tools.test.ts at fd46810 (MIT, see NOTICE.md):
 * the tests of the ported tools (lines 41-88 and 746-769: deputies x3, legislatures, search x2).
 * The rest of that file tests tools not yet ported.
 *
 * Reach: the original queried the live endpoints ("Integration tests — hit real SPARQL
 * endpoints"); here each test reads the parity recording made with the same arguments (Camera,
 * recorded live 2026-11-10), and `execute` gets an engine context. Expectations unchanged.
 */

import { describe, it, expect } from "vitest";
import { deputiesTool } from "../../src/tools/deputies.js";
import { searchTool } from "../../src/tools/search.js";
import { legislaturesTool } from "../../src/tools/legislatures.js";
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
