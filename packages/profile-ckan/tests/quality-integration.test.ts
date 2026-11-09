// Ported from ondata/ckan-mcp-server tests/integration/quality.test.ts at 09e8cdc (MIT).
// Reach (docs/test-parity.md, principle 1): in ondata, package_show went through axios (mocked)
// and the MQA calls through `fetch` (stubbed). Here both reach `fetch` through the core, so the
// fake `fetch` routes by URL: CKAN API calls are answered from the queue the former axios mocks
// fill (`ckanAnswer`/`ckanReject`, same fixtures and statuses), every other call goes to
// `mqaFetch`, the mock the tests configure and assert on exactly as they did on `fetch`.
// `response()` builds a real `Response` (the core reads status and body stream).
// `getMqaQuality` takes the engine context first. Expectations unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __setDnsResolverForTests } from '@ondata-extended/core';
import {
  getMqaQuality as getMqaQualityWithCtx,
  isValidMqaServer,
  mqaBand,
  formatQualityMarkdown,
  formatQualityDetailsMarkdown
} from '../src/tools/quality.js';
import { ckanContext, jsonResponse, stubPublicDns } from './helpers.js';
import packageShowWithIdentifier from './fixtures/responses/package-show-with-identifier.json';
import packageShowWithoutIdentifier from './fixtures/responses/package-show-without-identifier.json';
import mqaV2Success from './fixtures/responses/mqa-v2-quality-success.json';
import mqaMetricsSuccess from './fixtures/responses/mqa-metrics-success.json';
import mqaNoV2Metrics from './fixtures/errors/mqa-no-v2-metrics.json';
import mqaDatasetNotFound from './fixtures/errors/mqa-dataset-not-found.json';

const getMqaQuality = (serverUrl: string, datasetId: string, opts?: { httpStatus?: boolean }) =>
  getMqaQualityWithCtx(ckanContext(), serverUrl, datasetId, opts);

/** Answers for CKAN API calls, in order (what the axios mock returned in ondata). */
let ckanQueue: (() => Response)[] = [];
/** ondata: `ckanAnswer({ data })`. */
const ckanAnswer = ({ data }: { data: unknown }) => { ckanQueue.push(() => jsonResponse(data)); };
/** ondata: `ckanReject({ isAxiosError, response: { status, data } })`. */
const ckanReject = ({ response: r }: { isAxiosError?: boolean; response: { status: number; data: unknown } }) => {
  ckanQueue.push(() => jsonResponse(r.data, { status: r.status }));
};
/** Every non-CKAN call (the MQA cache and metrics endpoints). */
let mqaFetch: ReturnType<typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;

afterEach(() => {
  vi.unstubAllGlobals();
  __setDnsResolverForTests(null);
});

const DATASET_ID = '332be8b7-89b9-4dfe-a252-7fccd3efda76';
const SERVER = 'https://www.dati.gov.it/opendata';

const response = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status,
  statusText: status === 200 ? 'OK' : 'Not Found'
});

const fetchMock = () => mqaFetch;
// MQA cache and metrics endpoint are both fetched in call order; package_show goes through the CKAN queue
const mockCache = (body: unknown) => fetchMock().mockResolvedValueOnce(response(200, body));
const mockCache404 = (body: unknown) => fetchMock().mockResolvedValueOnce(response(404, body));
const mockFetchJson = (payload: unknown) => fetchMock().mockResolvedValueOnce(response(200, payload));

describe('ckan_get_mqa_quality integration', () => {
  beforeEach(() => {
    stubPublicDns();
    ckanQueue = [];
    mqaFetch = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/api/3/action/')) {
        const next = ckanQueue.shift();
        if (!next) throw new Error(`unexpected CKAN call: ${String(input)}`);
        return next();
      }
      return mqaFetch(input, init);
    }));
  });

  const mqaMetricsDetails = {
    '@graph': [
      {
        'dqv:isMeasurementOf': { '@id': 'https://piveau.eu/ns/voc#reusabilityScoring' },
        'dqv:value': { '@value': 65 }
      },
      {
        'dqv:isMeasurementOf': { '@id': 'https://piveau.eu/ns/voc#scoring' },
        'dqv:value': { '@value': 385 }
      },
      {
        'dqv:isMeasurementOf': { '@id': 'https://piveau.eu/ns/voc#knownLicence' },
        'dqv:value': { '@value': 'false' }
      }
    ]
  };

  const withDataService = () => {
    const payload = JSON.parse(JSON.stringify(mqaV2Success));
    const entry = payload.result.results[0];
    entry.dataServices = [{
      score: 5,
      maxScore: 7.5,
      metrics: [{
        metric: 'servesDatasetAvailability',
        property: 'http://www.w3.org/ns/dcat#servesDataset',
        importance: 'Recommended',
        weight: 0.5,
        dimension: 'interoperability',
        result: 0,
        score: 0
      }],
      dataService: 'http://data.europa.eu/88u/dataservice/x'
    }];
    const distAvg = entry.distributions.reduce((s: number, d: any) => s + d.score, 0) / entry.distributions.length;
    entry.datasetFinal = (entry.dataset.score + distAvg + 5) / 3;
    return payload;
  };

  describe('isValidMqaServer', () => {
    it('accepts dati.gov.it URLs with www', () => {
      expect(isValidMqaServer('https://www.dati.gov.it/opendata')).toBe(true);
      expect(isValidMqaServer('http://www.dati.gov.it/opendata')).toBe(true);
    });

    it('accepts dati.gov.it URLs without www', () => {
      expect(isValidMqaServer('https://dati.gov.it/opendata')).toBe(true);
      expect(isValidMqaServer('http://dati.gov.it/opendata')).toBe(true);
    });

    it('rejects non-dati.gov.it URLs', () => {
      expect(isValidMqaServer('https://catalog.data.gov')).toBe(false);
      expect(isValidMqaServer('https://demo.ckan.org')).toBe(false);
      expect(isValidMqaServer('https://data.gov.uk')).toBe(false);
    });

    it('rejects suffix and userinfo bypasses (GHSA-83x6)', () => {
      expect(isValidMqaServer('https://dati.gov.it.attacker.com/x')).toBe(false);
      expect(isValidMqaServer('http://dati.gov.it.evil.example/api')).toBe(false);
      expect(isValidMqaServer('https://dati.gov.it@attacker.com/x')).toBe(false);
      expect(isValidMqaServer('not-a-url')).toBe(false);
    });
  });

  describe('mqaBand', () => {
    it('maps scores to the v2 rating bands', () => {
      expect(mqaBand(0)).toBe('Sufficient');
      expect(mqaBand(2.49)).toBe('Sufficient');
      expect(mqaBand(2.5)).toBe('Good');
      expect(mqaBand(4.99)).toBe('Good');
      expect(mqaBand(5)).toBe('Excellent');
      expect(mqaBand(7.5)).toBe('Excellent');
    });
  });

  describe('getMqaQuality — methodology v2', () => {
    it('parses the v2 cache payload without calling the metrics endpoint', async () => {
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache(mqaV2Success);

      const result = await getMqaQuality(SERVER, DATASET_ID);

      expect(mqaFetch).toHaveBeenNthCalledWith(
        1,
        `https://data.europa.eu/api/mqa/cache/resources/${DATASET_ID}`,
        expect.any(Object)
      );
      expect(mqaFetch).toHaveBeenCalledTimes(1);
      if (result.methodology !== 'v2') throw new Error('expected v2');
      expect(result.metricsVersion).toBe('2.0.0');
      expect(result.score).toBeCloseTo(6.4583, 3);
      expect(result.maxScore).toBe(7.5);
      expect(result.band).toBe('Excellent');
      expect(result.dataset.score).toBe(6.5);
      expect(result.distributions).toEqual({ count: 3, average: expect.closeTo(6.4167, 3) });
      expect(result.dataServices).toBeNull();
    });

    it('aggregates failing metrics across distributions and orders them by gain', async () => {
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache(mqaV2Success);

      const result = await getMqaQuality(SERVER, DATASET_ID);
      if (result.methodology !== 'v2') throw new Error('expected v2');

      const accessStatus = result.failing.find(f => f.metric === 'accessUrlStatusCode');
      expect(accessStatus).toMatchObject({ entity: 'distribution', failed: 3, total: 3, weight: 0.25 });
      // 0.25 weight × 3/3 distributions / 2 groups
      expect(accessStatus?.gain).toBeCloseTo(0.125, 5);

      const provenance = result.failing.find(f => f.metric === 'provenanceAvailability');
      expect(provenance).toMatchObject({ entity: 'dataset', failed: 1, total: 1, property: 'dct:provenance' });
      expect(provenance?.gain).toBeCloseTo(0.125, 5);

      const mediaType = result.failing.find(f => f.metric === 'mediaTypeFromVocabulary');
      expect(mediaType).toMatchObject({ failed: 1, total: 3 });
      expect(mediaType?.gain).toBeCloseTo(0.25 / 3 / 2, 3);

      const gains = result.failing.map(f => f.gain);
      expect(gains).toEqual([...gains].sort((a, b) => b - a));

      // Fixing every failing metric reaches the maximum score exactly
      const totalGain = result.failing.reduce((s, f) => s + f.gain, 0);
      expect(result.score + totalGain).toBeCloseTo(7.5, 3);
    });

    it('counts not-evaluated metrics (result null) as failing, as the score does', async () => {
      const payload = JSON.parse(JSON.stringify(mqaV2Success));
      const entry = payload.result.results[0];
      const dist = entry.distributions[0];
      const status = dist.metrics.find((m: any) => m.metric === 'accessUrlStatusCode');
      const availability = dist.metrics.find((m: any) => m.metric === 'accessUrlAvailability');
      status.result = null;
      status.score = null;
      availability.result = 0;
      availability.score = 0;
      dist.score -= 1;
      const distAvg = entry.distributions.reduce((s: number, d: any) => s + d.score, 0) / entry.distributions.length;
      entry.datasetFinal = (entry.dataset.score + distAvg) / 2;
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache(payload);

      const result = await getMqaQuality(SERVER, DATASET_ID);
      if (result.methodology !== 'v2') throw new Error('expected v2');

      expect(result.failing.find(f => f.metric === 'accessUrlStatusCode')).toMatchObject({ failed: 3, total: 3 });
      const totalGain = result.failing.reduce((s, f) => s + f.gain, 0);
      expect(result.score + totalGain).toBeCloseTo(7.5, 3);
    });

    it('scores a metadata-only dataset on the dataset alone', async () => {
      const payload = JSON.parse(JSON.stringify(mqaV2Success));
      const entry = payload.result.results[0];
      entry.distributions = [];
      delete entry.datasetFinal;
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache(payload);

      const result = await getMqaQuality(SERVER, DATASET_ID);
      if (result.methodology !== 'v2') throw new Error('expected v2');

      expect(result.score).toBe(6.5);
      expect(result.distributions).toBeNull();
      const provenance = result.failing.find(f => f.metric === 'provenanceAvailability');
      expect(provenance?.gain).toBeCloseTo(0.25, 5);
    });

    it('scores embedded data services as a third group', async () => {
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache(withDataService());

      const result = await getMqaQuality(SERVER, DATASET_ID);
      if (result.methodology !== 'v2') throw new Error('expected v2');

      expect(result.dataServices).toEqual({ count: 1, average: 5 });
      const serves = result.failing.find(f => f.metric === 'servesDatasetAvailability');
      expect(serves).toMatchObject({ entity: 'dataService', failed: 1, total: 1 });
      expect(serves?.gain).toBeCloseTo(0.5 / 3, 3);
      const provenance = result.failing.find(f => f.metric === 'provenanceAvailability');
      expect(provenance?.gain).toBeCloseTo(0.25 / 3, 3);
    });

    it('uses name as fallback when identifier is missing', async () => {
      ckanAnswer({ data: packageShowWithoutIdentifier });
      mockCache(mqaV2Success);

      await getMqaQuality('https://dati.gov.it/opendata', 'pkg-2');

      expect(mqaFetch).toHaveBeenNthCalledWith(
        1,
        'https://data.europa.eu/api/mqa/cache/resources/example-dataset-no-identifier',
        expect.any(Object)
      );
    });

    it('normalizes identifier for MQA lookups', async () => {
      ckanAnswer({
        data: { success: true, result: { id: 'dummy', name: 'dummy-name', identifier: 'cmna:A064' } }
      });
      mockCache(mqaV2Success);

      await getMqaQuality(SERVER, 'dummy-id');

      expect(mqaFetch).toHaveBeenNthCalledWith(
        1,
        'https://data.europa.eu/api/mqa/cache/resources/cmna-a064',
        expect.any(Object)
      );
    });

    it('tries disambiguation suffix when base identifier has no MQA record', async () => {
      const base = 'c_a734-elenco-posteggi-autorizzati-per-il-commercio-su-aree-pubbliche-2022-2023';
      ckanAnswer({
        data: {
          success: true,
          result: {
            id: 'dummy',
            name: 'dummy-name',
            identifier: 'c_a734:elenco-posteggi-autorizzati-per-il-commercio-su-aree-pubbliche-2022-2023'
          }
        }
      });
      mockCache404(mqaDatasetNotFound);
      mockCache(mqaV2Success);

      const result = await getMqaQuality(SERVER, 'dummy-id');

      expect(mqaFetch).toHaveBeenNthCalledWith(
        2,
        `https://data.europa.eu/api/mqa/cache/resources/${base}~~1`,
        expect.any(Object)
      );
      expect(result.portalId).toBe(`${base}~~1`);
    });
  });

  describe('getMqaQuality — HTTP status of failing URL tests', () => {
    const METRICS_URL = `https://data.europa.eu/api/hub/repo/datasets/${DATASET_ID}/metrics`;
    const statusNode = (metric: string, dist: string, code: Record<string, unknown>, time = '2026-09-23T18:00:00Z', description?: string) => ({
      'dqv:isMeasurementOf': { '@id': `https://piveau.eu/ns/voc#${metric}` },
      'dqv:computedOn': { '@id': `http://data.europa.eu/88u/distribution/${dist}` },
      'prov:generatedAtTime': { '@value': time },
      ...(description ? { 'dct:description': description } : {}),
      ...code
    });
    const v2Code = (code: string) => ({ 'http://www.w3.org/2011/http#statusCodeValue': code });
    const TIMEOUT = 'The timeout period of 5000ms has been exceeded while executing HEAD /x for server example.org:443';
    const statusGraph = {
      '@graph': [
        statusNode('accessUrlStatusCode', 'd1', v2Code('1100'), undefined, TIMEOUT),
        statusNode('accessUrlStatusCode', 'd2', v2Code('1100'), undefined, TIMEOUT),
        // previous-methodology shape: the code sits in dqv:value
        statusNode('accessUrlStatusCode', 'd3', { 'dqv:value': { '@value': '404' } }),
        // an older measurement of the same distribution must not count twice
        statusNode('accessUrlStatusCode', 'd3', v2Code('200'), '2026-07-01T00:00:00Z'),
        // boolean result nodes carry no code
        statusNode('accessUrlStatusCode', 'd1', { 'dqv:value': { '@value': 'false' } }),
        // 2xx is a pass, not a reason
        statusNode('downloadUrlStatusCode', 'd1', v2Code('200')),
        statusNode('downloadUrlStatusCode', 'd2', v2Code('502'))
      ]
    };

    it('explains failing URL tests with their status codes in the details', async () => {
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache(mqaV2Success);
      mockFetchJson(statusGraph);

      const result = await getMqaQuality(SERVER, DATASET_ID, { httpStatus: true });
      if (result.methodology !== 'v2') throw new Error('expected v2');

      expect(mqaFetch).toHaveBeenNthCalledWith(2, METRICS_URL, expect.any(Object));
      expect(result.failing.find(f => f.metric === 'accessUrlStatusCode')?.httpStatus)
        .toEqual({ '1100 timeout': 2, '404': 1 });
      expect(result.failing.find(f => f.metric === 'downloadUrlStatusCode')?.httpStatus)
        .toEqual({ '502': 1 });
      expect(result.failing.find(f => f.metric === 'provenanceAvailability')).not.toHaveProperty('httpStatus');

      const markdown = formatQualityDetailsMarkdown(result, 'test-dataset');
      expect(markdown).toContain('HTTP test: 1100 timeout ×2, 404 ×1');
      // 3 distributions fail downloadUrlStatusCode, only one has a code
      expect(markdown).toContain('HTTP test: 502 ×1, no status recorded ×2');
    });

    it('does not fetch the metrics graph without failing URL tests', async () => {
      const payload = JSON.parse(JSON.stringify(mqaV2Success));
      for (const dist of payload.result.results[0].distributions) {
        for (const m of dist.metrics) if (/StatusCode$/.test(m.metric)) m.result = 1;
      }
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache(payload);

      await getMqaQuality(SERVER, DATASET_ID, { httpStatus: true });
      expect(mqaFetch).toHaveBeenCalledTimes(1);
    });

    it('still returns the details when the metrics graph is unavailable', async () => {
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache(mqaV2Success);
      fetchMock().mockRejectedValueOnce(new Error('timeout'));

      const result = await getMqaQuality(SERVER, DATASET_ID, { httpStatus: true });
      if (result.methodology !== 'v2') throw new Error('expected v2');
      expect(result.failing.find(f => f.metric === 'accessUrlStatusCode')).not.toHaveProperty('httpStatus');
    });
  });

  describe('getMqaQuality — previous methodology fallback', () => {
    it('falls back to the metrics endpoint when no v2 metrics exist', async () => {
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache404(mqaNoV2Metrics);
      mockFetchJson(mqaMetricsSuccess);

      const result = await getMqaQuality(SERVER, DATASET_ID);

      expect(mqaFetch).toHaveBeenCalledWith(
        `https://data.europa.eu/api/hub/repo/datasets/${DATASET_ID}/metrics`,
        expect.any(Object)
      );
      if (result.methodology !== 'v1') throw new Error('expected v1');
      // Common JSON fields shared with v2
      expect(result.metricsVersion).toBe('1');
      expect(result.score).toBe(395);
      expect(result.maxScore).toBe(405);
      expect(result.breakdown.scores.total).toBe(395);
      expect(result.breakdown.scores.accessibility).toBe(90);
      expect(result.breakdown.nonMaxDimensions).toEqual(['accessibility']);
    });

    it('explains the missing v2 metrics when the metrics endpoint fails too', async () => {
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache404(mqaNoV2Metrics);
      fetchMock().mockResolvedValueOnce(response(404, 'Not Found'));

      await expect(getMqaQuality(SERVER, DATASET_ID)).rejects.toThrow('not yet re-evaluated');
    });

    it('uses the suffixed candidate that reports missing v2 metrics', async () => {
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache404(mqaDatasetNotFound);
      mockCache404(mqaNoV2Metrics);
      mockFetchJson(mqaMetricsSuccess);

      const result = await getMqaQuality(SERVER, DATASET_ID);

      expect(mqaFetch).toHaveBeenCalledWith(
        `https://data.europa.eu/api/hub/repo/datasets/${DATASET_ID}~~1/metrics`,
        expect.any(Object)
      );
      expect(result.methodology).toBe('v1');
    });

    it('returns non-max reasons from the previous-methodology metrics', async () => {
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache404(mqaNoV2Metrics);
      mockFetchJson(mqaMetricsDetails);

      const result = await getMqaQuality(SERVER, DATASET_ID);
      if (result.methodology !== 'v1') throw new Error('expected v1');

      expect(result.breakdown.nonMaxDimensions).toContain('reusability');
      expect(result.details.reasons.reusability).toContain(
        'knownLicence=false (licence not aligned to controlled vocabulary)'
      );
    });

    it('refuses to show v2-scale numbers on the 405 scale', async () => {
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache404(mqaNoV2Metrics);
      mockFetchJson({
        '@graph': [
          {
            'dqv:isMeasurementOf': { '@id': 'https://piveau.eu/ns/voc#accessibilityScoring' },
            'dqv:value': { '@value': 2.25 }
          },
          {
            'dqv:isMeasurementOf': { '@id': 'https://piveau.eu/ns/voc#scoring' },
            'dqv:value': { '@value': 6.5 }
          }
        ]
      });

      await expect(getMqaQuality(SERVER, DATASET_ID)).rejects.toThrow('not yet re-evaluated');
    });
  });

  describe('getMqaQuality — errors', () => {
    it('throws error when dataset not found on CKAN', async () => {
      ckanReject({
        isAxiosError: true,
        response: { status: 404, data: { error: { message: 'Not found' } } }
      });

      await expect(getMqaQuality(SERVER, 'non-existent')).rejects.toThrow('CKAN API error');
    });

    it('reports a missing MQA record when every candidate is not found', async () => {
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache404(mqaDatasetNotFound);
      mockCache404(mqaDatasetNotFound);
      mockCache404(mqaDatasetNotFound);

      await expect(getMqaQuality(SERVER, DATASET_ID)).rejects.toThrow('No MQA record');
    });

    it('throws error when MQA API is unavailable', async () => {
      ckanAnswer({ data: packageShowWithIdentifier });
      fetchMock().mockRejectedValueOnce(new Error('Network error'));

      await expect(getMqaQuality(SERVER, DATASET_ID)).rejects.toThrow('MQA API error: Network error');
    });
  });

  describe('markdown rendering', () => {
    const loadV2 = async (payload: unknown = mqaV2Success) => {
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache(payload);
      return getMqaQuality(SERVER, DATASET_ID);
    };

    const loadV1 = async (metrics: unknown = mqaMetricsSuccess) => {
      ckanAnswer({ data: packageShowWithIdentifier });
      mockCache404(mqaNoV2Metrics);
      mockFetchJson(metrics);
      return getMqaQuality(SERVER, DATASET_ID);
    };

    it('summarises a v2 score with band, components and top fixes', async () => {
      const markdown = formatQualityMarkdown(await loadV2(), 'test-dataset');

      expect(markdown).toContain('# Quality Metrics for Dataset: test-dataset');
      expect(markdown).toContain('**Score**: 6.46/7.5 (Excellent)');
      expect(markdown).toContain('- Dataset: 6.5/7.5');
      expect(markdown).toContain('- Distributions (3): average 6.42/7.5');
      expect(markdown).toContain('Top fixes (5 of 9 failing metrics');
      expect(markdown).toContain('`dcat:accessURL` (accessUrlStatusCode, optional 0.25) - 3 of 3 distributions, +0.13');
      expect(markdown).toContain('Use ckan_get_mqa_quality_details for the full list.');
      expect(markdown).toContain('https://data.europa.eu/data/datasets/332be8b7-89b9-4dfe-a252-7fccd3efda76/quality?locale=it');
      expect(markdown).not.toContain('/405');
      expect(markdown).not.toContain('Contextuality');
    });

    it('lists every failing v2 metric grouped by dimension', async () => {
      const markdown = formatQualityDetailsMarkdown(await loadV2(withDataService()), 'test-dataset');

      expect(markdown).toContain('# Quality Details for Dataset: test-dataset');
      expect(markdown).toContain('## Accessibility');
      expect(markdown).toContain('## Reusability');
      expect(markdown).toContain('## Findability');
      expect(markdown).toContain('## Interoperability');
      expect(markdown).toContain('- Data services (1): average 5/7.5');
      expect(markdown).toContain('dcat:servesDataset');
      expect(markdown).toContain('1 of 3 distributions');
      expect(markdown).not.toContain('/405');
    });

    it('labels previous-methodology results in the summary', async () => {
      const markdown = formatQualityMarkdown(await loadV1(), 'test-dataset');

      expect(markdown).toContain('previous MQA methodology');
      expect(markdown).toContain('**Score**: 395/405');
      expect(markdown).toContain('Accessibility: 90/100 ⚠️');
      expect(markdown).toContain('Findability: 100/100 ✅');
    });

    it('labels previous-methodology results in the details', async () => {
      const markdown = formatQualityDetailsMarkdown(await loadV1(mqaMetricsDetails), 'test-dataset');

      expect(markdown).toContain('previous MQA methodology');
      expect(markdown).toContain('**Score**: 385/405');
      expect(markdown).toContain('## Non-max Reasons');
      expect(markdown).toContain('Reusability: knownLicence=false');
    });

    it('never embeds the raw MQA payload in the result', async () => {
      const result = await loadV2();
      const json = JSON.stringify(result);
      expect(json).not.toContain('"metrics"');
      expect(json.length).toBeLessThan(10000);
    });
  });
});
