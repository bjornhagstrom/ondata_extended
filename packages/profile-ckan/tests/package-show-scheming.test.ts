// Ported from ondata/ckan-mcp-server tests/integration/package-show-scheming.test.ts at 09e8cdc (MIT).
// Reach: the tool is called through the whole CKAN profile on the core (ckanClient); ondata's
// axios mock (URL + params, an axios error with a response for a failed schema request) is a fake
// fetch (the URL carries the params; a failed schema request is that status with CKAN's error
// body). Expectations unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { __setDnsResolverForTests } from "@ondata-extended/core";
import { __resetSchemaCacheForTests } from "../src/utils/scheming.js";
import { ckanClient, jsonResponse, mockFetch, stubPublicDns } from "./helpers.js";

const SCHEMA = {
  dataset_fields: [
    { field_name: "title_translated", label: "Title" },
    { field_name: "keywords", label: { en: "Keywords", fr: "Mots-clés" } },
    { field_name: "author_email", label: "Author email" },
    { field_name: "access_rights", label: "Access rights" },
    { field_name: "temporal_coverage", label: "Temporal coverage" },
    { field_name: "internal_note", label: "Internal note", display_snippet: null }
  ]
};

const PKG = {
  id: "p1", name: "p1", title: "Air", type: "showcase", state: "active",
  author_email: "a@example.org", access_rights: "public",
  keywords: { en: ["air"], fr: ["air"] },
  temporal_coverage: [{ temporal_start: "2020-01-01", temporal_end: "2020-12-31" }],
  internal_note: "hidden",
  resources: [], tags: [], groups: []
};

let calls: string[];

function portal(opts: { schema?: unknown; schemaStatus?: number; pkg?: object }) {
  calls = [];
  mockFetch(async (input) => {
    const where = decodeURIComponent(String(input));
    calls.push(where);
    if (where.includes("scheming_dataset_schema_show")) {
      if (opts.schema) return jsonResponse({ success: true, result: opts.schema });
      return jsonResponse({ success: false, error: { message: "Action name not known" } }, { status: opts.schemaStatus ?? 400 });
    }
    return jsonResponse({ success: true, result: opts.pkg ?? PKG });
  });
}

async function show(server: string, format: "json" | "markdown") {
  const client = await ckanClient();
  const res = await client.callTool("ckan_package_show", { server_url: server, id: "p1", response_format: format });
  return res.content[0].text as string;
}

describe("ckan_package_show with a scheming portal", () => {
  beforeEach(() => {
    stubPublicDns();
    __resetSchemaCacheForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __setDnsResolverForTests(null);
  });

  it("asks for the schema of the dataset's own type", async () => {
    portal({ schema: SCHEMA });
    await show("https://scheming-type.example.org", "json");
    expect(calls.find((c) => c.includes("scheming_dataset_schema_show"))).toContain("showcase");
  });

  it("adds `fields` to JSON, with what JSON does not carry and without what it does", async () => {
    portal({ schema: SCHEMA });
    const out = JSON.parse(await show("https://scheming-json.example.org", "json"));
    const names = out.fields.map((f: { field: string }) => f.field);
    // JSON has no author_email or access_rights; it does carry a temporal_coverage period
    expect(names).toEqual(["keywords", "author_email", "access_rights"]);
    expect(out.fields[0]).toEqual({ field: "keywords", label: "Keywords", value: { en: ["air"], fr: ["air"] } });
    expect(out.temporal_coverage).toHaveLength(1);
  });

  it("adds a section to Markdown, without what Markdown already shows", async () => {
    portal({ schema: SCHEMA });
    const md = await show("https://scheming-md.example.org", "markdown");
    const section = md.slice(md.indexOf("## Fields (from the portal's metadata schema)"));
    expect(section).toContain("**Keywords** (`keywords`)");
    // Markdown shows author_email and access_rights in Basic Information already
    expect(section).not.toContain("author_email");
    expect(section).not.toContain("access_rights");
    expect(md.match(/Access Rights/g)).toHaveLength(1);
  });

  it("does not hide a schema field the output cannot show (a period it cannot parse)", async () => {
    portal({ schema: SCHEMA, pkg: { ...PKG, temporal_coverage: [{ start: "2020-01-01", end: "2020-12-31" }] } });
    const out = JSON.parse(await show("https://scheming-period.example.org", "json"));
    expect(out.temporal_coverage).toEqual([]);
    expect(out.fields.map((f: { field: string }) => f.field)).toContain("temporal_coverage");
  });

  it("does not hide a structured access_rights that Markdown cannot show", async () => {
    portal({ schema: SCHEMA, pkg: { ...PKG, access_rights: { en: "Restricted", fr: "Restreint" } } });
    const md = await show("https://scheming-rights.example.org", "markdown");
    const section = md.slice(md.indexOf("## Fields (from the portal's metadata schema)"));
    expect(section).toContain("Restricted");
  });

  it.each([400, 404])("leaves the output as it was on a portal that answers %i, with no error", async (status) => {
    portal({ schemaStatus: status });
    const text = await show(`https://no-scheming-${status}.example.org`, "json");
    const out = JSON.parse(text);
    expect(out.id).toBe("p1");
    expect(out).not.toHaveProperty("fields");
  });

  it("survives a schema with a malformed entry", async () => {
    portal({ schema: { dataset_fields: [null, 5, { field_name: "keywords", label: "Keywords" }] } });
    const out = JSON.parse(await show("https://scheming-bad.example.org", "json"));
    expect(out.fields.map((f: { field: string }) => f.field)).toEqual(["keywords"]);
  });
});
