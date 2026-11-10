/**
 * The source alone: paths, file names, entities and the reading of a real file (recorded from
 * GitHub on 2026-11-10, tests/fixtures/github).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILE_NAME, billPath, decodeEntities, fileUrl, listingUrl, summarize } from "../src/akn.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "github", `${name}.body`), "utf8");

describe("paths", () => {
  it("pad the ddl id to eight digits under its legislature", () => {
    expect(billPath(19, 60233)).toBe("Leg19/Atto00060233");
    expect(billPath(13, 1, "emend")).toBe("Leg13/Atto00000001/emend");
  });

  it("build the contents API and raw file URLs", () => {
    expect(listingUrl(19, 60233, "sommcomm")).toBe("https://api.github.com/repos/SenatoDellaRepubblica/AkomaNtosoBulkData/contents/Leg19/Atto00060233/sommcomm");
    expect(fileUrl(19, 60233, "emendc", "01511402-em.akn.xml")).toBe("https://raw.githubusercontent.com/SenatoDellaRepubblica/AkomaNtosoBulkData/master/Leg19/Atto00060233/emendc/01511402-em.akn.xml");
  });

  it("accept only the repository's file names", () => {
    for (const ok of ["01511402-em.akn.xml", "01510990-ft.akn.xml", "01512599-ra.akn.xml", "01512302-rc.akn.xml"]) expect(FILE_NAME.test(ok)).toBe(true);
    for (const bad of ["../README.MD", "01511402-em.akn.xml/..", "1511402-em.akn.xml", "01511402-xx.akn.xml", "01511402-em.akn.xml?x=1"]) expect(FILE_NAME.test(bad)).toBe(false);
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric references and leaves unknown ones", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#171;x&#187; &#xE8; &bogus; &#0;")).toBe("a & b <c> «x» è &bogus; &#0;");
  });
});

describe("summarize", () => {
  it("reads an amendment's metadata and text", () => {
    const doc = summarize(fixture("emendc-01511402"));
    expect(doc).toMatchObject({ name: "Emendamento", subtype: "EMEND", number: "1.4", date: "2026-06-30", dateName: "presentazione" });
    expect(doc.text).toContain("Al comma 1 sopprimere le parole: «alla vendita o»");
    expect(doc.text).not.toMatch(/[<>]/);
  });

  it("reads a committee report and leaves the metadata out of the text", () => {
    const xml = fixture("sommcomm-01512302");
    const doc = summarize(xml);
    expect(doc).toMatchObject({ subtype: "SOMMCOMM", number: "284", name: "resoconto sommario di Commissione" });
    expect(doc.text).not.toContain("FRBR");
    expect(doc.text.length).toBeGreaterThan(4000);
  });

  it("copes with a file without metadata", () => {
    expect(summarize("<an:p>solo &amp; testo</an:p>")).toEqual({ text: "solo & testo", name: undefined, subtype: undefined, number: undefined, date: undefined, dateName: undefined });
  });
});
