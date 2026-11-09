// Ported from ondata/ckan-mcp-server tests/integration/datastore-sql-errors.test.ts at 09e8cdc (MIT).
// Reach: the tool is called through the whole CKAN profile on the core (ckanClient). ondata
// mocked `axios.get` and `axios.post` separately; here one fake `fetch` answers per method, and
// "axios.get/post was called with" reads the fetch calls of that method (GET: the `sql` query
// parameter; POST: the JSON body). An axios rejection with a response is that status and body.
// ondata's last block already ran on its fetch branch; it stays as it was, minus hiding
// `process.versions.node` (there is one path here). Expectations unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { __setDnsResolverForTests } from "@ondata-extended/core";
import { CkanApiError, formatCkanError, makeCkanRequest } from "../src/utils/http.js";
import { ckanClient, ckanContext, stubPublicDns } from "./helpers.js";

const SERVER = "https://dati.comune.messina.it";
const OK = { success: true, result: { records: [{ n: 1 }], fields: [{ id: "n", type: "int8" }] } };

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const httpFailure = (status: number, body: unknown) => () => reply(status, body);
const success = (body: unknown) => () => reply(200, body);

// Real bodies, 2026-11-06: open.canada.ca (400) and donnees.montreal.ca (409 on GET, 200 on POST).
const NO_SQL_ENDPOINT = "Bad request - Action name not known: datastore_search_sql";
const SQL_PARAM_LOST = { success: false, error: { sql: ["Valeur manquante"], __type: "Validation Error" } };

/** A fake fetch answering GET and POST separately; `get`/`post` list the calls of each method. */
function portal(onGet: () => Response, onPost: () => Response = () => reply(599, "no POST expected")) {
  const get: { url: string; init: RequestInit }[] = [];
  const post: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    if ((init?.method ?? "GET") === "POST") { post.push(call); return onPost(); }
    get.push(call); return onGet();
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    get, post,
    getSql: (n: number) => new URL(get[n].url).searchParams.get("sql"),
    postBody: (n: number) => JSON.parse(String(post[n].init.body))
  };
}

async function runSql(sql: string): Promise<{ text: string; isError: boolean }> {
  const client = await ckanClient();
  const res = await client.callTool("ckan_datastore_search_sql", { server_url: SERVER, sql, response_format: "json" });
  return { text: res.content[0].text, isError: Boolean(res.isError) };
}

describe("ckan_datastore_search_sql errors seen in telemetry", () => {
  beforeEach(() => {
    stubPublicDns();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __setDnsResolverForTests(null);
  });

  describe("trailing semicolon", () => {
    it("is removed, because CKAN wraps the query in a subquery", async () => {
      const p = portal(success(OK));
      await runSql('SELECT 1 FROM "semi-1";  \n');
      expect(p.getSql(0)).toBe('SELECT 1 FROM "semi-1"');
    });

    it("stays when it is inside the query", async () => {
      const p = portal(success(OK));
      await runSql(`SELECT 1 FROM "semi-2" WHERE a = 'x;'`);
      expect(p.getSql(0)).toBe(`SELECT 1 FROM "semi-2" WHERE a = 'x;'`);
    });
  });

  describe("portal without the SQL endpoint", () => {
    it("says the endpoint is missing, not that the SQL is wrong", async () => {
      portal(httpFailure(400, NO_SQL_ENDPOINT));
      const { text, isError } = await runSql('SELECT 1 FROM "nosql-1"');
      expect(isError).toBe(true);
      expect(text).toContain("does not expose the SQL endpoint");
      expect(text).not.toContain("Invalid SQL syntax");
    });

    it("keeps the SQL hint on a 400 that is about the SQL", async () => {
      portal(httpFailure(400, { success: false, error: { message: "bad" } }));
      const { text } = await runSql('SELECT 1 FROM "nosql-2"');
      expect(text).toContain("Invalid SQL syntax");
    });

    it("does not reflect any other plain-string body (GHSA-6f9w)", async () => {
      portal(httpFailure(400, "internal detail, Action name not known: secret"));
      const error = await makeCkanRequest(ckanContext(), SERVER, "datastore_search_sql", { sql: "SELECT 1" }).catch((e: unknown) => e) as Error;
      expect(error.message).not.toContain("internal detail");
      expect(error.message).not.toContain("secret");
    });
  });

  it("says a portal has no DataStore when datastore_search is the unknown action", () => {
    const error = new CkanApiError("CKAN API error (400): Action name not known: datastore_search", 400, "datastore_search", SERVER, "Action name not known: datastore_search");
    const text = formatCkanError(error, "ckan_datastore_search");
    expect(text).toContain("no DataStore");
    expect(text).not.toContain("invalid field name");
  });

  describe("portal that loses the sql parameter on GET", () => {
    it("retries with POST", async () => {
      const p = portal(httpFailure(409, SQL_PARAM_LOST), success(OK));
      const { text, isError } = await runSql('SELECT 1 FROM "post-1"');
      expect(isError).toBe(false);
      expect(text).toContain('"n": 1');
      expect(p.post[0].url).toContain("/datastore_search_sql");
      expect(p.postBody(0)).toEqual({ sql: 'SELECT 1 FROM "post-1"' });
    });

    it("reports the failure when POST fails too", async () => {
      const p = portal(httpFailure(409, SQL_PARAM_LOST), httpFailure(409, SQL_PARAM_LOST));
      const { text, isError } = await runSql('SELECT 1 FROM "post-2"');
      expect(isError).toBe(true);
      expect(text).toContain("Valeur manquante");
      expect(p.post).toHaveLength(1);
    });

    it("sends a query too long for the URL by POST (414 on GET)", async () => {
      // Real case, 2026-11-07: a ~14,000-character query on donneesquebec.ca.
      const p = portal(httpFailure(414, {}), success(OK));
      const { text, isError } = await runSql('SELECT 1 FROM "post-414"');
      expect(isError).toBe(false);
      expect(text).toContain('"n": 1');
      expect(p.post).toHaveLength(1);
    });

    describe("on Workers, where the fetch branch has no axios", () => {
      const lost = () => new Response(JSON.stringify(SQL_PARAM_LOST), { status: 409 });

      function stubFetch(...responses: Response[]) {
        const fetchMock = vi.fn();
        for (const response of responses) fetchMock.mockResolvedValueOnce(response);
        vi.stubGlobal("fetch", fetchMock);
        return fetchMock;
      }

      it("sends a query too long for the URL by POST (414 on GET)", async () => {
        const fetchMock = stubFetch(new Response("", { status: 414 }), new Response(JSON.stringify(OK), { status: 200 }));
        const { isError } = await runSql('SELECT 1 FROM "post-414-w"');
        expect(isError).toBe(false);
        expect(fetchMock.mock.calls[1][1].method).toBe("POST");
      });

      it("sends the SQL in a JSON POST body", async () => {
        const fetchMock = stubFetch(lost(), new Response(JSON.stringify(OK), { status: 200 }));
        const { text, isError } = await runSql('SELECT 1 FROM "post-4"');
        expect(isError).toBe(false);
        expect(text).toContain('"n": 1');
        expect(fetchMock).toHaveBeenCalledTimes(2);

        const [getUrl, get] = fetchMock.mock.calls[0];
        expect(get.method).toBe("GET");
        expect(get.body).toBeUndefined();
        expect(new URL(getUrl).searchParams.get("sql")).toBe('SELECT 1 FROM "post-4"');

        const [postUrl, post] = fetchMock.mock.calls[1];
        expect(post.method).toBe("POST");
        expect(new Headers(post.headers).get("Content-Type")).toBe("application/json");
        expect(JSON.parse(post.body)).toEqual({ sql: 'SELECT 1 FROM "post-4"' });
        expect(new URL(postUrl).search).toBe("");
      });

      it("stops after a failed POST", async () => {
        const fetchMock = stubFetch(lost(), lost());
        const { text, isError } = await runSql('SELECT 1 FROM "post-5"');
        expect(isError).toBe(true);
        expect(text).toContain("Valeur manquante");
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    });

    it("does not retry on an SQL error", async () => {
      const p = portal(httpFailure(409, { success: false, error: { query: ["syntax error"], __type: "Validation Error" } }));
      const { isError } = await runSql('SELECT 1 FROM "post-3"');
      expect(isError).toBe(true);
      expect(p.post).toHaveLength(0);
    });
  });
});
