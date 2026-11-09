// Ported from ondata/ckan-mcp-server tests/unit/tag.test.ts at 09e8cdc (MIT). Reach: import paths only.
import { describe, it, expect } from 'vitest';
import tagListFixture from './fixtures/responses/tag-list-success.json';
import { normalizeTagFacets } from '../src/tools/tag.js';

describe('normalizeTagFacets', () => {
  it('extracts tag items from search_facets', () => {
    const tags = normalizeTagFacets(tagListFixture.result);
    expect(tags).toHaveLength(2);
    expect(tags[0]).toEqual(expect.objectContaining({ name: 'health', count: 12 }));
    expect(tags[1]).toEqual(expect.objectContaining({ name: 'data', count: 7 }));
  });

  it('handles facets object fallback', () => {
    const tags = normalizeTagFacets({
      facets: {
        tags: {
          transport: 5,
          climate: 2
        }
      }
    });

    expect(tags).toEqual([
      { name: 'transport', count: 5 },
      { name: 'climate', count: 2 }
    ]);
  });
});
