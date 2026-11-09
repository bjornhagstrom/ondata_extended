# Contract spike: italianparliament-mcp on the core (2026-11-09)

**Question.** Does the profile contract, designed from CKAN and SKOS/TemaTres, hold for a third kind of backend? The
pre-study (`ondata-ckan-mcp-server/repo/proposals/mcp-familj-forstudie.md`, sections 3.1-3.2, step 2b) picked ondata's
italianparliament-mcp: same language and SDK as the core, but fixed SPARQL endpoints, per-host throttle and retry,
row output, and 43 tool names without a prefix that are already a user contract.

**What was built.** `packages/spike-parliament` (throwaway): four tools of the original (`legislatures`, `deputies`,
`search`, `sparql`, commit `fd46810`, MIT, Andrea Borruso) as a profile on the core, with the original's queries,
names and Italian model-facing texts. Ranking, birthplace parsing and 39 other tools are left out. 14 tests through
a real MCP client: Camera answers recorded live (three queries, 2026-11-09), Senato synthetic (Senato blocks an IP
after a burst and the block does not decay). One live run against dati.camera.it went through the core's guards
and host policy and returned the expected rows.

## What the contract lacked, and what changed

Each change is the smallest that let the spike express the original's behaviour; all are optional for existing
profiles (CKAN and SKOS are unaffected; 266 earlier tests unchanged and green).

| # | Lacked | Evidence in the original | Change (contract 0.x) |
|---|---|---|---|
| C1 | Tools without a prefix | 43 names (`deputies`, `votes`, `sparql`, ...) in `src/server.ts`; renaming is not an option for its users | `Profile.toolPrefix` optional; names must still be unique across a deployment's profiles (checked) |
| C2 | Per-host throttle and retry declared by the profile | `src/core/client.ts`: Senato ≥ 2 s between request starts, process-wide; both endpoints 5 attempts with backoff 250 ms → 2 s, retrying everything except a 4xx other than 429; 60 s timeout | `Profile.hostPolicies[hostname] = { minIntervalMs, retry, timeoutMs }`; `FetchOptions.retry` overrides per request. The core applies it to every request to that host and retries only network/timeout, 5xx and 429 (never a redirect loop, a refused destination or an oversized body), at most 10 attempts. The throttle lives in the engine: a host keeps one engine per process or Worker isolate (fixed after review: the Worker host built one per request) |
| C3 | Row output | Every tool returns `{rows, columns, hint, notice}`; the server formats JSONL with the truncation notice **after** the rows and an anti-confabulation text when empty (`src/server.ts:58-69`, `src/tools/types.ts`) | `ctx.output.table(rows, { columns, notice, emptyText, format })`: cut on whole rows, notice kept, a note when rows were dropped for size; `structuredContent = { columns, rows, total, truncated }`. Also `ctx.output.text(text, { trailer })` |
| C4 | Examples | `describe()` appends "Examples:" (`src/server.ts:52-56`) | `ToolSpec.examples`; the core appends them |
| C5 | Shared SPARQL helpers | `validateSelectQuery`, `injectLimit`, `sparqlStringLiteral`, `flattenBindings` | `packages/core/src/sparql.ts`, from the parliament versions (stricter than ckan-mcp-server's, which accepts `INSERT DATA {...} ; SELECT ...`), plus `sparqlSelect` through the engine's client |
| C6 | A tool result a CLI can use | `Tool.execute(input)` returns `{rows, columns, notice}`; the CLI (`src/cli.ts`) and MCP (`src/server.ts`) format it differently | `ToolSpec.rows(args, ctx)` as the alternative to `handler` (exactly one is required), `RowsResult { rows, columns, notice, emptyText }`, `Profile.emptyText`, and `runRowsTool` in the core |

## What the spike showed is *not* needed (yet)

- **Capability gating** (`requires: node | subprocess`): none of the four tools needs it. The original's `bill-text
  fetch` (subprocess, real browser) does; decide when a profile actually has such a tool.
- **Manifest file, contract-version check**: the spike registered without one. Still a good idea before a third
  party builds a profile (GeoLibre lesson in the pre-study), not before.
- **Per-host request counters** (`requestCounts` in the original): the per-call telemetry hook covers logging; a
  counter per host would be a small engine addition if wanted.

## Differences a real port would have to decide

| Topic | Original | On the core | Note |
|---|---|---|---|
| Throttle | once per logical call (before the first attempt) | before **every** attempt, retries included | Stricter; matches what the host counts (the original's own comment on `requestCounts`). Behaviour change for them |
| What is retried | everything except 4xx ≠ 429, including an unparsable body | network/timeout, 5xx, 429 only | An unparsable 200 is not retried on the core (except the single honest-identity request on an Anubis page) |
| Error text | `Error: SPARQL error on https://dati.senato.it/sparql (HTTP 403): SPARQL request failed with status 403` (`src/server.ts:97,102`) | `HTTP 403` + the profile's hint | A port that must keep their texts wraps errors in the profile |
| Accept header | `application/json` | `application/sparql-results+json, application/json` | Wire difference; both endpoints answer JSON either way (Camera verified live) |
| Output | text only | text + `structuredContent` | Additive |
| Size caps, SSRF guards | none (fixed endpoints) | 32 MiB cap, timeouts, DNS pinning | Additive; harmless for fixed hosts |
| CLI | `Tool.execute(input)` returns rows; CLI and MCP share it | **Resolved 2026-11-09 (C6):** a tool may define `rows(args, ctx)` instead of `handler`; the core formats rows for MCP, and `runRowsTool(profile, name, args, engine)` gives a CLI the validated rows to format itself. The spike's four tools now use it | Same shape as the original's `execute` |

## Effort

Porting four tools was mechanical: the query builders moved unchanged, `cdQuery`/`snQuery` became
`sparqlSelect(ctx.http, endpoint, query)`, and `{rows, columns}` stayed `{rows, columns}` (a `rows` tool, C6) with
the core formatting it. The original's
throttle, retry and truncation code disappeared from the profile into host policies and the core.

## Recommendation

Keep C1-C6. C6 was decided by Björn on 2026-11-09 and is built; document-shaped tools (SKOS concepts, CKAN
dataset pages) keep `handler`, list-shaped ones can use `rows`. The spike package stays throwaway: it is not a parliament profile
and should not grow into one without a decision.
