// Ported from ondata/ckan-mcp-server tests/integration/group.test.ts at 09e8cdc (MIT).
// Reach: the fake network moved from axios to fetch (helpers.ts); expectations unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeCkanRequest } from '../src/utils/http.js';
import { ckanContext, jsonResponse, mockFetch, stubPublicDns } from './helpers.js';
import { __setDnsResolverForTests } from '@ondata-extended/core';
import groupListFixture from './fixtures/responses/group-list-success.json';
import groupShowFixture from './fixtures/responses/group-show-success.json';
import groupSearchFixture from './fixtures/responses/group-search-success.json';

afterEach(() => {
  vi.unstubAllGlobals();
  __setDnsResolverForTests(null);
});

describe('ckan_group_list', () => {
  beforeEach(() => {
    stubPublicDns();
  });

  it('returns list of groups', async () => {
    mockFetch(async () => jsonResponse(groupListFixture));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'group_list',
      {}
    );

    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty('id');
    expect(result[0]).toHaveProperty('name');
    expect(result[0]).toHaveProperty('title');
  });

  it('handles empty group list', async () => {
    const emptyResults = {
      help: 'http://demo.ckan.org/api/3/action/help_show?name=group_list',
      success: true,
      result: []
    };

    mockFetch(async () => jsonResponse(emptyResults));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'group_list',
      {}
    );

    expect(result).toEqual([]);
  });
});

describe('ckan_group_show', () => {
  beforeEach(() => {
    stubPublicDns();
  });

  it('returns group details for valid ID', async () => {
    mockFetch(async () => jsonResponse(groupShowFixture));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'group_show',
      { id: 'environment' }
    );

    expect(result).toHaveProperty('id', 'group-1');
    expect(result).toHaveProperty('name', 'environment');
    expect(result).toHaveProperty('title', 'Environment');
  });

  it('includes datasets list', async () => {
    mockFetch(async () => jsonResponse(groupShowFixture));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'group_show',
      { id: 'environment' }
    );

    expect(result).toHaveProperty('packages');
    expect(result.packages).toBeInstanceOf(Array);
  });
});

describe('ckan_group_search', () => {
  beforeEach(() => {
    stubPublicDns();
  });

  it('searches groups by pattern', async () => {
    mockFetch(async () => jsonResponse(groupSearchFixture));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'package_search',
      { q: 'groups:env*', rows: 0 }
    );

    expect(result).toHaveProperty('count');
    expect(result).toHaveProperty('search_facets');
  });
});
