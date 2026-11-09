// Ported from ondata/ckan-mcp-server tests/integration/resources.test.ts at 09e8cdc (MIT).
// Reach: axios mock → fake fetch (helpers.ts); URL and parameters read from the request the portal
// receives (the query string, so a boolean is compared as the string sent). Expectations unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeCkanRequest } from '../src/utils/http.js';
import { ckanContext, fetchedUrl, jsonResponse, mockFetch, stubPublicDns } from './helpers.js';
import { __setDnsResolverForTests } from '@ondata-extended/core';
import packageShowFixture from './fixtures/responses/package-show-success.json';
import resourceShowFixture from './fixtures/responses/resource-show-success.json';
import organizationShowFixture from './fixtures/responses/organization-show-success.json';

let fetch: ReturnType<typeof mockFetch>;

afterEach(() => {
  vi.unstubAllGlobals();
  __setDnsResolverForTests(null);
});

describe('MCP Resources', () => {
  beforeEach(() => {
    stubPublicDns();
  });

  describe('dataset resource', () => {
    it('fetches dataset metadata via package_show', async () => {
      fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'https://demo.ckan.org',
        'package_show',
        { id: 'example-dataset' }
      );

      expect(result).toHaveProperty('id', 'pkg-1');
      expect(result).toHaveProperty('name', 'example-dataset');
      expect(result).toHaveProperty('title', 'Example Dataset');
      expect(result).toHaveProperty('resources');
      expect(result.resources).toBeInstanceOf(Array);
    });

    it('includes organization metadata', async () => {
      fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'https://demo.ckan.org',
        'package_show',
        { id: 'example-dataset' }
      );

      expect(result.organization).toHaveProperty('id');
      expect(result.organization).toHaveProperty('name');
      expect(result.organization).toHaveProperty('title');
    });

    it('includes tags', async () => {
      fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'https://demo.ckan.org',
        'package_show',
        { id: 'example-dataset' }
      );

      expect(result.tags).toBeInstanceOf(Array);
      expect(result.tags.length).toBeGreaterThan(0);
      expect(result.tags[0]).toHaveProperty('name');
    });
  });

  describe('resource resource', () => {
    it('fetches resource metadata via resource_show', async () => {
      fetch = mockFetch(async () => jsonResponse(resourceShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'https://demo.ckan.org',
        'resource_show',
        { id: 'res-1' }
      );

      expect(result).toHaveProperty('id', 'res-1');
      expect(result).toHaveProperty('name', 'example-resource.csv');
      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('format', 'CSV');
    });

    it('includes datastore status', async () => {
      fetch = mockFetch(async () => jsonResponse(resourceShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'https://demo.ckan.org',
        'resource_show',
        { id: 'res-1' }
      );

      expect(result).toHaveProperty('datastore_active', true);
    });

    it('includes file metadata', async () => {
      fetch = mockFetch(async () => jsonResponse(resourceShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'https://demo.ckan.org',
        'resource_show',
        { id: 'res-1' }
      );

      expect(result).toHaveProperty('size');
      expect(result).toHaveProperty('mimetype');
      expect(result).toHaveProperty('hash');
    });
  });

  describe('organization resource', () => {
    it('fetches organization metadata via organization_show', async () => {
      fetch = mockFetch(async () => jsonResponse(organizationShowFixture));

      const result = await makeCkanRequest<any>(
        ckanContext(),
        'https://demo.ckan.org',
        'organization_show',
        { id: 'example-org', include_datasets: false }
      );

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('title');
    });

    it('can exclude datasets from response', async () => {
      fetch = mockFetch(async () => jsonResponse(organizationShowFixture));

      await makeCkanRequest<any>(ckanContext(), 'https://demo.ckan.org', 'organization_show', {
        id: 'example-org',
        include_datasets: false,
      });

      // the parameters as the portal receives them (ondata: what its client was handed)
      expect(Object.fromEntries(new URL(fetchedUrl(fetch)).searchParams)).toEqual({ id: 'example-org', include_datasets: String(false) });
    });
  });

  describe('API calls', () => {
    it('constructs correct URL for package_show', async () => {
      fetch = mockFetch(async () => jsonResponse(packageShowFixture));

      await makeCkanRequest<any>(ckanContext(), 'https://demo.ckan.org', 'package_show', {
        id: 'test-id',
      });

      expect(fetchedUrl(fetch).split('?')[0]).toBe('https://demo.ckan.org/api/3/action/package_show');
    });

    it('constructs correct URL for resource_show', async () => {
      fetch = mockFetch(async () => jsonResponse(resourceShowFixture));

      await makeCkanRequest<any>(ckanContext(), 'https://demo.ckan.org', 'resource_show', {
        id: 'res-id',
      });

      expect(fetchedUrl(fetch).split('?')[0]).toBe('https://demo.ckan.org/api/3/action/resource_show');
    });

    it('constructs correct URL for organization_show', async () => {
      fetch = mockFetch(async () => jsonResponse(organizationShowFixture));

      await makeCkanRequest<any>(ckanContext(), 'https://demo.ckan.org', 'organization_show', {
        id: 'org-name',
      });

      expect(fetchedUrl(fetch).split('?')[0]).toBe('https://demo.ckan.org/api/3/action/organization_show');
    });
  });
});
