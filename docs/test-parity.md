# Test parity with ondata/ckan-mcp-server

Baseline: ondata/ckan-mcp-server at commit `09e8cdc`. `npx vitest run` there (2026-11-09): **732 tests, 726 passed,
6 skipped**, in 39 files. That is the number to compare with. (A grep for `it(`/`test(` blocks gives 697, because
`it.each` expands to several tests; the architecture proposal says 702. The per-file counts below are grep counts,
so like is compared with like.)

## The rule (owner's decision, 2026-11-09)

Tests must be at least as comprehensive as ondata's and cover new code and features. New code may need new or
changed tests. Three principles:

1. **How a test reaches the code may change**: imports, where the network is faked, helpers, environment variable
   prefixes.
2. **What a test expects is not weakened.** Expectations (`expect`), fixtures and `tests/smoke/cases.json` for
   existing behaviour stay. A changed expectation is allowed only for a deliberate behaviour change, and is logged
   below with the reason. The reviewer checks this list against the diff.
3. **Black-box parity for the CKAN profile**: every CKAN tool called through MCP with fixture responses, output
   compared with ondata's server at `09e8cdc`. (Arrives with the CKAN profile.)

Coverage and test count may not fall below the ondata baseline for the code each test file covers.

## Principle 3: the black-box parity check (built 2026-11-09)

`packages/profile-ckan/tests/parity/`. ondata/ckan-mcp-server at `09e8cdc` is loaded in-process from a local clone
(`ONDATA_REPO`, default `../ondata-ckan-mcp-server/repo`; the tests skip when it is absent and **fail** when it is on
another commit) and made to take its fetch path (the one its hosted Worker runs) by hiding `process.versions.node`
during each call. Both servers then read upstream HTTP from the same recordings.

- **Cases** (`cases.ts`): every tool in Markdown and JSON (20 tools; the two without `response_format` once), every
  resource template, every prompt, and ondata's smoke cases including the second call of a comparing case: 80.
  IDs point at old, stable records where possible.
- **Recording** (`record.test.ts`, only with `CKAN_PARITY_RECORD=1`): ondata against the live portals, one case at a
  time with a pause, fresh modules per case; saves every exchange (request key and identity/encoding headers,
  response) and ondata's observation, gzipped. Recorded 2026-11-09: 133 requests to 9 hosts.
- **Replay** (`parity.test.ts`): (1) ondata replayed must reproduce its recorded observation exactly (harness
  determinism: 80/80, also in shuffled orders); (2) our profile replayed must give the same observation for every
  case it registers; the rest are `todo`. An observation is the text, the error flag and `structuredContent` (tools),
  MIME types (resources) or roles (prompts). Both sides must send exactly the recorded requests: same keys, same
  number of times, same User-Agent, Accept, Accept-Encoding and Content-Type; a recorded request not made is also a
  difference. `Date` is frozen at the recording time.
- **Why fresh modules per case:** ondata keeps per-portal state at module level (the Solr parser probe,
  `src/tools/package.ts:21`, not exported; the scheming negative cache); without a reset a case's requests depend on
  the cases before it (found: three cases failed in a shuffled order).
- **Not in git:** the `find-portals` recordings hold datashades.info's whole portal registry (23 MB raw, third-party
  data whose licence is not stated, with contact details of portal operators). They stay local
  (`.gitignore`); re-record with `CKAN_PARITY_RECORD=1 CKAN_PARITY_ONLY=find-portals`. The other recordings
  (about 1.3 MB) are public open-data API answers; they include institutional contact addresses of dataset
  maintainers, as the portals publish them.
- **ondata's Node path** (added in round 2): a third pass replays ondata on its Node path (axios, what the npm
  package runs) through an axios adapter answering from the same recordings, matched by meaning (method, path,
  decoded query pairs in order, body), because axios encodes a query differently (`*:*` against `*%3A*`); the portal
  reads both the same. Every recorded request must be consumed. Result: ondata's two paths give the same
  observation in all recorded cases, so the fetch path we port is what npm users see too. Their request headers
  differ (D9).
- **Deliberate differences** are listed per case in `parity.test.ts` (`DEVIATIONS`) with exactly how the
  observation may differ; the rest of it is still compared (D8).
- **Known limits.** Hiding `process.versions.node` also turns off ondata's stderr audit log during the call (no
  effect on tool output). The recorder buffers bodies and passes on only `content-type` and `location`, so
  ondata's declared-size cap and its compressed-body decoding do not run in the recordings; the ported unit tests
  cover them (`packages/profile-ckan/tests/http.test.ts`).
- **Round 2 cases** (2026-11-09): a missing organization (404 hint), `limit: 0` (count by facet), `all_fields`,
  `tag_query` (the second, wider facet request), and seven without network: an unknown argument, an invalid URL, a
  limit out of range, a private host (both formats), the metadata address and a `file:` URL. 95 cases in all.

## Ported so far (core)

| ondata file (09e8cdc) | Section | Tests | Here | How the reach changed |
|---|---|---|---|---|
| `tests/unit/http.test.ts` | 14-362, 1025-1053 (guards) | 48 | `packages/core/tests/guards.test.ts` | `CKAN_` → `APP_`; guards called through `tests/helpers.ts`, which builds the policy from `process.env` |
| `tests/unit/private-hosts.test.ts` | all | 16 | `packages/core/tests/private-hosts.test.ts` | as above |
| `tests/unit/cache.test.ts` | all but `getTtlForAction` | 21 of 25 | `packages/core/tests/cache.test.ts` | `buildCacheKey(a,b,c)` → `buildCacheKey([a,b,c])` via helper; config read via helper |
| `tests/unit/rate-limiter.test.ts` | all | 13 | `packages/core/tests/rate-limiter.test.ts` | config read via helper |
| `tests/unit/truncate-json.test.ts` | all | 20 | `packages/core/tests/truncate-json.test.ts` | ondata's shrinkable-key list passed via helper |
| `tests/unit/formatting.test.ts` | all | 19 | `packages/core/tests/formatting.test.ts` | import path |
| `tests/unit/error-telemetry.test.ts` | all | 1 | `packages/core/tests/error-telemetry.test.ts` | import path |
| `tests/unit/scheming.test.ts` | 19-197 (renderer, Markdown) | 21 | `packages/core/tests/fields.test.ts` | ondata's `renderSchemaFields`/`formatFieldsMarkdown` rebuilt on the generic renderer in the helper |
| `tests/unit/sanitize-inline.test.ts` | 6-26, first test of 137-141 | 5 | `packages/core/tests/sanitize-inline.test.ts` | import path |

164 ondata tests ported, all green, no expectation changed.

### Not ported, and why

| ondata tests | Count | Goes to |
|---|---|---|
| `tests/integration/datastore-table-ui.test.ts` | 6 | Not ported: it tests the DataStore table UI resource, which ondata at 09e8cdc does not register (`src/resources/index.ts:19,31`: "disabled - awaiting use-case design"). It comes with that resource if ondata turns it on |

## Ported so far (CKAN profile)

| ondata file (09e8cdc) | Section | Tests | Here | How the reach changed |
|---|---|---|---|---|
| `tests/unit/http.test.ts` | 364-946 (`makeCkanRequest`, redirects, private hosts, Anubis) | 38 | `packages/profile-ckan/tests/http.test.ts` | axios mocks → a fake `fetch` (or a loopback server where a real connection is the point); ondata's axios `beforeRedirect` hook tested as a redirect chain; timeouts by the fetch abort with fake timers; ENOTFOUND by a DNS stub that throws; module cache and rate limiter → one engine per test. Two expectations follow D9 (below) |
| same | 947-1024 (cache), 1054-1111 (audit log), 1112-1473 (`formatCkanError`) | 6, 3, 29 | same file | as above |
| `tests/unit/cache.test.ts` | 64-84 (`getTtlForAction`) | 4 | same file | import path |
| `tests/unit/ckan-error-message.test.ts` | all | 4 | `packages/profile-ckan/tests/ckan-error-message.test.ts` | import path |
| `tests/unit/status-formatting.test.ts`, `tag.test.ts`, `organization-formatting.test.ts`, `portal-config.test.ts`, `url-generator.test.ts`, `search.test.ts` | all | 5, 2, 8, 4, 16, 61 | `packages/profile-ckan/tests/` (same names) | import paths |
| `tests/integration/status.test.ts`, `organization.test.ts` | all | 2, 6 | `status-integration.test.ts`, `organization-integration.test.ts` | axios mock → fake `fetch` |
| `tests/integration/status-hint.test.ts` | all | 2 (4 with `it.each`) | `status-hint.test.ts` | tool called through the profile on the core; axios ECONNABORTED → a fetch that never answers until a 50 ms `CKAN_TIMEOUT_MS` aborts it |

190 ondata tests ported in round 2 (grep count), all green. Changed expectations: two, both D9.

### Round 3 (groups, datasets, DataStore)

| ondata file (09e8cdc) | Tests | Here | How the reach changed |
|---|---|---|---|
| `tests/unit/group-formatting`, `package-show-formatting`, `datastore-formatting` | 7, 9, 19 | same names | import paths; one result typed `any` |
| `tests/unit/package-scoring.test.ts` | 82 | same name | import paths; the two functions taking a `CkanPackage` called through untyped aliases (the test data are partial objects) |
| `tests/unit/sanitize-inline.test.ts` | 9 of the 10 CKAN tests | `sanitize-inline-ckan.test.ts` | import paths (the analyze test waits for that tool) |
| `tests/unit/scheming.test.ts` 198-300 | 9 | `scheming.test.ts` | `makeCkanRequest` mocked as in ondata, now called with `ctx` first; the core's `jsonToolResult` given ondata's shrinkable keys |
| `tests/integration/group`, `package`, `datastore`, `datastore-sql-errors` | 5, 45, 19, 13 | `*-integration.test.ts`, `datastore-sql-errors.test.ts` | tools called through the profile on the core (`ckanClient`); axios mocks → fake `fetch` (a rejection with a response → that status and body; ECONNABORTED → a fetch aborted by a 50 ms `CKAN_TIMEOUT_MS`); request parameters read from the URL the portal receives, so expected numbers and booleans are compared as the strings sent; the SQL GET/POST fallback asserted on the `sql` query parameter and the JSON body; ondata's separate "Workers" block runs on the one path |
| `tests/integration/package-show-scheming`, `relevant-zero-hint`, `search-telemetry` | 7, 3, 6 | same names | as above; ondata's `takeSearchResults(server)` read through the core's `takeTelemetry` (which also clears the `cache_hit` noted with it) |

233 ondata tests ported in round 3 (grep count), all green, no expectation changed, nothing skipped. New parity
cases: an OR query (the Solr parser probe, 6 requests), paging, DataStore filters/fields/sort, columns only, an SQL
error, a missing resource, a missing group, resources of a second portal, each in both formats: 111 cases in all, each on three passes. A new check compares
`tools/list` (name, title, description, input schema, annotations) for every tool the profile registers with ondata's.

### Round 4 (quality, analysis, SPARQL, portal discovery)

| ondata file (09e8cdc) | Tests | Here | How the reach changed |
|---|---|---|---|
| `tests/integration/quality.test.ts` | 29 | `quality-integration.test.ts` | `package_show` (axios there) and the MQA calls (fetch) both reach the fake `fetch` through the core: CKAN API calls answered from a queue the former axios mocks fill, the rest by the MQA mock the tests configure and assert as before; mock answers are real `Response` objects; `getMqaQuality` takes the context first |
| `tests/integration/analyze.test.ts` | 15 | `analyze-integration.test.ts` | axios mocks → fake `fetch`; the formatter called through an untyped alias (partial datasets) |
| `tests/integration/sparql.test.ts` | 27 | `sparql-integration.test.ts` | real `Response` objects; request headers read with `fetchedHeaders` (the core passes a `Headers` object); method and body still asserted with `toHaveBeenCalledWith` |
| `tests/integration/portal-discovery.test.ts` | 4 | `portal-discovery.test.ts` | ondata's module cache is the engine's: calls that must share it use one client; DNS stubbed |
| `tests/unit/sanitize-inline.test.ts` 45-71 | 1 | `sanitize-inline-ckan.test.ts` | import path |

76 ondata tests ported in round 4, all green, no expectation changed, nothing skipped. New tests:
`packages/profile-ckan/tests/fetch.test.ts` (10: identity, Accept, no rate token, no honest retry, three redirects,
https-only, allowlist exemption for constant upstreams only, fetch-style errors, and `sparql_query`'s own failure
texts: its DNS check and its `AbortController` timer) and 2 core client tests (`userAgent: { fixed }`,
`fixedUpstream`). New parity cases: SPARQL over POST (Wikidata) and a rejected query, analysis on a
second portal, three offline (not SELECT, http endpoint, MQA on another portal): 121 cases.

### Round 5 (resources and prompts)

| ondata file (09e8cdc) | Tests | Here | How the reach changed |
|---|---|---|---|
| `tests/unit/prompts.test.ts`, `uri.test.ts` | 5, 11 | same names | import paths |
| `tests/integration/resources.test.ts` | 11 | `resources-integration.test.ts` | axios mock → fake `fetch`; the URL and parameters read from the request the portal receives |
| `tests/unit/resources-dataset-filters.test.ts` | 3 | same name | the resources are specs found by name, not register functions; `makeCkanRequest` mocked as in ondata, now with the context first; the mock keeps the module's other exports |

30 ondata tests ported in round 5, all green, no expectation changed, nothing skipped. Every ondata test file at
09e8cdc is now ported or listed above with its reason. The parity check now also compares `prompts/list` and
`resources/templates/list` with ondata's, and all three lists must have the same entries (the port is complete): all
121 cases pass on all three passes, none is `todo`.

### The CKAN deployment

| ondata (09e8cdc) | Here | How |
|---|---|---|
| `src/worker.ts` behaviour | `packages/host-ckan/tests/worker-parity.test.ts` (11) | ondata's Worker loaded from the clone and ours given the same requests (the version field checked as D13) (`/`, `/health`, `/mcp` GET/OPTIONS/initialize/broken JSON, a 404, four tool calls refused before the network): status, headers and body equal; for tool calls also the log line and the Analytics data point, duration aside |
| `tests/smoke/cases.json`, `scripts/smoke.mjs` | `packages/host-ckan/tests/smoke/cases.json`, `scripts/smoke-ckan.mjs` | cases copied unchanged; the script runs our binary. 18/18 live on 2026-11-09 |

`packages/host-ckan/tests/host.test.ts` (5, new) covers routes, health counts and ondata's log fields without the
clone; `binary.test.ts` (3, new) builds the binary as the package script does and runs it: ondata's status lines
over stdio and HTTP, 20 tools, `CKAN_ALLOWED_DOMAINS` applied, and the refusal to start HTTP without an allowlist.
`packages/core/tests/engine.test.ts` +1: Worker headers from the deployment's env. Service notices: `host.test.ts`
+3 (headers from `CKAN_SERVICE_*`, ondata's by default, the test deployment's `wrangler.toml`) and
`packages/profile-ckan/tests/demo-footer.test.ts` (3: the Workers footer, ondata's text by default).

## Ported from ondata's italianparliament-mcp (commit `fd46810`)

| Original | Tests | Here | Change |
|---|---|---|---|
| `src/tools/sparql.test.ts`, `validateSelectQuery` block | 5 | `packages/core/tests/sparql.test.ts` | Inputs and verdicts unchanged; the two expected message substrings translated with the messages ("Solo query SELECT supportate" → "Only SELECT queries are supported", "keyword di scrittura DROP" → "update keyword DROP"): deliberate, the core's text is English |
| `src/core/sparql-literal.test.ts` | 5 | same file | unchanged |

## New tests (code that ondata did not have)

| File | Tests | Covers |
|---|---|---|
| `packages/core/tests/client.test.ts` | 33 | the HTTP client against a live local server: streaming size cap, declared-size cap, gzip bomb, timeout while the body stalls, cache hit/miss, rate tokens, Anubis retry, error bodies, edge 52x, redirect hop guards (metadata, private exemption, DNS, max hops, https-only), per-request private exemption |
| `packages/core/tests/engine.test.ts` | 24 | profile validation and registration through a real MCP client, error hints, telemetry per server instance, config prefixes, instance registry, Workers host |
| `packages/profile-skos/tests/tematres-client.test.ts` | 15 | TemaTres envelope against recorded answers (fixtures from begrepp.hagstrom.nu, 2026-11-09) |
| `packages/profile-skos/tests/profile.test.ts` | 30 | the eight vocab_ tools end to end through MCP with recorded and synthetic TemaTres answers: order, labels, notes, mappings, private notes, hostile text, URI ownership and patterns, error hints |
| `packages/host-vocab/tests/host.test.ts` | 5 | language files, generated landing page (en/sv) and /health, Worker routes |
| `packages/core/tests/host-policy.test.ts` | 21 | per-host retry (what is retried and what never is: refused redirect, oversized body, redirect loop, Anubis single honest request, bounded attempts), shared throttle, row output and its two channels |
| `packages/core/tests/sparql.test.ts` | 2 of 12 | `injectLimit`, `flattenBindings` (the other 10 are ported, see above) |
| `packages/core/tests/client.test.ts` (round 2) | +6 | `allowlistedAs` (first hop only, literal guards kept); a gzip body without Content-Encoding or with `identity` is unpacked, within the decompressed cap, and kept as it came when it only starts like gzip; `TransportError.kind` asserted in the existing transport tests |
| `packages/core/tests/engine.test.ts` (round 2) | +5 | `strictInput` (MCP and `runRowsTool`), `validateUrl` with the private-host exemption, `cache.defaultTtlSeconds` |
| `packages/profile-ckan/tests/http.test.ts` (round 2, end of file) | 4 | the allowlist on the caller's host across the portals.json rewrite, a caller host outside it, a redirect loop without retry hint, an oversized body as `CkanApiError` |
| `packages/profile-ckan/tests/parity/` (round 2) | 95 + 95 | our profile against ondata for the 13 cases of the ported tools plus 7 offline cases; ondata's Node path against its fetch path for all 95 |
| `packages/spike-parliament/tests/spike.test.ts` | 14 | the contract spike through MCP: unprefixed names, examples, recorded Camera answers, per-chamber truncation, Senato throttle, Camera retry, no retry on 403, SPARQL validation and escaping |

## Deviation list (changed expectations and changed behaviour)

Corrected 2026-11-09 after the first review (`review/REVIEWS.md`): an earlier D1 claimed ondata's strict path could
reach a listed private IP literal. That was wrong: ondata's `sparql_query` checks DNS on the first hop
(`src/tools/sparql.ts:55` at 09e8cdc), and a literal resolves to itself. The gap existed only in an early version of
this core, which had dropped that first-hop check.

| # | What | Why | Effect for CKAN users | Migration |
|---|---|---|---|---|
| D1 | The private-host exemption applies only when a request asks for it (`allowPrivateHosts`); `validateUrl` refuses a listed private host otherwise. ondata's `validateServerUrl` always exempted listed hosts and relied on the DNS checks of the strict path. | One rule in one place, independent of whether the dispatcher loads. | None expected: the CKAN profile will ask for the exemption on the CKAN request path, as ondata's axios agents did. | None. |
| D2 | One fetch-based path on Node and Workers. The body is read as a stream and stopped at the smaller of the wire cap and the decompressed cap (defaults 32 MiB and 64 MiB, so 32 MiB, as in ondata). | ondata read the whole body, then compared its size. | Same limit. | None. |
| D3 | Startup message for a missing allowlist says "which hosts" instead of "which CKAN hosts". | The core names no backend. | Wording only. | The CKAN host may wrap the message. |
| D4 | Redirect hops check the private-host exemption on every path (ondata did it only on the axios path). | Consistency with D1. | None. | None. |
| D5 | Every request gets the DNS check on the first hop, also on the CKAN path (ondata did it only on the strict paths; the CKAN path relied on the agents' pinned lookup). An unresolvable first host is reported as `Server not found: <url>` (a `TransportError`) without a request, as ondata's axios path reported ENOTFOUND. | Defence in depth: holds even if the pinning dispatcher cannot load. | One extra DNS lookup per uncached request. | None. |
| D6 | Default redirect limit 5 for every request; ondata's `safeFetch` defaulted to 3 (sparql, quality, portal discovery) and its CKAN path used 5. | One default. | The CKAN profile passes `maxHops: 3` where ondata used `safeFetch`'s default. | None, if the profile does so. |
| D7 | `jsonToolResult` wraps a top-level array or null as `{ items: ... }` in `structuredContent`, which MCP requires to be an object. ondata passed it through (no ondata caller passes an array at 09e8cdc). | Protocol conformance. | None today. | None. |
| D8 | Argument validation errors (unknown key, invalid URL, out of range) read `Invalid arguments for tool X: <message> at <path>`, one line per issue, instead of the Zod issues as a JSON array. | SDK 1.32.2 here, 1.27.1 in ondata: the SDK writes this text. | Shorter, same facts. | None. ondata gets the same text when it upgrades the SDK. |
| D9 | The CKAN request headers on Node are those of ondata's fetch path (its Worker): `Accept`, `Accept-Encoding: identity`, the browser `User-Agent`. ondata's Node path (axios) also sent `Accept-Language`, `Accept-Encoding: gzip, deflate, br`, `Connection: keep-alive` and the `Sec-CH-UA*` hints, and set `proxy: false` (here the pinning dispatcher bypasses environment proxies). | One request path for Node and Workers. | None seen: the parity check replays ondata's Node path and it gives the same observation in every recorded case. A firewall that demands the client hints would refuse the Worker today too. | None. If a portal needs the hints, add them to the profile's request headers. |
| D10 | A gzip body without `Content-Encoding` (or with one that names no coding the runtime undoes, e.g. `identity`) is unpacked on every runtime, by the core client (ondata did it on Node, not on Workers). Past the decompressed cap it is refused as too large; ondata kept the packed bytes, which then failed as `success=false`. | One behaviour everywhere; a clearer error. | Workers users get these portals' answers; a decompression bomb reads `Response too large`. | None. |
| D11 | ondata's direct calls (MQA, SPARQL, the portal registry) now have the core's size cap (32 MiB) and its first-hop DNS check, and SPARQL's 15 s timeout applies to each request instead of to the POST and its GET fallback together. | One client with the same guards for every request. | A larger answer is refused as too large (the registry is about 23 MB today). A slow POST and a slow GET can take up to 30 s together. Failure texts are ondata's per call (an unknown host: `fetch failed` for MQA and the registry, `Cannot resolve ...` for SPARQL; a timeout: `AbortSignal.timeout`'s text for MQA and the registry, `This operation was aborted` for SPARQL). | None. |
| D12 | The Worker log line's `cache_hit` comes from this call's requests. ondata read a module-level "last request" value, so a tool call that made no CKAN request could log the previous call's value. | Telemetry per server instance (no state shared between concurrent requests in an isolate). | `cache_hit` is absent when the call made no request, and never another call's. | None. |
| D13 | `initialize` (serverInfo) and `/health` report our version (`0.1.0`) instead of ondata's `0.4.138`; the Workers service notices (two headers, the Markdown footer) are the deployment's settings, ondata's texts by default. | A release of ours is not ondata's release; a test deployment must not claim to be ondata's demo instance. | A client that reads the version sees ours. ondata deploying this code keeps its notices without changes. | None. |

