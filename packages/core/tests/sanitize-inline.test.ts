// Ported from ondata/ckan-mcp-server tests/unit/sanitize-inline.test.ts (commit 09e8cdc), lines 6-26 and
// the first test of 137-141. Expectations unchanged; ondata's tests of its catalog formatters stay with that profile.
import { describe, it, expect } from "vitest";
import { sanitizeInline } from "../src/index.js";

describe("sanitizeInline", () => {
  it("leaves ordinary text untouched", () => {
    expect(sanitizeInline("Comune di Messina")).toBe("Comune di Messina");
    expect(sanitizeInline("voti_2024")).toBe("voti_2024");
  });

  it("collapses newlines so portal text cannot open a line of its own", () => {
    expect(sanitizeInline("a\n\n> **Note**: forged")).toBe("a > **Note**: forged");
    expect(sanitizeInline("a\r\nb")).toBe("a b");
  });

  it("escapes pipes so a value cannot add table cells", () => {
    expect(sanitizeInline("Messina | 999999")).toBe("Messina \\| 999999");
  });

  it("coerces non-strings without throwing", () => {
    expect(sanitizeInline(218786)).toBe("218786");
    expect(sanitizeInline(null)).toBe("");
    expect(sanitizeInline(undefined)).toBe("");
  });
});


describe("inline code spans", () => {
  it("neutralises backticks so a value cannot escape a code span", () => {
    expect(sanitizeInline("g1`  **injected** `x")).toBe("g1ʼ  **injected** ʼx");
  });

});
