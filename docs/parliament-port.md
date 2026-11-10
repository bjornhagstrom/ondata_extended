# Parliament profile, round 1: notes (2026-11-10)

Port of ondata's **italianparliament-mcp** (Andrea Borruso, MIT) at commit `fd46810` (version 0.38.0) to
`packages/profile-parliament`. Round 1: the four tools of the contract spike, ported fully: `legislatures`,
`deputies`, `search`, `sparql`, with every argument, filter, text, example and hint of the original, the search
ranking and the birthplace parsing and filtering, and every helper of the original's `src/core` they need. Written
for folding into `docs/DECISIONS.md` and `docs/test-parity.md` (folded the same day: the decisions entry
"parliament profile, round 1" and the parliament rows and P1-P5 in the deviation list).

## Approach

- **The original's code, the original's layout.** Each ported file mirrors one original file and names it in its
  header ("Ported from ondata/italianparliament-mcp src/... at fd46810 (MIT, see NOTICE.md)"). Queries, Italian
  texts, tool names (no prefix, C1), schemas, examples and annotations are verbatim.
- **Reach changes only**: `Tool.execute(input)` became `execute(input, ctx)`; `cdQuery`/`snQuery` take the engine
  context and send through `ctx.http` (the core's client) instead of the global `fetch`. No module-level HTTP state.
- **The MCP side is the original's `makeHandler`** (`src/server.ts`), handed to the core as a `ToolSpec.handler`.
  The core registers the tool (name, title, description + `examples` via C4, input shape, annotations).
  `ToolSpec.rows` (C6) and `ctx.output.table` (C3) are **not** used, because they cannot reproduce the original's
  text: they project rows onto `columns` (the original prints each row in its own key order; for `deputies` the
  two orders differ), add `structuredContent` (the original has none) and cut at the character limit (the original
  has no cap; a `deputies` row is about 1 150 characters, so its default limit of 100 rows is over 100 000 characters, twice the core's default 50 000). A CLI keeps the original's path:
  `tool.inputSchema.parse(args)` then `tool.execute(parsed, ctx)` (tested in `tests/profile.test.ts`).
- **Host policies**: `dati.senato.it` `{ minIntervalMs: 2000, timeoutMs: 60000 }`, `dati.camera.it`
  `{ timeoutMs: 60000 }`. **Retries stay in the profile** (`src/core/client.ts`, the original's loop: 5 attempts,
  backoff 250 ms doubling to 2 s, everything retried except a 4xx other than 429, including an unparsable 2xx body),
  with the core's retry switched off per request (`retry: { attempts: 1 }`). The core's retry rule (network,
  timeout, 5xx, 429 only) is narrower and would change the outcome for a broken 2xx body; `HostPolicy.retry` (C2)
  is therefore not used by this profile.
- **Same request on the wire**: `GET <endpoint>?query=...&format=application/json`, `Accept: application/json`,
  `User-Agent: italianparliament-mcp/0.38.0` (via `userAgent: { fixed }`). The parity harness checks URL,
  User-Agent and Accept of every request.

## File map

| Original (fd46810) | Here (`packages/profile-parliament/`) | Note |
|---|---|---|
| `src/server.ts` (`describe`, `DEFAULT_EMPTY`, `formatResult`, `makeHandler`, annotations) | `src/server.ts` | `createServer`/`registerAll` not ported (the host builds the server); `toToolSpec` hands a tool to the core |
| `src/tools/types.ts` | `src/tools/types.ts` | `execute(input, ctx)` |
| `src/tools/legislatures.ts`, `deputies.ts`, `search.ts` | same names | ctx threaded through |
| `src/tools/sparql.ts` | `src/tools/sparql.ts` | `stripComments`, `stripLiteralsAndIris`, `injectLimit` and the check itself are the core's (C5, unchanged code); the exported `validateSelectQuery` rethrows the core's refusal with the original's Italian messages |
| `src/core/client.ts` | `src/core/client.ts` | on `ctx.http`; throttle → host policy; `requestCounts` not ported (counter for the original's live test suite) |
| `src/core/current-legislature.ts` | same | ctx; `console.error` instead of `process.stderr.write` (no `process` on Workers; same bytes on Node); module-level cache kept, plus a reset for tests |
| `src/core/endpoints.ts`, `prefixes.ts`, `html-url.ts`, `person-name.ts`, `normalize.ts`, `province-region.ts`, `truncation.ts`, `format.ts`, `zod-error.ts` | same names | verbatim (whole files, including functions round 1 does not call, e.g. `actHtmlUrl`, `preferredName`, `regionFromProvince`) |
| `src/core/flatten.ts`, `types.ts` | same names | re-export the core's `flattenBindings` and `SparqlResults` (identical code, moved to the core by the spike) |
| `src/index.ts`, `src/worker.ts`, `src/cli.ts` | not ported | no host package or CLI in round 1 |

`src/index.ts` (ours): `createParliamentProfile()`, tools in the original's registration order
(`deputies`, `search`, `legislatures`, `sparql`).

## Contract and core changes

Both generic, no backend named (`npm run check:boundaries` green), each with a new core test.

1. **`SparqlValidationError.keyword`** (`packages/core/src/sparql.ts`): the update keyword found, upper case;
   absent when the query does not start with SELECT. Lets a profile word the refusal in its own language
   (rule 3) without duplicating the check or parsing the English message. Test: `core/tests/sparql.test.ts` (+2).
2. **The SDK gets the raw input shape unless the tool is strict** (`packages/core/src/mcp.ts`): before, the core
   always passed `z.object(shape)`. For a non-empty shape the SDK lists the same JSON Schema either way (CKAN
   parity unchanged); for an **empty** shape SDK 1.32.2 lists `z.object({})` with `additionalProperties: false`
   but the raw `{}` as `{ type: "object", properties: {} }`, which is what the original (SDK 1.27.1, raw shape)
   lists for `legislatures`. Found by the `tools/list` parity check. Validation is unchanged (unknown keys still
   dropped). Test: `core/tests/engine.test.ts` (+1).

No contract (`packages/profile-contract`) change.

## Tests

`npm run check` before: 55 files passed, 1 skipped; **1300 passed, 1 skipped**. After (parity reference absent, as
on a machine without the original): 67 passed, 3 skipped; **1406 passed, 78 skipped**. With
`PARLIAMENT_REPO` pointing at the original: 68 passed, 2 skipped; **1482 passed, 2 skipped** (the two recorders).
1406 = 1300 − 14 (spike) + 98 (ported) + 19 (profile tests) + 3 (core).

### Ported from the original (98, expectations unchanged)

| Original (fd46810) | Tests | Here | Reach change |
|---|---|---|---|
| `src/core/flatten.test.ts`, `format.test.ts`, `html-url.test.ts`, `normalize.test.ts`, `person-name.test.ts`, `province-region.test.ts`, `zod-error.test.ts` | 3, 7, 13, 8, 13, 6, 3 | `tests/core/` same names | import paths |
| `src/core/truncation.test.ts` | 21 | `tests/core/truncation.test.ts` | import paths; `rank`, `camera-amendments`, `votes` (not ported) reached through their `limit` fields copied verbatim (`rank.ts:44`, `camera-amendments.ts:31`, `votes.ts:48`), the only part `limitCeiling` reads |
| `src/tools/deputies.birthplace.test.ts`, `deputies.birthplace-filter.test.ts` | 4, 4 | `tests/tools/` same names | import paths |
| `src/tools/sparql.test.ts` | 10 | `tests/tools/sparql.test.ts` | ctx; the three live tests read recordings (Camera recorded; the Senato count synthetic) |
| `src/tools/tools.test.ts` lines 41-88, 746-769 (deputies ×3, legislatures, search ×2) | 6 | `tests/tools/tools.test.ts` | ctx; live endpoints → the parity recording with the same arguments |

Not ported: the rest of `src/tools/tools.test.ts` and the other tool tests (tools not ported);
`src/core/sparql-literal.test.ts` (already ported to `packages/core/tests/sparql.test.ts`; round 1 does not use
`sparqlStringLiteral`, the tools have their own escape functions, as in the original); the other `src/core/*.test.ts`
(helpers of tools not ported yet).

### Spike tests moved (`tests/profile.test.ts`, 14 of 19)

The spike had departed from the original in places; moving its tests onto the real port changed these
expectations toward the original (deliberate, listed for the deviation log):

1. Names next to a prefixed profile: the spike used the SKOS profile, which a profile may not import; an inline
   prefixed profile stands in (`vocab_get_concept` → `other_echo`).
2. `legislatures`: `structuredContent` `{ truncated: false, columns }` → no `structuredContent` (the original has
   none); the column order is now checked on the JSONL row keys instead.
3. `deputies`, `sparql`: notice "troncato dal limite di N righe" (the spike's own text) → "troncato da un limite di
   N righe" (the original's `truncationNotice`).
4. `search`: label `MARIA ELENA BOSCHI, XIX Legislatura della Repubblica` (raw) → `Maria Elena Boschi` (the
   original's display name); legislature URI asserted in addition.
5. Senato 403: the spike's own hint "Non ripetere subito" dropped (not in the original); the whole error text is now
   asserted: `Error: SPARQL error on https://dati.senato.it/sparql (HTTP 403): SPARQL request failed with status 403`.
6. Refused update: English core text → the original's "Solo query SELECT supportate".
7. CLI parity: `runRowsTool` (the tools are `handler` tools now) → `inputSchema.parse` + `execute(input, ctx)` +
   `formatResult`/`toCsv`; the same expectations (defaults `LIMIT 100 OFFSET 0`, empty rows, the empty text, first
   row, CSV header).

The spike's fixture `camera-recorded.json` was not moved: its three answers are keyed by the spike's queries, whose
prefix block differs from the original's (no `xsd:`, `ods:`), so they would never match. The parity recordings hold
the same three calls in their original form (`legislatures`, `deputies-female-limit3`, `search-boschi-leg19`).

New in `tests/profile.test.ts` (5): the request the original sends (Accept, User-Agent); an unparsable 2xx is retried
5 times and ends in the original's text; an answer over the size cap and a redirect loop are not repeated; the current
legislature is asked once per process.

### Black-box parity (`tests/parity/`)

Built like `packages/profile-ckan/tests/parity` (its `replay.ts` copied, with a `synthetic` mark). The original is
loaded in-process from `PARLIAMENT_REPO` (default `../ondata-italianparliament-mcp/repo` next to this repository;
skipped when absent, **fails** when on another commit), with its own SDK copy (1.27.1). Fresh modules per case on
both sides (the original's Senato throttle chain and current-legislature cache are module state).

- **37 cases** (`cases.ts`): `legislatures` (2), `deputies` (8: limit/offset notices, gender, birthplace,
  born-from/to, region with offset, two empty results, a synthetic answer with every birthplace slug shape: two-part
  region, foreign country, one part, `?query#fragment` on the IRI, odd and missing birth dates, unbound variables),
  `search` (10: Camera, multi-token, legislature filter, ranking over 50 Camera rows, truncation, both chambers,
  Senato with `activeOnly` default and explicit, empty Senato, the current-legislature probe failing → fallback 19,
  injection-shaped name), `sparql` (14: counts on both endpoints, a one-line `PREFIX ...#>` query, own LIMIT, empty,
  at the 1000 ceiling, not-SELECT, hidden update, HTTP 400, Senato 403, 503 on every attempt, 502/502/200 flap, a
  broken 2xx body, 429 then 200), and 3 arguments the schema refuses.
- **Checks** (76 tests): every recording is from fd46810 and every Senato exchange synthetic (1); the original
  replays its own recording exactly (37); `tools/list` entries of the four tools equal the original's (name, title,
  description with examples, JSON Schema, annotations, `execution`) and keep its order (1); our profile gives the
  same observation (text, error flag, `structuredContent`) and sends exactly the recorded requests (37).
- **Result: 37/37 equal**, 34 exactly, 3 within deviation P1 below.
- Run: `PARLIAMENT_REPO=/path/to/italianparliament-mcp npx vitest run packages/profile-parliament/tests/parity`
  (the original at fd46810 with `npm ci --ignore-scripts`). Re-record: `PARLIAMENT_PARITY_RECORD=1` (only
  `dati.camera.it` is reached, sequentially, 2.5 s apart, each distinct request once; any senato.it request without a
  synthetic answer throws; `PARLIAMENT_PARITY_NO_LIVE=1` is a dry run with no network).

### Recordings

`tests/parity/recorded/*.json.gz` (37 files, 152 KB), recorded **2026-11-10 00:53-00:55 UTC** from
**dati.camera.it: 18 live requests**, sequential, ≥ 2.5 s apart (public open data: deputies' names, birth dates and
places, election and mandate data, photo and profile URLs as the Camera publishes them). **dati.senato.it: zero
requests**; all Senato answers are synthetic (invented senators with ids 9xxxx, shaped as Virtuoso SPARQL JSON with
the original's variables, typed legislature, M/F gender), as are the Camera failures and edge answers; each synthetic
exchange carries `synthetic: true`.

## Deviations (for the deviation list)

| # | What may differ | Why | Checked |
|---|---|---|---|
| P1 | Argument validation errors (before any tool code): one line per issue, `message at path`, after the same `MCP error -32602: Input validation error: Invalid arguments for tool X: ` prefix, instead of the issues as a JSON array. Same issues, same messages, same error flag, no `structuredContent` | SDK 1.32.2 here, 1.27.1 in the original (as D8 for CKAN) | parity cases `offline-deputies-bad-date`, `offline-search-bad-chamber`, `offline-sparql-limit-range` (`DEVIATIONS` in `parity.test.ts`) |
| P2 | The Senato throttle (≥ 2 s between request starts) also spaces retries; the original throttled once per logical query. Timing only, never output | the core applies a host policy to every request: that is what the host counts | `tests/profile.test.ts` (two searches ≥ 1950 ms apart) |
| P3 | The core's guards apply: 32 MiB body cap, at most 5 redirects each re-validated (the original's `fetch` followed up to 20), DNS/SSRF checks, a timeout that also covers reading the body, and the deployment's rate limit if configured. A guard refusal (an answer over the cap, a redirect loop, a host resolving to a private address, the rate limit) is not retried and reads the core's text (`Error: Response too large (N bytes)`, `Error: Too many redirects (>5)`, ...), where the original would have retried and said `SPARQL request failed after 5 attempts` (or succeeded). An unresolvable host and a timeout are transport failures: retried five times and ending in the original's text, as in the original | all outbound traffic through the core's client (rule 6); repeating a guard refusal cannot help | `tests/profile.test.ts` (size cap, redirect loop) |
| P4 | The current-legislature warning is written with `console.error` instead of `process.stderr.write` (same text and newline on Node; the Workers log on Workers) | no `process` on Workers | not observable in tool output |
| P5 | `requestCounts` (per-process request counter) is not kept | it served the original's live test suite only | none |

No deviation in tool output, `tools/list`, errors or what is sent upstream beyond these.

## Not ported, and why

- The other 39 tools, `bill-progress`, `camera-amendments`, `bill-text` included: out of scope for round 1.
- `src/server.ts` `createServer`/`registerAll`, `src/index.ts`, `src/worker.ts`, `src/cli.ts`: no host package,
  Worker or CLI in round 1. The four `Tool` objects are exported for a CLI.
- `requestCounts` and `src/test-setup.ts`: tooling of the original's live suite.

## Spike package

`packages/spike-parliament` deleted (superseded). References updated: `scripts/fixtures/worker-bundle-entry.ts` (now
bundles `createParliamentProfile()`), `package-lock.json` (entry removed), `NOTICE.md`, `README.md`. Root
`package.json` and the tsconfigs use `packages/*` and needed no change. Still naming the spike package, left for the
folding: `docs/spike-parliament.md` (history), `docs/test-parity.md` (the `spike.test.ts` row), `docs/DECISIONS.md`.

## Open points

- `User-Agent: italianparliament-mcp/0.38.0` and `honestUserAgent` are the original's identity, kept for wire parity
  (as the CKAN profile keeps ondata's browser identity). A release of ours may want its own name (cf. D13).
- The parity reference path: a copy of the original at fd46810 with its dependencies is now at the default path
  (`../ondata-italianparliament-mcp/repo`, beside ondata's CKAN clone), so `npm run check` runs the parity tests on
  this machine (1482 passed, 2 skipped). Elsewhere they are skipped, as the CKAN ones are without `ONDATA_REPO`.
- Contract findings for C2/C3/C6: a faithful port of this backend uses none of `HostPolicy.retry`, `output.table`
  or `rows`, for the reasons above. Options if wanted: a `RowsResult`/`TableOptions` flag for "rows as they are, text
  only, no cap", and a retry predicate on the host policy; or accept `handler` as the way for ported servers.

# Round 2: `bill-progress` (2026-11-10)

Port of the original's `bill-progress` (`src/tools/bill-progress.ts`, 674 lines) with every helper it imports,
transitively, in the same approach as round 1: one ported file per original file, the original's header line, Italian
texts, queries, comments and examples verbatim, reach changed only (the engine context threaded through every
function that queries). Folded into `docs/DECISIONS.md` and `docs/test-parity.md` after review (P6, P7).

## Hosts

`bill-progress` reaches only the two SPARQL endpoints, through `cdQuery`/`snQuery` (round 1's client, `ctx.http`):
`dati.camera.it/sparql` and `dati.senato.it/sparql`. No HTML, AKN, RSS or GitHub fetch: the `html_url`, `rss_url`
and `law_url` columns (camera.it, senato.it, normattiva.it) are strings built from URIs, never requested.

## File map

| Original (fd46810) | Here (`packages/profile-parliament/`) | Note |
|---|---|---|
| `src/tools/bill-progress.ts` | `src/tools/bill-progress.ts` | ctx through `execute`, `countSenatoDdl`, `runSenatoDdlQuery`, `crossBranchPhases`, `cameraIterTimeline`, `cameraLawFromSenato`, `navetteVariants`, `currentLegislature`; `withSenatoLaw`'s lookup is a required argument (P6) |
| `src/tools/bill-signatories.ts` | `src/tools/bill-signatories.ts` | **in part**: only its two pure exported helpers (lines 94-119, verbatim). `cameraPhasePattern` is used by bill-progress; `parseCameraActUri` (a different function from `html-url.ts`'s) comes along because the original's test of this file covers both. The `bill-signatories` tool is not ported |
| `src/core/law-ref.ts` | same | `senatoLawByUri(ctx, uris)` |
| `src/core/decode-html.ts`, `html-entity-variants.ts`, `chamber-uri.ts`, `senato-query-size.ts` | same names | verbatim |
| `src/core/chunk.ts` | same | verbatim; no tool calls it in round 2, it is here because the original's `senato-query-size.test.ts` uses it |
| `src/core/sparql-literal.ts` | same | re-exports the core's `sparqlStringLiteral` (same escapes, same code, as `flatten.ts` in round 1) |
| (round 1) `html-url.ts` (`actHtmlUrl`, `ddlRssUrl`, `parseCameraActUri`), `current-legislature.ts`, `client.ts`, `prefixes.ts`, `flatten.ts`, `types.ts` | unchanged | already ported whole in round 1 |

`src/index.ts`: `billProgressTool` registered in the original's `registerAll` order relative to the ported tools:
`deputies`, `search`, `legislatures`, `bill-progress`, `sparql` (checked by the `tools/list` parity test).

No core or contract change.

## Tests

`npm run check` before (round 1 state, parity reference at the default path): 68 files passed, 2 skipped; **1482
passed, 2 skipped**. After: 76 passed, 2 skipped; **1663 passed, 2 skipped**. Without the parity reference
(`PARLIAMENT_REPO=/nonexistent`): 75 passed, 3 skipped; **1461 passed, 204 skipped**. 1663 = 1482 + 41 (ported
helper and tool unit tests) + 14 (ported `tools.test.ts`) + 126 (63 parity cases × 2).

### Ported from the original (55, expectations unchanged)

| Original (fd46810) | Tests | Here | Reach change |
|---|---|---|---|
| `src/core/decode-html.test.ts`, `chamber-uri.test.ts`, `law-ref.test.ts`, `senato-query-size.test.ts`, `chunk.test.ts`, `sparql-literal.test.ts` | 7, 3, 7, 5, 5, 5 | `tests/core/` same names | import paths |
| `src/tools/bill-progress.law.test.ts` | 3 | `tests/tools/` same name | import paths (the test already injects the lookup, so P6 needs no change) |
| `src/tools/bill-signatories.test.ts` | 6 | `tests/tools/` same name | import paths |
| `src/tools/tools.test.ts` lines 1013-1089, 1107-1248 (bill-progress ×14, its "Senato tools" block) | 14 | `tests/tools/tools.test.ts` | ctx; live endpoints → the parity recording with the same arguments, one recording per `execute` call (22 calls) |

The ported `tools.test.ts` tests that touch Senato read synthetic answers shaped to what the original's tests assert of
the live source (ddl/58034 → L. 177/2025-11-13, ddl/59612 → legge costituzionale 2/2026-05-18, ddl/49285 → the two
pairs 1/687 and 2020-10-19/2100-01-01, ddl/55479 → no law; C.2669 → S.1924; S.1511 exists in leg. 18). Where both
sides of an assertion come from synthetic answers (the countOnly-equals-list test), the test checks the code path,
not the source. The Camera halves (C.302, C.2696, C.703-B, ac18_2617) are live recordings.

`sparql-literal.test.ts` duplicates the five tests round 1 already ported to `packages/core/tests/sparql.test.ts`
(same expectations); it is kept here so the original's file map stays one to one, and is counted once in
`docs/test-parity.md`. `html-entity-variants.ts` has no test in the original (none at fd46810); it is exercised
through the parity case with `'`, `"`, `\` and `è` in the keyword.

### Black-box parity (`tests/parity/`)

**63 new cases** (`cases.ts`, 100 in all; 64 and 101 with P7's case added after review), each run against the original and ours (both replayed from the same
recording):

- Senato list (synthetic Senato), 21: `ddlUri` with an ordinary law, a constitutional law, the ambiguous two-pair law
  and no law; a Senato URI passed as `uri`; `countOnly` with keyword, dates, legislature only, and an unbound count
  (→ `"0"`); keyword list (1000 limit); legislature with limit 3 and 1; no filter at all; a keyword with `'`, `"`,
  `\` and `è` (escape and HTML-entity variants); a date range; empty list; law lookup 403 (the `NOTA` on unverified
  law); 200 rows (law lookup split into two batches under the 2047-byte request-URI limit); every law shape (each
  `natura` with a Normattiva link, an unknown natura, a 2100-01-01 placeholder only, a number without date, a URI not
  `/ddl/<n>`, a row with only `?s` bound); list 403 (error); 502, 502, 200 (the retry loop).
- `--number` on branch S, 10: `1809 S 19`; `1353` with no branch and no legislature (default S, current legislature
  asked live on Camera, navetta suffix `-B`); `1511 S 18`; the cross-branch fallback `2669 S 19` (all phases,
  `La lettura al Senato è S.1924`) and with `limit 1` (truncated notice, no completeness claim); `offset 50` (no
  fallback); a DDL with only a Camera phase (`Nessuna fase al Senato...`); two `idDdl` (one with a `"` the original
  strips) with a phase without status, a four-reading navetta and the law lookup failing (both notices joined); no
  Camera phase (empty hint); ids but no rows (empty hint).
- Camera timeline (live Camera; Senato law lookup synthetic), 20: C.302 (`uri`), C.2696 with keyword `criminalità`,
  C.703-B (final reading, law on the last row), C.703 (navetta notice pointing to C.703-B), C.703 with offset 1 (no
  probe), C.302 through `ddlUri`, keyword without match (Camera hint), an act that does not exist, `2617 C 18` with
  limit 100, limit 1 and `dateFrom 2035` (Camera hint), ac18_2617 with a date window, `2822 C` without legislature
  (current legislature live; navetta notice to C.2822-B), `4144 C 17`; the navette probe failing on every attempt
  (timeline kept, no notice); Camera 503 on every attempt (error); the Camera law lookup failing (403, `NOTA`); a
  synthetic `-A` act (entities, tags and `^^xsd` in titles, an odd date, approved definitively with an ambiguous
  constitutional law, three later readings incl. one without `id`: plural notice); a synthetic act with the law
  lookup failing and one later reading (both notices); a synthetic `-Z` act (no later letter, no probe).
- Refused before any request, 7: unknown host (`uri`, with and without `countOnly`), a look-alike host
  `dati.camera.it.example.org`, an unknown `ddlUri` with the Senato host in its query string, `countOnly` with
  branch C, with `--number`, with a Camera `uri`.
- Refused by the schema, 5 (deviation P1): `number` not digits, `branch` not S/C, `uri` not a URL, `dateFrom` not
  `YYYY-MM-DD`, legislature 0 + limit 1001 + offset -1 together.

**Result: 63/63 equal**, 58 exactly, 5 within P1 (the `offline-bill-progress-*` cases). `tools/list`: the
`bill-progress` entry (title, description with examples, JSON Schema including `format: "uri"`, regex patterns and
the enum, annotations) equals the original's, and the order is the original's.

Harness changes: P1's check accepts a tool name with a hyphen (`[\w-]+`, was `\w+`, which only matched round 1's
names); `PORTED` lists `bill-progress`; the recorder now fails the run when any request was refused (a refused
request would otherwise be recorded as the original's reaction to a failure, which `bill-progress` swallows in two
places: the law lookup and the navette probe), and its dry run (`PARLIAMENT_PARITY_NO_LIVE=1`) writes nothing and
lists the live requests a recording would send.

Runtime: the parity file now takes about 3 minutes (was well under one). Most of it is the Senato host policy (≥ 2 s
between request starts) on both sides: many cases send 2-4 Senato queries. `npm run check` wall time went from about
26 s to about 3 min on this machine.

### Recordings

63 new files in `tests/parity/recorded/` (260 KB), recorded **2026-11-10 01:26:51-01:29:10 UTC** (the five
schema cases at 01:26:51, no request). **dati.camera.it: 22 live requests** (distinct; sequential, ≥ 2.5 s apart,
each asked once and reused across cases), all HTTP 200: 14 timelines, 7 navette probes, 1 current-legislature probe.
**dati.senato.it: zero requests**; every Senato answer synthetic (`synthetic: true`), keyed by the kind of query the
original sends (count, list, cross-branch ids, cross-branch list, law by URI, Camera act's law), with LIMIT/OFFSET
applied as the endpoint would. Invented values: DDL ids 9xxxx, idDdl 99xxx, titles marked `[sintetico]`, law
numbers on invented DDLs; the four real DDL ids carry only what the original's tests assert. Synthetic Camera
answers: the 503s, the failing probe, and the three acts ac19_99001-A, ac19_99002, ac19_99003-Z. No other host.

## Deviations (new; for the deviation list)

| # | What may differ | Why | Checked |
|---|---|---|---|
| P6 | `withSenatoLaw(rows, lookup)` (exported for tests) takes `lookup` as a required argument; the original defaulted it to `senatoLawByUri`. Not model-facing; the original's test always passes it | the default would need the engine context, which a default parameter cannot reach | `tests/tools/bill-progress.law.test.ts` (unchanged) |

| P7 | Line breaks in endpoint values quoted in a plain-text notice (the cross-branch phase list and DDL ids; the navette variants' ids, states, dates and URIs) are folded into a space; the original prints them. The rows are unchanged (JSON strings escape the break) | after review: the notice is the first place a parliament tool puts upstream values outside JSON escaping, so a line break in an endpoint value would start a line of its own in the tool output (rule 6, untrusted content) | parity case `bill-progress-number-2669-S-newline` (synthetic), checked exactly in `DEVIATIONS`; fails without the fix (mutation check) |

P1 also covers the five `offline-bill-progress-*` cases; P2 (the Senato throttle also spaces retries) and P3 (core
guards) apply to `bill-progress`'s Senato and Camera queries as to round 1's. No deviation in tool output,
`tools/list`, errors or what is sent upstream beyond these.

## Not ported (round 2)

- The `bill-signatories` tool and the rest of its file (only its two pure helpers are here).
- `camera-amendments` (round 3), `bill-text` and the other tools; hosts and CLI.
- The original's `src/core/*.test.ts` for helpers not ported (akn, bill-number, camera-legislature, freshness,
  membership-at, ...): `bill-progress` does not import them.

## Open points (round 2)

- Parity runtime (about 3 minutes, Senato spacing). Options: keep; or let the parity harness run the Senato host
  policy with a shorter interval for ours (the original's own throttle cannot be changed, so only half would gain).
- `telemetryFields` unchanged (`chamber`, `legislature`, `endpoint`, `limit`, `offset`); `bill-progress`'s `branch`
  and `countOnly` could be added (no free text). Left as is, not part of the port.
