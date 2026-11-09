// Ported from ondata/ckan-mcp-server tests/integration/organization.test.ts at 09e8cdc (MIT).
// Reach: the fake network moved from axios to fetch (helpers.ts); expectations unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeCkanRequest } from '../src/utils/http.js';
import { ckanContext, jsonResponse, mockFetch, stubPublicDns } from './helpers.js';
import { __setDnsResolverForTests } from '@ondata-extended/core';
import orgListFixture from './fixtures/responses/organization-list-success.json';
import orgShowFixture from './fixtures/responses/organization-show-success.json';
import orgSearchFixture from './fixtures/responses/organization-search-success.json';

afterEach(() => {
  vi.unstubAllGlobals();
  __setDnsResolverForTests(null);
});

describe('ckan_organization_list', () => {
  beforeEach(() => {
    stubPublicDns();
  });

  it('returns list of organizations', async () => {
    mockFetch(async () => jsonResponse(orgListFixture));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'organization_list',
      {}
    );

    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty('id');
    expect(result[0]).toHaveProperty('name');
    expect(result[0]).toHaveProperty('title');
  });

  it('handles empty organization list', async () => {
    const emptyResults = {
      help: 'http://demo.ckan.org/api/3/action/help_show?name=organization_list',
      success: true,
      result: []
    };

    mockFetch(async () => jsonResponse(emptyResults));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'organization_list',
      {}
    );

    expect(result).toEqual([]);
  });
});

describe('ckan_organization_show', () => {
  beforeEach(() => {
    stubPublicDns();
  });

  it('returns organization details for valid ID', async () => {
    mockFetch(async () => jsonResponse(orgShowFixture));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'organization_show',
      { id: 'example-org' }
    );

    expect(result).toHaveProperty('id', 'org-1');
    expect(result).toHaveProperty('name', 'example-org');
    expect(result).toHaveProperty('title', 'Example Organization');
  });

  it('includes organization metadata', async () => {
    mockFetch(async () => jsonResponse(orgShowFixture));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'organization_show',
      { id: 'example-org' }
    );

    expect(result).toHaveProperty('package_count');
    expect(result).toHaveProperty('created');
    expect(result).toHaveProperty('state');
    expect(result).toHaveProperty('users');
    expect(result).toHaveProperty('packages');
  });
});

describe('ckan_organization_search', () => {
  beforeEach(() => {
    stubPublicDns();
  });

  it('searches organizations by pattern', async () => {
    mockFetch(async () => jsonResponse(orgSearchFixture));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'package_search',
      { q: 'organization:example*', rows: 0 }
    );

    expect(result).toHaveProperty('count');
    expect(result).toHaveProperty('results');
  });

  it('handles empty search results', async () => {
    const emptyResults = {
      help: 'http://demo.ckan.org/api/3/action/help_show?name=package_search',
      success: true,
      result: {
        count: 0,
        results: [],
        facets: {}
      }
    };

    mockFetch(async () => jsonResponse(emptyResults));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'package_search',
      { q: 'organization:nonexistent*', rows: 0 }
    );

    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });
});
