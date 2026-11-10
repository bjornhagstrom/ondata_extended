/**
 * Ported from ondata/italianparliament-mcp src/tools/sparql.test.ts at fd46810 (MIT, see NOTICE.md).
 * Reach: import paths; `execute` gets an engine context; the three tests that queried the live
 * endpoints read recorded answers instead (Camera recorded 2026-11-10; the Senato count is a
 * synthetic answer, see tests/parity/cases.ts). Expectations unchanged.
 */

import { describe, it, expect } from "vitest";
import { sparqlTool, validateSelectQuery } from "../../src/tools/sparql.js";
import { testContext, withRecording } from "../helpers.js";

describe("sparql tool", () => {
  describe("validateSelectQuery", () => {
    it("rifiuta un update che nasconde una SELECT più avanti", () => {
      expect(() =>
        validateSelectQuery(
          "INSERT DATA { <http://x/a> <http://x/b> 1 } ; SELECT ?s WHERE { ?s ?p ?o }",
        ),
      ).toThrow("Solo query SELECT supportate");
    });

    it("rifiuta un update concatenato dopo una SELECT", () => {
      expect(() =>
        validateSelectQuery("SELECT ?s WHERE { ?s ?p ?o } ; DROP GRAPH <http://x/g>"),
      ).toThrow("keyword di scrittura DROP");
    });

    it("ignora una keyword di scrittura che sta dentro un commento", () => {
      expect(() =>
        validateSelectQuery("# DELETE WHERE { ?s ?p ?o }\nSELECT ?s WHERE { ?s ?p ?o }"),
      ).not.toThrow();
    });

    it("non scambia per scrittura un letterale che contiene una keyword", () => {
      expect(() =>
        validateSelectQuery(
          'SELECT ?t WHERE { ?s ?p ?t . FILTER(CONTAINS(?t, "delete")) }',
        ),
      ).not.toThrow();
    });

    it("non scambia per scrittura un IRI che contiene una keyword", () => {
      expect(() =>
        validateSelectQuery(
          "PREFIX x: <http://dati.camera.it/ocd/add-drop/> SELECT ?s WHERE { ?s a x:cosa }",
        ),
      ).not.toThrow();
    });
  });

  describe("validation", () => {
    it("rejects non-SELECT queries", async () => {
      await expect(
        sparqlTool.execute({
          query: "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }",
          endpoint: "camera",
          limit: 10,
        }, testContext()),
      ).rejects.toThrow("Solo query SELECT supportate");
    });

    it("rejects DELETE queries", async () => {
      await expect(
        sparqlTool.execute({
          query: "DELETE WHERE { ?s ?p ?o }",
          endpoint: "camera",
          limit: 10,
        }, testContext()),
      ).rejects.toThrow("Solo query SELECT supportate");
    });

    it("accepts a one-line SELECT with a #-terminated PREFIX before SELECT (regression)", async () => {
      const result = await withRecording("sparql-oneline-prefix", (ctx) => sparqlTool.execute({
        query:
          "PREFIX ocd: <http://dati.camera.it/ocd/> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> SELECT ?label WHERE { ?o a ocd:legislatura ; rdfs:label ?label }",
        endpoint: "camera",
        limit: 1,
      }, ctx));
      expect(result.rows.length).toBe(1);
    }, 30000);
  });

  describe("integration", () => {
    it("executes a count query on Camera", async () => {
      const result = await withRecording("sparql-camera-count", (ctx) => sparqlTool.execute({
        query: "PREFIX ocd: <http://dati.camera.it/ocd/> SELECT (COUNT(?s) AS ?n) WHERE { ?s a ocd:legislatura }",
        endpoint: "camera",
        limit: 1,
      }, ctx));
      expect(result.rows.length).toBe(1);
      expect(Number(result.rows[0].n)).toBeGreaterThan(0);
    }, 30000);

    it("executes a count query on Senato", async () => {
      // Synthetic Senato answer: no test may reach dati.senato.it.
      const result = await withRecording("sparql-senato-count", (ctx) => sparqlTool.execute({
        query: "PREFIX osr: <http://dati.senato.it/osr/> SELECT (COUNT(?s) AS ?n) WHERE { ?s a osr:Senatore }",
        endpoint: "senato",
        limit: 1,
      }, ctx));
      expect(result.rows.length).toBe(1);
      expect(Number(result.rows[0].n)).toBeGreaterThan(0);
    }, 30000);
  });
});
