// Ported from ondata/ckan-mcp-server tests/integration/datastore.test.ts at 09e8cdc (MIT).
// Reach: the fake network moved from axios to fetch (helpers.ts). ondata read the parameters
// axios was given (`params.limit === 50`); here they are read from the URL the portal receives,
// where every value is a string (axios serializes 50 to "50" too), hence `String(...)` around
// the expected values. An axios rejection with a response is that status and body; ECONNABORTED
// is a fetch that never answers until a 50 ms CKAN_TIMEOUT_MS aborts it. Expectations unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __setDnsResolverForTests } from '@ondata-extended/core';
import { makeCkanRequest } from '../src/utils/http.js';
import { ckanContext, ckanEngine, fetchedUrl, jsonResponse, mockFetch, stubPublicDns } from './helpers.js';
import datastoreFixture from './fixtures/responses/datastore-search-success.json';
import datastoreSqlFixture from './fixtures/responses/datastore-search-sql-success.json';
import notFoundError from './fixtures/errors/not-found.json';

afterEach(() => {
  vi.unstubAllGlobals();
  __setDnsResolverForTests(null);
});

/** The query parameters of the first request, as the portal receives them (strings). */
const sent = (fetch: ReturnType<typeof mockFetch>) => Object.fromEntries(new URL(fetchedUrl(fetch)).searchParams);

/** A fetch that answers only when aborted (the 30 s timeout, shortened by CKAN_TIMEOUT_MS). */
const hang = (_input: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

describe('ckan_datastore_search', () => {
  beforeEach(() => {
    stubPublicDns();
  });

  describe('basic functionality', () => {
    it('returns DataStore records for valid resource_id', async () => {
      const fetch = mockFetch(async () => jsonResponse(datastoreFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        { resource_id: 'res-1' }
      );

      expect(result).toHaveProperty('resource_id', 'res-1');
      expect(result).toHaveProperty('fields');
      expect(result).toHaveProperty('records');
      expect(result).toHaveProperty('total');
    });

    it('returns records array', async () => {
      const fetch = mockFetch(async () => jsonResponse(datastoreFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        { resource_id: 'res-1' }
      );

      expect(result.records).toBeInstanceOf(Array);
      expect(result.records.length).toBeGreaterThan(0);
    });

    it('includes field metadata', async () => {
      const fetch = mockFetch(async () => jsonResponse(datastoreFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        { resource_id: 'res-1' }
      );

      expect(result.fields).toBeInstanceOf(Array);
      expect(result.fields.length).toBeGreaterThan(0);
    });
  });

  describe('sorting', () => {
    it('supports sort parameter', async () => {
      const fetch = mockFetch(async () => jsonResponse(datastoreFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        {
          resource_id: 'res-1',
          sort: 'popolazione desc'
        }
      );

      const params = sent(fetch);
      expect(params.sort).toBe('popolazione desc');
    });
  });

  describe('pagination', () => {
    it('supports limit parameter', async () => {
      const fetch = mockFetch(async () => jsonResponse(datastoreFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        {
          resource_id: 'res-1',
          limit: 50
        }
      );

      const params = sent(fetch);
      expect(params.limit).toBe(String(50));
    });

    it('supports offset parameter', async () => {
      const fetch = mockFetch(async () => jsonResponse(datastoreFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        {
          resource_id: 'res-1',
          offset: 100
        }
      );

      const params = sent(fetch);
      expect(params.offset).toBe(String(100));
    });

    it('supports combined limit and offset', async () => {
      const fetch = mockFetch(async () => jsonResponse(datastoreFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        {
          resource_id: 'res-1',
          limit: 50,
          offset: 100
        }
      );

      const params = sent(fetch);
      expect(params.limit).toBe(String(50));
      expect(params.offset).toBe(String(100));
    });
  });

  describe('queries', () => {
    it('supports full-text search with q parameter', async () => {
      const fetch = mockFetch(async () => jsonResponse(datastoreFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        {
          resource_id: 'res-1',
          q: 'test query'
        }
      );

      expect(sent(fetch)).toEqual(expect.objectContaining({ q: 'test query' }));
    });

    it('handles empty query results', async () => {
      const emptyResults = {
        help: 'http://demo.ckan.org/api/3/action/help_show?name=datastore_search',
        success: true,
        result: {
          resource_id: 'res-1',
          fields: [
            { id: '_id', type: 'int4' },
            { id: 'name', type: 'text' },
            { id: 'value', type: 'numeric' }
          ],
          records: [],
          records_format: 'objects',
          total: 0,
          filters: {},
          q: '',
          limit: 100,
          offset: 0,
          fields_order: ['_id', 'name', 'value'],
          include_total: true,
          total_estimation_threshold: null
        }
      };

      const fetch = mockFetch(async () => jsonResponse(emptyResults));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        { resource_id: 'res-1', q: 'nonexistent' }
      );

      expect(result.total).toBe(0);
      expect(result.records).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('handles 404 error for invalid resource_id', async () => {
      mockFetch(async () => jsonResponse(notFoundError, { status: 404 }));

      await expect(
        makeCkanRequest<any>(
          ckanContext(),
          'http://demo.ckan.org',
          'datastore_search',
          { resource_id: 'invalid-resource' }
        )
      ).rejects.toThrow();
    });

    it('handles server error when querying DataStore', async () => {
      mockFetch(async () => jsonResponse({
        success: false,
        error: { message: 'Internal server error' }
      }, { status: 500 }));

      await expect(
        makeCkanRequest<any>(
          ckanContext(),
          'http://demo.ckan.org',
          'datastore_search',
          { resource_id: 'res-1' }
        )
      ).rejects.toThrow();
    });

    it('handles timeout when querying DataStore', async () => {
      mockFetch(hang as never);

      await expect(
        makeCkanRequest<any>(
          ckanContext(ckanEngine({ CKAN_TIMEOUT_MS: '50' })),
          'http://demo.ckan.org',
          'datastore_search',
          { resource_id: 'res-1' }
        )
      ).rejects.toThrow();
    });
  });

  describe('response structure', () => {
    it('returns properly structured DataStore response', async () => {
      const fetch = mockFetch(async () => jsonResponse(datastoreFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        { resource_id: 'res-1' }
      );

      expect(result).toHaveProperty('resource_id');
      expect(result).toHaveProperty('fields');
      expect(result).toHaveProperty('records');
      expect(result).toHaveProperty('records_format');
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('filters');
    });

    it('includes record metadata', async () => {
      const fetch = mockFetch(async () => jsonResponse(datastoreFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        { resource_id: 'res-1' }
      );

      if (result.records && result.records.length > 0) {
        const record = result.records[0];
        expect(record).toHaveProperty('_id');
        expect(record).toHaveProperty('name');
        expect(record).toHaveProperty('value');
        expect(record).toHaveProperty('date');
      }
    });

    it('includes field metadata', async () => {
      const fetch = mockFetch(async () => jsonResponse(datastoreFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        { resource_id: 'res-1' }
      );

      if (result.fields && result.fields.length > 0) {
        const field = result.fields[0];
        expect(field).toHaveProperty('id');
        expect(field).toHaveProperty('type');
      }
    });
  });



  describe('max limits', () => {
    it('supports maximum limit of 32000', async () => {
      const fetch = mockFetch(async () => jsonResponse(datastoreFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        {
          resource_id: 'res-1',
          limit: 32000
        }
      );

      expect(sent(fetch)).toEqual(expect.objectContaining({ limit: String(32000) }));
    });

    it('handles very large result sets', async () => {
      const largeResults = {
        ...datastoreFixture,
        result: {
          ...datastoreFixture.result,
          total: 50000,
          records: Array(50000).fill(datastoreFixture.result.records[0])
        }
      };

      const fetch = mockFetch(async () => jsonResponse(largeResults));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'datastore_search',
        { resource_id: 'res-1' }
      );

      expect(result.total).toBe(50000);
      expect(result.records.length).toBe(50000);
    });
  });
});

describe('ckan_datastore_search_sql', () => {
  beforeEach(() => {
    stubPublicDns();
  });

  it('returns records for SQL query', async () => {
    const fetch = mockFetch(async () => jsonResponse(datastoreSqlFixture));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'datastore_search_sql',
      { sql: 'SELECT country, COUNT(*) AS total FROM "res-1" GROUP BY country' }
    );

    expect(result).toHaveProperty('records');
    expect(result).toHaveProperty('fields');
    expect(result.records.length).toBeGreaterThan(0);
  });

  it('passes SQL parameter to API', async () => {
    const fetch = mockFetch(async () => jsonResponse(datastoreSqlFixture));

    await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'datastore_search_sql',
      { sql: 'SELECT * FROM "res-1" LIMIT 5' }
    );

    const params = sent(fetch);
    expect(params.sql).toBe('SELECT * FROM "res-1" LIMIT 5');
  });
});
