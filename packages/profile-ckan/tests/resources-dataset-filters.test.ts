// Ported from ondata/ckan-mcp-server tests/unit/resources-dataset-filters.test.ts at 09e8cdc (MIT).
// Reach: the resources are specs (found by name) instead of register functions; makeCkanRequest
// takes the context first (`expect.anything()`); the mock keeps the module's other exports.
// Expectations unchanged.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CKAN_RESOURCES } from "../src/resources/index.js";
import { makeCkanRequest } from "../src/utils/http.js";
import { ckanContext } from "./helpers.js";

vi.mock("../src/utils/http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/http.js")>()),
  makeCkanRequest: vi.fn()
}));

// ondata registered each filter resource with its own function; here they are specs, found by name
const registerGroupDatasetsResource = "ckan-group-datasets";
const registerOrganizationDatasetsResource = "ckan-organization-datasets";
const registerTagDatasetsResource = "ckan-tag-datasets";
const registerFormatDatasetsResource = "ckan-format-datasets";

type ResourceHandler = (
  uri: URL,
  variables: Record<string, string | undefined>
) => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>;

const getHandler = (name: string): ResourceHandler => {
  // variables typed loosely, as ondata's handler took them
  const spec = CKAN_RESOURCES.find((r) => r.name === name);
  if (!spec) {
    throw new Error("Resource handler was not registered");
  }
  const ctx = ckanContext();
  return (uri, variables) => spec.read(uri, variables as Record<string, string>, ctx) as ReturnType<ResourceHandler>;
};

describe("dataset filter resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cases = [
    {
      label: "group",
      register: registerGroupDatasetsResource,
      uri: "ckan://demo.ckan.org/group/ambiente/datasets",
      variables: { name: "ambiente" },
      expectedFq: 'groups:"ambiente"'
    },
    {
      label: "organization",
      register: registerOrganizationDatasetsResource,
      uri: "ckan://demo.ckan.org/organization/regione-toscana/datasets",
      variables: { name: "regione-toscana" },
      expectedFq: 'organization:"regione-toscana"'
    },
    {
      label: "tag",
      register: registerTagDatasetsResource,
      uri: "ckan://demo.ckan.org/tag/turismo/datasets",
      variables: { name: "turismo" },
      expectedFq: 'tags:"turismo"'
    },
    {
      label: "format",
      register: registerFormatDatasetsResource,
      uri: "ckan://demo.ckan.org/format/csv/datasets",
      variables: { format: "csv" },
      expectedFq: '(res_format:"csv" OR res_format:"CSV" OR distribution_format:"csv" OR distribution_format:"CSV")'
    }
  ];

  it.each(cases)("builds package_search fq for $label", async ({ register, uri, variables, expectedFq }) => {
    vi.mocked(makeCkanRequest).mockResolvedValueOnce({ count: 1, results: [] });
    const handler = getHandler(register);

    const response = await handler(new URL(uri), variables);

    expect(makeCkanRequest).toHaveBeenCalledWith(expect.anything(), "https://demo.ckan.org", "package_search", {
      q: "*:*",
      fq: expectedFq
    });
    expect(response.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(response.contents[0].text)).toEqual({ count: 1, results: [] });
  });

  it("escapes quotes in filter values", async () => {
    vi.mocked(makeCkanRequest).mockResolvedValueOnce({ count: 0, results: [] });
    const handler = getHandler(registerTagDatasetsResource);

    await handler(new URL("ckan://demo.ckan.org/tag/data\"set/datasets"), { name: "data\"set" });

    expect(makeCkanRequest).toHaveBeenCalledWith(expect.anything(), "https://demo.ckan.org", "package_search", {
      q: "*:*",
      fq: 'tags:"data\\"set"'
    });
  });

  it("returns text error on failure", async () => {
    vi.mocked(makeCkanRequest).mockRejectedValueOnce(new Error("boom"));
    const handler = getHandler(registerGroupDatasetsResource);

    const response = await handler(new URL("ckan://demo.ckan.org/group/test/datasets"), { name: "test" });

    expect(response.contents[0].mimeType).toBe("text/plain");
    expect(response.contents[0].text).toContain("Error fetching datasets: boom");
  });
});
