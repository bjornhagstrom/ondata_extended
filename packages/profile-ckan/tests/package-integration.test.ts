// Ported from ondata/ckan-mcp-server tests/integration/package.test.ts at 09e8cdc (MIT).
// Reach: the fake network moved from axios to fetch (helpers.ts). ondata read the parameters
// axios was given; here they are read from the URL the portal receives, where every value is a
// string (axios serializes numbers and booleans the same way), hence `String(...)` around the
// non-string expected values. An axios rejection with a response is that status and body; a
// bare rejection is a fetch that throws. Expectations unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __setDnsResolverForTests } from '@ondata-extended/core';
import { makeCkanRequest } from '../src/utils/http.js';
import { ckanContext, fetchedUrl, jsonResponse, mockFetch, stubPublicDns } from './helpers.js';
import { scoreDatasetRelevance, resolvePageParams, resolveDownloadUrl } from '../src/tools/package.js';
import { extractSourcePortal } from '../src/utils/url-generator.js';
import packageSearchFixture from './fixtures/responses/package-search-success.json';
import packageShowFixture from './fixtures/responses/package-show-success.json';
import notFoundError from './fixtures/errors/not-found.json';

beforeEach(() => {
  stubPublicDns();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setDnsResolverForTests(null);
});

/** The query parameters of the first request, as the portal receives them (strings). */
const sent = (fetch: ReturnType<typeof mockFetch>) => Object.fromEntries(new URL(fetchedUrl(fetch)).searchParams);

describe('ckan_package_search', () => {
  beforeEach(() => {
    stubPublicDns();
  });

  describe('basic search', () => {
    it('returns search results with basic query', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageSearchFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_search',
        { q: 'test' }
      );

      expect(result).toHaveProperty('count', 100);
      expect(result).toHaveProperty('results');
      expect(result.results).toBeInstanceOf(Array);
      expect(result.results.length).toBeGreaterThan(0);
    });

    it('returns empty results when no matches', async () => {
      const emptyResults = {
        help: 'http://demo.ckan.org/api/3/action/help_show?name=package_search',
        success: true,
        result: {
          count: 0,
          results: [],
          facets: {}
        }
      };

      const fetch = mockFetch(async () => jsonResponse(emptyResults));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_search',
        { q: 'nonexistent-dataset-xyz' }
      );

      expect(result.count).toBe(0);
      expect(result.results).toEqual([]);
    });

    it('uses default query "*:*" when q not provided', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageSearchFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_search',
        {}
      );

      const params = sent(fetch);
      expect(params).not.toHaveProperty('q');
    });
  });

  describe('pagination', () => {
    it('supports pagination with start parameter', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageSearchFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_search',
        { q: 'test', start: 10, rows: 10 }
      );

      expect(sent(fetch)).toEqual(expect.objectContaining({
        start: String(10),
        rows: String(10)
      }));
    });

    it('supports large results with max rows', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageSearchFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_search',
        { q: 'test', rows: 1000 }
      );

      expect(sent(fetch)).toEqual(expect.objectContaining({
        rows: String(1000)
      }));
    });
  });

  describe('sorting', () => {
    it('supports sorting with sort parameter', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageSearchFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_search',
        { q: 'test', sort: 'metadata_modified desc' }
      );

      expect(sent(fetch)).toEqual(expect.objectContaining({
        sort: 'metadata_modified desc'
      }));
    });

    it('supports sorting by name', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageSearchFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_search',
        { q: 'test', sort: 'name asc' }
      );

      expect(sent(fetch)).toEqual(expect.objectContaining({
        sort: 'name asc'
      }));
    });
  });

  describe('filtering', () => {
    it('supports filter queries with fq parameter', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageSearchFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_search',
        {
          q: 'test',
          fq: 'organization:example-org'
        }
      );

      expect(sent(fetch)).toEqual(expect.objectContaining({
        fq: 'organization:example-org'
      }));
    });

    it('supports multiple filter queries', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageSearchFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_search',
        {
          q: 'test',
          fq: 'organization:example-org AND res_format:CSV'
        }
      );

      expect(sent(fetch)).toEqual(expect.objectContaining({
        fq: 'organization:example-org AND res_format:CSV'
      }));
    });
  });

  describe('faceting', () => {
    it('returns facet data when requested', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageSearchFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_search',
        {
          q: 'test',
          facet_field: ['organization']
        }
      );

      expect(result).toHaveProperty('facets');
      expect(result.facets).toBeInstanceOf(Object);
    });
  });

  describe('complex queries', () => {
    it('handles complex query with multiple parameters', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageSearchFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_search',
        {
          q: 'test',
          fq: 'organization:example-org',
          sort: 'metadata_modified desc',
          start: 0,
          rows: 20,
          facet_field: ['organization', 'res_format']
        }
      );

      expect(sent(fetch)).toEqual(expect.objectContaining({
        q: 'test',
        fq: 'organization:example-org',
        sort: 'metadata_modified desc',
        start: String(0),
        rows: String(20)
      }));
    });
  });

  describe('error handling', () => {
    it('handles 404 error for invalid query', async () => {
      mockFetch(async () => jsonResponse(notFoundError, { status: 404 }));

      await expect(
        makeCkanRequest<any>(
          ckanContext(),
          'http://demo.ckan.org',
          'package_search',
          { q: 'invalid' }
        )
      ).rejects.toThrow();
    });

    it('handles server error', async () => {
      mockFetch(async () => jsonResponse({
          success: false,
          error: { message: 'Internal server error' }
        }, { status: 500 }));

      await expect(
        makeCkanRequest<any>(
          ckanContext(),
          'http://demo.ckan.org',
          'package_search',
          { q: 'test' }
        )
      ).rejects.toThrow();
    });
  });

  describe('response structure', () => {
    it('returns properly structured response', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageSearchFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_search',
        { q: 'test' }
      );

      expect(result).toHaveProperty('count');
      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('facets');
      expect(typeof result.count).toBe('number');
      expect(Array.isArray(result.results)).toBe(true);
      expect(typeof result.facets).toBe('object');
    });

    it('includes package metadata in results', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageSearchFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_search',
        { q: 'test' }
      );

      if (result.results.length > 0) {
        const pkg = result.results[0];
        expect(pkg).toHaveProperty('id');
        expect(pkg).toHaveProperty('name');
        expect(pkg).toHaveProperty('title');
      }
    });
  });
});

describe('ckan_find_relevant_datasets', () => {
  it('scores datasets with default weights', () => {
    const dataset = packageSearchFixture.result.results[0];

    const result = scoreDatasetRelevance('example dataset', dataset);

    expect(result.total).toBeGreaterThan(0);
    expect(result.breakdown.total).toBe(result.total);
    expect(result.terms).toContain('example');
  });

  it('applies custom weights', () => {
    const dataset = packageSearchFixture.result.results[0];

    const defaultScore = scoreDatasetRelevance('example dataset', dataset);
    const weightedScore = scoreDatasetRelevance('example dataset', dataset, {
      title: 10,
      notes: 0,
      tags: 0,
      organization: 0
      // ondata's tests are not typechecked; the partial weights are what it passed
    } as Parameters<typeof scoreDatasetRelevance>[2]);

    expect(weightedScore.total).toBeGreaterThan(defaultScore.total);
  });
});

describe('ckan_package_show', () => {
  beforeEach(() => {
    stubPublicDns();
  });

  describe('basic functionality', () => {
    it('returns package details for valid ID', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_show',
        { id: 'example-dataset' }
      );

      expect(result).toHaveProperty('id', 'pkg-1');
      expect(result).toHaveProperty('name', 'example-dataset');
      expect(result).toHaveProperty('title');
    });

    it('includes package metadata', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_show',
        { id: 'example-dataset' }
      );

      expect(result).toHaveProperty('author');
      expect(result).toHaveProperty('maintainer');
      expect(result).toHaveProperty('license_title');
      expect(result).toHaveProperty('metadata_created');
      expect(result).toHaveProperty('metadata_modified');
    });
  });

  describe('resources', () => {
    it('includes resources in package details', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_show',
        { id: 'example-dataset' }
      );

      expect(result).toHaveProperty('resources');
      expect(result.resources).toBeInstanceOf(Array);
      expect(result.resources.length).toBeGreaterThan(0);
    });

    it('includes resource metadata', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_show',
        { id: 'example-dataset' }
      );

      if (result.resources && result.resources.length > 0) {
        const resource = result.resources[0];
        expect(resource).toHaveProperty('id');
        expect(resource).toHaveProperty('name');
        expect(resource).toHaveProperty('url');
        expect(resource).toHaveProperty('format');
      }
    });

    it('handles packages with multiple resources', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_show',
        { id: 'example-dataset' }
      );

      expect(result.num_resources).toBeGreaterThanOrEqual(2);
      expect(result.resources.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('organization', () => {
    it('includes organization information', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_show',
        { id: 'example-dataset' }
      );

      expect(result).toHaveProperty('organization');
      expect(result.organization).toBeInstanceOf(Object);
      expect(result.organization).toHaveProperty('id');
      expect(result.organization).toHaveProperty('name');
      expect(result.organization).toHaveProperty('title');
    });
  });

  describe('tags', () => {
    it('includes tags in package details', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_show',
        { id: 'example-dataset' }
      );

      expect(result).toHaveProperty('tags');
      expect(result.tags).toBeInstanceOf(Array);
    });

    it('includes tag metadata', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_show',
        { id: 'example-dataset' }
      );

      if (result.tags && result.tags.length > 0) {
        const tag = result.tags[0];
        expect(tag).toHaveProperty('name');
        expect(tag).toHaveProperty('id');
      }
    });
  });

  describe('tracking', () => {
    it('supports include_tracking parameter', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_show',
        {
          id: 'example-dataset',
          include_tracking: true
        }
      );

      expect(sent(fetch)).toEqual(expect.objectContaining({
        include_tracking: String(true)
      }));
    });

    it('includes tracking summary when requested', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_show',
        {
          id: 'example-dataset',
          include_tracking: true
        }
      );

      expect(result).toHaveProperty('tracking_summary');
    });
  });

  describe('error handling', () => {
    it('handles 404 error for invalid package ID', async () => {
      mockFetch(async () => jsonResponse(notFoundError, { status: 404 }));

      await expect(
        makeCkanRequest<any>(
          ckanContext(),
          'http://demo.ckan.org',
          'package_show',
          { id: 'non-existent-package' }
        )
      ).rejects.toThrow();
    });

    it('handles server error when fetching package', async () => {
      mockFetch(async () => jsonResponse({
          success: false,
          error: { message: 'Internal server error' }
        }, { status: 500 }));

      await expect(
        makeCkanRequest<any>(
          ckanContext(),
          'http://demo.ckan.org',
          'package_show',
          { id: 'example-dataset' }
        )
      ).rejects.toThrow();
    });
  });

  describe('response structure', () => {
    it('returns properly structured package response', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_show',
        { id: 'example-dataset' }
      );

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('notes');
      expect(result).toHaveProperty('state');
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('resources');
    });

    it('includes optional fields when available', async () => {
      const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'http://demo.ckan.org',
        'package_show',
        { id: 'example-dataset' }
      );

      expect(result).toHaveProperty('tags');
      expect(result).toHaveProperty('organization');
      expect(result).toHaveProperty('license_title');
      expect(result).toHaveProperty('metadata_created');
      expect(result).toHaveProperty('metadata_modified');
    });
  });
});

describe('ckan_list_resources', () => {
  beforeEach(() => {
    stubPublicDns();
  });

  it('returns resources from package_show result', async () => {
    const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'package_show',
      { id: 'example-dataset' }
    );

    expect(result.resources).toBeInstanceOf(Array);
    expect(result.resources.length).toBe(2);
    expect(result.resources[0]).toHaveProperty('id', 'res-1');
    expect(result.resources[0]).toHaveProperty('format', 'CSV');
    expect(result.resources[1]).toHaveProperty('id', 'res-2');
    expect(result.resources[1]).toHaveProperty('format', 'JSON');
  });

  it('extracts resource summary fields correctly', async () => {
    const fetch = mockFetch(async () => jsonResponse(packageShowFixture));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'package_show',
      { id: 'example-dataset' }
    );

    const resource = result.resources[0];
    expect(resource).toHaveProperty('name');
    expect(resource).toHaveProperty('id');
    expect(resource).toHaveProperty('format');
    expect(resource).toHaveProperty('size');
    expect(resource).toHaveProperty('url');
  });

  it('handles dataset with datastore_active flag', async () => {
    const fixtureWithDatastore = JSON.parse(JSON.stringify(packageShowFixture));
    fixtureWithDatastore.result.resources[0].datastore_active = true;
    fixtureWithDatastore.result.resources[1].datastore_active = false;

    const fetch = mockFetch(async () => jsonResponse(fixtureWithDatastore));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'package_show',
      { id: 'example-dataset' }
    );

    expect(result.resources[0].datastore_active).toBe(true);
    expect(result.resources[1].datastore_active).toBe(false);
  });

  it('handles dataset with no resources', async () => {
    const emptyResourcesFixture = {
      ...packageShowFixture,
      result: {
        ...packageShowFixture.result,
        resources: [],
        num_resources: 0
      }
    };

    const fetch = mockFetch(async () => jsonResponse(emptyResourcesFixture));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'package_show',
      { id: 'empty-dataset' }
    );

    expect(result.resources).toEqual([]);
  });

  it('returns error for non-existent dataset', async () => {
    mockFetch(async () => {
      throw new Error('CKAN API error: Not Found');
    });

    await expect(
      makeCkanRequest<any>(ckanContext(), 'http://demo.ckan.org', 'package_show', { id: 'nonexistent' })
    ).rejects.toThrow();
  });
});

describe('source portal DataStore fallback utilities', () => {
  const UUID = '550e8400-e29b-41d4-a716-446655440000';

  it('extractSourcePortal detects a harvested resource URL from a different portal', () => {
    const resourceUrl = `https://dati.comune.milano.it/dataset/abc/resource/${UUID}/download/data.csv`;
    const result = extractSourcePortal(resourceUrl, 'https://dati.gov.it/opendata');
    expect(result).not.toBeNull();
    expect(result?.portalUrl).toBe('https://dati.comune.milano.it');
    expect(result?.resourceId).toBe(UUID);
  });

  it('extractSourcePortal returns null for same-domain URLs', () => {
    const resourceUrl = `https://dati.gov.it/opendata/dataset/abc/resource/${UUID}/download/data.csv`;
    expect(extractSourcePortal(resourceUrl, 'https://dati.gov.it/opendata')).toBeNull();
  });

  it('checkSourceDatastore returns true when source portal datastore_search succeeds', async () => {
    mockFetch(async () => jsonResponse(
      { success: true, result: { fields: [], records: [], total: 0 } }
    ));
    const active = await makeCkanRequest<any>(
      ckanContext(),
      'https://dati.comune.milano.it',
      'datastore_search',
      { resource_id: UUID, limit: 0 }
    ).then(() => true).catch(() => false);
    expect(active).toBe(true);
  });

  it('checkSourceDatastore returns false when source portal datastore_search fails', async () => {
    mockFetch(async () => jsonResponse({}, { status: 404 }));
    const active = await makeCkanRequest<any>(
      ckanContext(),
      'https://dati.comune.milano.it',
      'datastore_search',
      { resource_id: UUID, limit: 0 }
    ).then(() => true).catch(() => false);
    expect(active).toBe(false);
  });

  it('resolveDownloadUrl prefers download_url over url', () => {
    const resource = { download_url: 'https://a.com/file.csv', url: 'https://b.com/page', access_url: '' } as any;
    expect(resolveDownloadUrl(resource)).toBe('https://a.com/file.csv');
  });
});

describe('resolvePageParams', () => {
  it('page=1 page_size=5 → start=0 rows=5', () => {
    expect(resolvePageParams(1, 5, 0, 10)).toEqual({ effectiveStart: 0, effectiveRows: 5 });
  });

  it('page=2 page_size=5 → start=5 rows=5', () => {
    expect(resolvePageParams(2, 5, 0, 10)).toEqual({ effectiveStart: 5, effectiveRows: 5 });
  });

  it('page=3 page_size=10 → start=20 rows=10', () => {
    expect(resolvePageParams(3, 10, 0, 10)).toEqual({ effectiveStart: 20, effectiveRows: 10 });
  });

  it('without page, start/rows used as-is', () => {
    expect(resolvePageParams(undefined, 10, 15, 7)).toEqual({ effectiveStart: 15, effectiveRows: 7 });
  });
});
