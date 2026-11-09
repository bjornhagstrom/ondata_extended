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

### Not ported here, and where they go

| ondata tests | Count | Goes to |
|---|---|---|
| `cache.test.ts` `getTtlForAction` | 4 | CKAN profile (the TTL per action is CKAN's) |
| `http.test.ts` `makeCkanRequest`, cache integration, audit logging, `formatCkanError` (364-1024, 1054-end) | 76 | CKAN profile (URL schema, envelope, hints) |
| `scheming.test.ts` `getDatasetSchema`, dataset page, JSON output | 9 | CKAN profile |
| `sanitize-inline.test.ts` CKAN formatters | 10 | CKAN profile |
| everything else (tools, resources, prompts, integration) | 434 | CKAN profile |

## Ported from ondata's italianparliament-mcp (commit `fd46810`)

| Original | Tests | Here | Change |
|---|---|---|---|
| `src/tools/sparql.test.ts`, `validateSelectQuery` block | 5 | `packages/core/tests/sparql.test.ts` | Inputs and verdicts unchanged; the two expected message substrings translated with the messages ("Solo query SELECT supportate" → "Only SELECT queries are supported", "keyword di scrittura DROP" → "update keyword DROP"): deliberate, the core's text is English |
| `src/core/sparql-literal.test.ts` | 5 | same file | unchanged |

## New tests (code that ondata did not have)

| File | Tests | Covers |
|---|---|---|
| `packages/core/tests/client.test.ts` | 33 | the HTTP client against a live local server: streaming size cap, declared-size cap, gzip bomb, timeout while the body stalls, cache hit/miss, rate tokens, Anubis retry, error bodies, edge 52x, redirect hop guards (metadata, private exemption, DNS, max hops, https-only), per-request private exemption |
| `packages/core/tests/engine.test.ts` | 20 | profile validation and registration through a real MCP client, error hints, telemetry per server instance, config prefixes, instance registry, Workers host |
| `packages/profile-skos/tests/tematres-client.test.ts` | 15 |
| `packages/core/tests/host-policy.test.ts` | 21 | per-host retry (what is retried and what never is: refused redirect, oversized body, redirect loop, Anubis single honest request, bounded attempts), shared throttle, row output and its two channels |
| `packages/core/tests/sparql.test.ts` | 2 of 12 | `injectLimit`, `flattenBindings` (the other 10 are ported, see above) |
| `packages/spike-parliament/tests/spike.test.ts` | 12 | the contract spike through MCP: unprefixed names, examples, recorded Camera answers, per-chamber truncation, Senato throttle, Camera retry, no retry on 403, SPARQL validation and escaping | TemaTres envelope against recorded answers (fixtures from begrepp.hagstrom.nu, 2026-11-09) |

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
