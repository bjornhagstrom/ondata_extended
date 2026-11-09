// Ported from ondata's italianparliament-mcp (MIT, Andrea Borruso), commit fd46810:
// src/tools/sparql.test.ts (validateSelectQuery block) and src/core/sparql-literal.test.ts.
// Inputs and verdicts unchanged; test names and expected message texts translated to English (logged in docs/test-parity.md).
import { describe, it, expect } from "vitest";
import { validateSelectQuery, sparqlStringLiteral, injectLimit, flattenBindings } from "../src/index.js";

describe("SELECT validation", () => {
  describe("validateSelectQuery", () => {
    it("refuses an update that hides a SELECT further on", () => {
      expect(() =>
        validateSelectQuery(
          "INSERT DATA { <http://x/a> <http://x/b> 1 } ; SELECT ?s WHERE { ?s ?p ?o }",
        ),
      ).toThrow("Only SELECT queries are supported");
    });

    it("refuses an update chained after a SELECT", () => {
      expect(() =>
        validateSelectQuery("SELECT ?s WHERE { ?s ?p ?o } ; DROP GRAPH <http://x/g>"),
      ).toThrow("update keyword DROP");
    });

    it("ignores an update keyword inside a comment", () => {
      expect(() =>
        validateSelectQuery("# DELETE WHERE { ?s ?p ?o }\nSELECT ?s WHERE { ?s ?p ?o }"),
      ).not.toThrow();
    });

    it("does not take a literal containing a keyword for a write", () => {
      expect(() =>
        validateSelectQuery(
          'SELECT ?t WHERE { ?s ?p ?t . FILTER(CONTAINS(?t, "delete")) }',
        ),
      ).not.toThrow();
    });

    it("does not take an IRI containing a keyword for a write", () => {
      expect(() =>
        validateSelectQuery(
          "PREFIX x: <http://example.org/add-drop/> SELECT ?s WHERE { ?s a x:cosa }",
        ),
      ).not.toThrow();
    });
  });
});

describe("sparqlStringLiteral", () => {
  it("wraps the value in quotes", () => {
    expect(sparqlStringLiteral("FDI")).toBe('"FDI"');
  });

  it("escapes inner quotes", () => {
    expect(sparqlStringLiteral('AL"T')).toBe('"AL\\"T"');
  });

  it("escapes backslashes", () => {
    expect(sparqlStringLiteral("A\\B")).toBe('"A\\\\B"');
  });

  it("escapes line breaks", () => {
    expect(sparqlStringLiteral("a\nb\rc")).toBe('"a\\nb\\rc"');
  });

  it("leaves other characters alone, accents included", () => {
    expect(sparqlStringLiteral("M-+EUR è così")).toBe('"M-+EUR è così"');
  });
});

describe("injectLimit and flattenBindings (new)", () => {
  it("injects a LIMIT only when the query has none, and says so", () => {
    expect(injectLimit("SELECT ?s WHERE { ?s ?p ?o }", 5)).toEqual({ query: "SELECT ?s WHERE { ?s ?p ?o }\nLIMIT 5", injected: true });
    expect(injectLimit("SELECT ?s WHERE { ?s ?p ?o } LIMIT 3", 5)).toEqual({ query: "SELECT ?s WHERE { ?s ?p ?o } LIMIT 3", injected: false });
  });

  it("gives one string per variable, empty when unbound", () => {
    expect(flattenBindings({ head: { vars: ["a", "b"] }, results: { bindings: [{ a: { type: "literal", value: "x" } }] } }))
      .toEqual([{ a: "x", b: "" }]);
  });
});
