// Ported from ondata/ckan-mcp-server tests/integration/status.test.ts at 09e8cdc (MIT).
// Reach: the fake network moved from axios to fetch (helpers.ts); expectations unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeCkanRequest } from '../src/utils/http.js';
import { ckanContext, jsonResponse, mockFetch, stubPublicDns } from './helpers.js';
import { __setDnsResolverForTests } from '@ondata-extended/core';
import statusSuccess from './fixtures/responses/status-success.json';

afterEach(() => {
  vi.unstubAllGlobals();
  __setDnsResolverForTests(null);
});

describe('ckan_status_show integration', () => {
  beforeEach(() => {
    stubPublicDns();
  });

  it('returns markdown formatted status information', async () => {
    mockFetch(async () => jsonResponse(statusSuccess));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'status_show'
    );

    expect(result).toHaveProperty('ckan_version', '2.10.1');
    expect(result).toHaveProperty('site_title', 'CKAN Demo');
    expect(result).toHaveProperty('site_url', 'http://demo.ckan.org');
  });

  it('handles missing optional fields gracefully', async () => {
    const minimalStatus = {
      help: 'http://demo.ckan.org/api/3/action/help_show?name=ckan_status_show',
      success: true,
      result: {
        ckan_version: '2.10.0',
        offline: false
      }
    };

    mockFetch(async () => jsonResponse(minimalStatus));

    const result = await makeCkanRequest<any>(
      ckanContext(),
      'http://demo.ckan.org',
      'status_show'
    );

    expect(result).toHaveProperty('ckan_version', '2.10.0');
    expect(result).toHaveProperty('offline', false);
  });
});
