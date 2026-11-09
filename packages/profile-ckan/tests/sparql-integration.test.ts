// Ported from ondata/ckan-mcp-server tests/integration/sparql.test.ts at 09e8cdc (MIT).
// Reach (docs/test-parity.md, principle 1): `querySparqlEndpoint` takes the engine context first;
// the fake `fetch` answers with real `Response` objects instead of hand-built `{ ok, status,
// headers: { get }, json }` objects, because the core client reads status, headers and the body
// stream of what fetch returns; the request is asserted on the headers the core hands to fetch
// (a `Headers` object, read through `fetchedHeaders`) instead of a plain header object. The
// expected values are ondata's.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { formatSparqlMarkdown, formatSparqlJson, querySparqlEndpoint as querySparqlEndpointWithCtx, validateSelectQuery, injectLimit } from '../src/tools/sparql.js';
import { __setDnsResolverForTests } from '@ondata-extended/core';
import { ckanContext, fetchedHeaders } from './helpers.js';

const querySparqlEndpoint = (endpointUrl: string, query: string) => querySparqlEndpointWithCtx(ckanContext(), endpointUrl, query);

/** A redirect as fetch returns it with `redirect: "manual"`. */
const redirect = (status: number, location: string) => new Response(null, { status, statusText: status === 302 ? 'Found' : 'Moved', headers: { location } });

describe('sparql_query', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.clearAllMocks();
    // Default: resolve every hostname to a public IP so tests stay offline.
    __setDnsResolverForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    __setDnsResolverForTests(null);
  });

  const mockFetch = (payload: unknown, ok = true, status = 200) => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(JSON.stringify(payload), {
      status,
      statusText: ok ? 'OK' : 'Bad Request'
    }));
  };

  const sampleSparqlResponse = {
    head: { vars: ['publisherName', 'count'] },
    results: {
      bindings: [
        { publisherName: { type: 'literal', value: 'ISTAT' }, count: { type: 'literal', value: '42' } },
        { publisherName: { type: 'literal', value: 'ISPRA' }, count: { type: 'literal', value: '10' } }
      ]
    }
  };

  describe('querySparqlEndpoint', () => {
    it('sends POST with sparql-query content-type and accepts json', async () => {
      mockFetch(sampleSparqlResponse);

      await querySparqlEndpoint('https://data.europa.eu/sparql', 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1');

      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      expect(fetchMock).toHaveBeenCalledWith(
        'https://data.europa.eu/sparql',
        expect.objectContaining({
          method: 'POST',
          body: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1'
        })
      );
      expect(fetchedHeaders(fetchMock as never)).toEqual(expect.objectContaining({
        'content-type': 'application/sparql-query; charset=utf-8',
        'accept': 'application/sparql-results+json'
      }));
    });

    it('returns parsed SPARQL results', async () => {
      mockFetch(sampleSparqlResponse);

      const result = await querySparqlEndpoint('https://data.europa.eu/sparql', 'SELECT * WHERE { }');

      expect(result.head.vars).toEqual(['publisherName', 'count']);
      expect(result.results.bindings).toHaveLength(2);
      expect(result.results.bindings[0].publisherName.value).toBe('ISTAT');
    });

    it('rejects non-HTTPS endpoints', async () => {
      await expect(
        querySparqlEndpoint('http://insecure.example.com/sparql', 'SELECT * WHERE { }')
      ).rejects.toThrow('Only HTTPS endpoints are allowed');
    });

    it('rejects private IP endpoints (SSRF prevention)', async () => {
      await expect(
        querySparqlEndpoint('https://169.254.169.254/sparql', 'SELECT * WHERE { }')
      ).rejects.toThrow('private/internal');
    });

    it('rejects hostnames that RESOLVE to an internal IP (DNS-name bypass)', async () => {
      __setDnsResolverForTests(async () => [{ address: '127.0.0.1', family: 4 }]);
      await expect(
        querySparqlEndpoint('https://internal.lvh.me/sparql', 'SELECT * WHERE { }')
      ).rejects.toThrow('private/internal');
    });

    it('does NOT follow a redirect to an internal host (redirect SSRF)', async () => {
      // Public endpoint resolves fine, but 302-redirects to cloud metadata.
      __setDnsResolverForTests(async (hostname: string) =>
        hostname === '169.254.169.254'
          ? [{ address: '169.254.169.254', family: 4 }]
          : [{ address: '93.184.216.34', family: 4 }]
      );
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => redirect(302, 'https://169.254.169.254/latest/meta-data/'));

      await expect(
        querySparqlEndpoint('https://attacker.example/sparql', 'SELECT * WHERE { }')
      ).rejects.toThrow('private/internal');
    });

    it('rejects a redirect to a non-HTTPS URL', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => redirect(301, 'http://data.europa.eu/sparql'));

      await expect(
        querySparqlEndpoint('https://data.europa.eu/sparql', 'SELECT * WHERE { }')
      ).rejects.toThrow('non-HTTPS');
    });

    it('throws on HTTP error response', async () => {
      mockFetch({ error: 'bad query' }, false, 400);

      await expect(
        querySparqlEndpoint('https://data.europa.eu/sparql', 'INVALID QUERY')
      ).rejects.toThrow('SPARQL endpoint error (400)');
    });

    it('throws on network error', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network failure'));

      await expect(
        querySparqlEndpoint('https://data.europa.eu/sparql', 'SELECT * WHERE { }')
      ).rejects.toThrow('Network failure');
    });
  });

  describe('formatSparqlMarkdown', () => {
    it('renders a markdown table with header and rows', () => {
      const md = formatSparqlMarkdown(sampleSparqlResponse, 'https://example.com/sparql');

      expect(md).toContain('# SPARQL Query Results');
      expect(md).toContain('**Endpoint**: https://example.com/sparql');
      expect(md).toContain('**Rows**: 2');
      expect(md).toContain('| publisherName | count |');
      expect(md).toContain('| ISTAT | 42 |');
      expect(md).toContain('| ISPRA | 10 |');
    });

    it('shows no results message when bindings is empty', () => {
      const empty = { head: { vars: ['s'] }, results: { bindings: [] } };
      const md = formatSparqlMarkdown(empty, 'https://example.com/sparql');

      expect(md).toContain('**Rows**: 0');
      expect(md).toContain('_No results_');
    });

    it('escapes pipe characters in values', () => {
      const data = {
        head: { vars: ['label'] },
        results: { bindings: [{ label: { type: 'literal', value: 'foo|bar' } }] }
      };
      const md = formatSparqlMarkdown(data, 'https://example.com/sparql');

      expect(md).toContain('foo\\|bar');
    });

    it('handles missing binding values with empty string', () => {
      const data = {
        head: { vars: ['a', 'b'] },
        results: { bindings: [{ a: { type: 'literal', value: 'only-a' } }] }
      };
      const md = formatSparqlMarkdown(data, 'https://example.com/sparql');

      expect(md).toContain('| only-a |  |');
    });
  });

  describe('validateSelectQuery', () => {
    it('accepts a plain SELECT query', () => {
      expect(() => validateSelectQuery('SELECT ?s WHERE { ?s ?p ?o }')).not.toThrow();
    });

    it('accepts SELECT with PREFIX declarations before it', () => {
      expect(() => validateSelectQuery('PREFIX ex: <http://example.org/>\nSELECT ?s WHERE { }')).not.toThrow();
    });

    it('accepts SELECT case-insensitively', () => {
      expect(() => validateSelectQuery('select ?s where { }')).not.toThrow();
    });

    it('rejects a CONSTRUCT query', () => {
      expect(() => validateSelectQuery('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }')).toThrow('Only SELECT queries are supported');
    });

    it('rejects an ASK query', () => {
      expect(() => validateSelectQuery('ASK { ?s ?p ?o }')).toThrow('Only SELECT queries are supported');
    });

    it('rejects a query with no keyword', () => {
      expect(() => validateSelectQuery('{ ?s ?p ?o }')).toThrow('Only SELECT queries are supported');
    });

    it('ignores SELECT in a comment', () => {
      expect(() => validateSelectQuery('# SELECT ?s WHERE { }\nCONSTRUCT { } WHERE { }')).toThrow('Only SELECT queries are supported');
    });
  });

  describe('injectLimit', () => {
    it('appends LIMIT when not present', () => {
      const result = injectLimit('SELECT ?s WHERE { ?s ?p ?o }', 50);
      expect(result).toContain('LIMIT 50');
    });

    it('does not inject LIMIT when already present', () => {
      const query = 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 10';
      expect(injectLimit(query, 50)).toBe(query);
    });

    it('detects LIMIT case-insensitively', () => {
      const query = 'SELECT ?s WHERE { ?s ?p ?o } limit 5';
      expect(injectLimit(query, 50)).toBe(query);
    });

    it('trims trailing whitespace before appending LIMIT', () => {
      const result = injectLimit('SELECT ?s WHERE { ?s ?p ?o }   ', 100);
      expect(result).toMatch(/\}\nLIMIT 100$/);
    });
  });

  describe('formatSparqlJson', () => {
    it('returns count, columns, and rows', () => {
      const result = formatSparqlJson(sampleSparqlResponse);

      expect(result.count).toBe(2);
      expect(result.columns).toEqual(['publisherName', 'count']);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual({ publisherName: 'ISTAT', count: '42' });
    });

    it('returns empty rows array when no bindings', () => {
      const empty = { head: { vars: ['s'] }, results: { bindings: [] } };
      const result = formatSparqlJson(empty);

      expect(result.count).toBe(0);
      expect(result.rows).toEqual([]);
    });

    it('fills missing bindings with empty string', () => {
      const data = {
        head: { vars: ['a', 'b'] },
        results: { bindings: [{ a: { type: 'literal', value: 'val-a' } }] }
      };
      const result = formatSparqlJson(data);

      expect(result.rows[0]).toEqual({ a: 'val-a', b: '' });
    });
  });
});
