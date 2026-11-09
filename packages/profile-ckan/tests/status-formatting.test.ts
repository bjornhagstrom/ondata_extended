// Ported from ondata/ckan-mcp-server tests/unit/status-formatting.test.ts at 09e8cdc (MIT). Reach: import paths only.
import { describe, it, expect } from "vitest";
import statusFixture from "./fixtures/responses/status-success.json";
import { formatStatusMarkdown } from "../src/tools/status.js";

const SERVER = "https://www.dati.gov.it/opendata";

describe("formatStatusMarkdown", () => {
  const result = statusFixture.result;

  it("includes Online status indicator", () => {
    const md = formatStatusMarkdown(result, SERVER);
    expect(md).toContain("✅ Online");
  });

  it("includes server URL", () => {
    const md = formatStatusMarkdown(result, SERVER);
    expect(md).toContain(`**Server**: ${SERVER}`);
  });

  it("includes CKAN version", () => {
    const md = formatStatusMarkdown(result, SERVER);
    expect(md).toContain("**CKAN Version**: 2.10.1");
  });

  it("includes site title and URL", () => {
    const md = formatStatusMarkdown(result, SERVER);
    expect(md).toContain("**Site Title**: CKAN Demo");
    expect(md).toContain("**Site URL**: http://demo.ckan.org");
  });

  it("shows Unknown when ckan_version is absent", () => {
    const noVersion = { ...result, ckan_version: undefined };
    const md = formatStatusMarkdown(noVersion, SERVER);
    expect(md).toContain("**CKAN Version**: Unknown");
  });
});
