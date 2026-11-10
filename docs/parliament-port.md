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
| P3 | The core's guards apply: 32 MiB body cap, at most 5 redirects each re-validated (the original's `fetch` followed up to 20), DNS/SSRF checks, a timeout that also covers reading the body, and the deployment's rate limit (on by default, P13). A guard refusal (an answer over the cap, a redirect loop, a host resolving to a private address, the rate limit) is not retried and reads the core's text (`Error: Response too large (N bytes)`, `Error: Too many redirects (>5)`, ...), where the original would have retried and said `SPARQL request failed after 5 attempts` (or succeeded). An unresolvable host and a timeout are transport failures: retried five times and ending in the original's text, as in the original | all outbound traffic through the core's client (rule 6); repeating a guard refusal cannot help | `tests/profile.test.ts` (size cap, redirect loop) |
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

# Round 3: `camera-amendments` (2026-11-10)

Port of the original's `camera-amendments` (`src/tools/camera-amendments.ts`), the first parliament tool that reads
HTML instead of SPARQL JSON, in the approach of rounds 1 and 2: the original's file, its header line, Italian texts,
comments, selectors and examples verbatim, reach changed only. Written for folding into `docs/DECISIONS.md` and
`docs/test-parity.md` (P8).

## What the tool reads

Three kinds of page, each with one `GET` and the original's headers (`User-Agent: Mozilla/5.0 (italianparliament-mcp;
+https://github.com/ondata/italianparliament-mcp)`, `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`,
`Accept-Language: it-IT,it;q=0.9,en;q=0.8`):

1. the scheda atto, `https://www.camera.it/leg{L}/126?leg={L}&idDocumento={id}` (`actHtmlUrl`, round 1);
2. only when the scheda has no direct link: the per-act index
   `https://documenti.camera.it/apps/emendamenti/ostr/{L}?attoportante=leg.{L}.eme.ac.{id}`;
3. each distinct `getProposteEmendative.aspx` link found (relative links resolved against
   `https://documenti.camera.it/apps/emendamenti/`), one after another, stopping early in list mode once `limit` rows
   are in.

The original sends these with the global `fetch` (`redirect: "follow"`), outside its SPARQL client: no retry, no
throttle, no timeout. Here they go through `ctx.http`, still without retry (`retry: { attempts: 1 }`) or throttle, and
**without a host policy** (the original has none for these hosts). Parsing is the original's: `cheerio/slim`, the same
selectors.

## File map

| Original (fd46810) | Here (`packages/profile-parliament/`) | Note |
|---|---|---|
| `src/tools/camera-amendments.ts` | `src/tools/camera-amendments.ts` | `fetchHtml(ctx, url)` on `ctx.http` (see below); `execute(input, ctx)`; everything else verbatim |
| `src/cheerio-slim.d.ts` | not ported | a type shim for `cheerio/slim` under the original's `moduleResolution: "node"`; this repository resolves with `"bundler"`, which reads cheerio's `exports` map, so `import * as cheerio from "cheerio/slim"` type-checks as is |
| `src/core/html-url.ts` (`actHtmlUrl`, `parseCameraActUri`) | unchanged | ported whole in round 1 |

`camera-amendments` imports nothing else from the original (no `decode-html`: names and numbers come from cheerio's
`.text()`, which decodes entities itself). `src/index.ts`: registered in the original's `registerAll` order relative
to the ported tools: `deputies`, `search`, `legislatures`, `bill-progress`, `camera-amendments`, `sparql`.

`fetchHtml` (the only reach change):

- `ctx.http.request(url, { method: "GET", headers: { Accept, "Accept-Language" } }, { userAgent: { fixed: UA },
  timeoutMs: 60 000, retry: { attempts: 1 }, fixedUpstream })`. A non-2xx answer throws the original's
  `Recupero fallito (<status>) su <url>`; the body is never read into a message.
- `fixedUpstream` is set when the URL's host is `www.camera.it` or `documenti.camera.it` (the scheda, the ostr index,
  every relative list link): the deployment's domain allowlist does not apply to the first hop of the tool's own
  upstream. An absolute list link to any other host (from page content) is checked against the allowlist.
- A transport failure of kind `network` or `not-found` (DNS, socket) is rethrown as `TypeError("fetch failed")`, the
  text the original's `fetch` gives on Node, so the tool answers `Error: fetch failed` as the original does.

## Dependency

`cheerio` `^1.2.0` added to `packages/profile-parliament/package.json` (the original's range; lockfile resolves
`1.2.0`, as the original's). Every package in its tree that the bundle uses resolves to the original's version:
cheerio-select 2.1.0, css-select 5.2.2, css-what 6.2.2, domhandler 5.0.3, domutils 3.2.2, dom-serializer 2.0.0,
htmlparser2 10.1.0 (with entities 7.0.1), entities 4.5.0, nth-check 2.1.1, boolbase 1.0.0, domelementtype 2.3.0. Only
cheerio's `undici` dependency (used by its full entry's `fromURL`, not by `slim`) differs: it dedupes onto the
workspace's existing `undici` 7.30.2 (the original nests 7.28.0). Installed with `--ignore-scripts`; `npm audit`
reports nothing new (its one finding, `zod <4.6.6`, was there before). `package-lock.json`: +295 lines (22 packages,
the full cheerio tree including the parse5/encoding-sniffer branch that `slim` does not load).

**Workers:** imported as the original does (`cheerio/slim`: htmlparser2 only, no encoding-sniffer/iconv-lite, so no
`buffer`). `npm run check:worker-bundle` passes; the probe bundle (core + every profile) grew from **574 KiB to 772
KiB** minified (+198 KiB: entities' decode tables 76 KiB, htmlparser2 59 KiB, cheerio 21 KiB, css-select 13 KiB, the
rest under 10 KiB each). No static Node import; the only `require(` strings in the bundle are ajv's generated-code
literals, as before. `host-vocab` (406 KiB) and `host-ckan` (519 KiB) do not include the profile and are unchanged.

## Contract and core changes

None. `npm run check:boundaries` green.

## SPARQL endpoints as the profile's own upstream (follow-up)

`cdQuery`/`snQuery` (`src/core/client.ts`, rounds 1-2) now send with `fixedUpstream: true`, as camera-amendments' HTML
requests do and as profile-ckan does for its MQA and registry calls: `https://dati.camera.it/sparql` and
`https://dati.senato.it/sparql` are the profile's constant endpoints, not URLs from a caller, so a deployment's
`ALLOWED_DOMAINS` no longer has to name them for the profile to work. A redirect hop is still checked against the
allowlist (and, as a guard refusal, not retried). Not a deviation from the original, which has no allowlist; no tool
output or request changes. Tests in `tests/profile.test.ts` (2): with `ALLOWED_DOMAINS=example.org` `legislatures`
still answers from dati.camera.it; a 302 from the endpoint to `elsewhere.example.net` is refused (`Error: Domain
"elsewhere.example.net" is not in the allowed list (PARLIAMENT_ALLOWED_DOMAINS).`) after one request. Both fail
without the flag (mutation check).

## Tests

`npm run check` before (round 2 state, parity reference present): 76 files passed, 2 skipped; **1665 passed, 2
skipped**. After: 76 passed, 2 skipped; **1741 passed, 2 skipped**. 1741 = 1665 + 4 (ported `tools.test.ts`) + 8
(`profile.test.ts`: 6 camera-amendments, 2 SPARQL `fixedUpstream`) + 64 (32 parity cases × 2). No new test file.

### Ported from the original (expectations unchanged)

| Original (fd46810) | Tests | Here | Reach change |
|---|---|---|---|
| `src/tools/tools.test.ts` lines 1769-1824 (camera-amendments ×4, in its "Senato tools" block) | 4 | `tests/tools/tools.test.ts` | ctx; the live pages → the parity recording with the same arguments (`camera-amendments-2696-count`, `-2696-list`, `-2402-leg18`: scheda, index and lists all live; `-senato-uri`: no request); the U+00A0 in `"Locatelli Alessandra"` kept byte for byte |
| `src/core/truncation.test.ts` | (21, already ported) | `tests/core/truncation.test.ts` | its `cameraAmendmentsTool` is now the ported tool instead of the copied `limit` field (rank and votes still stand in) |

The original has no other test of this tool or of a parser (no `camera-amendments.test.ts`); `html-url.test.ts`
(covering `actHtmlUrl` and `parseCameraActUri`) was ported in round 1.

The values the original's tests assert of the live source all hold on the 2026-11-10 recording, with the live schede:
AC 2696 referente 37 / Assemblea 25, 62 rows in list mode (its live scheda links both lists directly); AC 18-2402
referente 54 / Assemblea 53 (its live scheda has no direct link, so the ostr fallback runs, as the test says),
amendment 1.52 in Assemblea by `Locatelli Alessandra` (with the no-break space). No expectation needed a change.

### New in `tests/profile.test.ts` (6 for camera-amendments)

What the parity harness cannot show (it replays at the `fetch` boundary, and the original's `fetch` would not follow a
replayed redirect): the three headers on both hosts; no retry on a failed page (one request, the original's error); a
socket failure reads `Error: fetch failed`; a redirect is followed and a loop stops after 5 (`Error: Too many redirects
(>5)`); a page over the size cap is refused (`Error: Response too large ...`); with `ALLOWED_DOMAINS=dati.camera.it`
the scheda and documenti.camera.it are still reached, and a list link to another host is refused before any request.

### Black-box parity (`tests/parity/`)

**32 new cases** (133 in all), each run against the original and ours, replayed from the same recording:

- AC 2696 with the live scheda (scheda and lists live), 6: `countOnly` (the sentinel 37/25) and list mode (62 rows),
  the original's tests; the schema defaults; `limit` 1 (the second list never asked), 40 (between the two lists), 62
  (exactly the total: notice); `countOnly` with `limit` 1 (the original's notice under two count rows).
- AC 2696 with a synthetic scheda on purpose (lists live), 4: no direct link (the ostr fallback, index live); the
  direct links as relative `&amp;` hrefs plus a `...Seduta.aspx` link that must not count (`countOnly`); an absolute
  link, a link with a line break and spaces inside and a duplicate (list mode); the lists in the opposite order with
  `limit` 30.
- Other live acts, 4 (all live): AC 18-2402 (the original's fallback test: no direct link on the scheda, ostr index,
  107 rows); the variant act AC 19-703-B (`countOnly`: referente 0, Assemblea 2, linked from its scheda); an act that
  does not exist (AC 19-999999: the live scheda is a valid page with the markers and no link, the ostr index links
  nothing → the empty text, list and `countOnly`).
- The URI's host is not checked by the original's pattern: `https://example.org/x/attocamera.rdf/ac19_2696` reads
  AC 2696 (live), 1.
- Synthetic lists, 4: every shape the parser handles (article headers incl. one with a non-numeric id, relative /
  absolute / whitespace-padded text links, entities, `(ident. ...)` normalisation, rows without number or signatory,
  a non-numeric `idPersona`, rows that are not amendments, a row with no class, a line break and markup in a
  signatory; sedes from a percent-encoded `sedeEsame`, from `:ass:`, `n.d.` with neither, a list on another host,
  an empty table), list and `countOnly`; a list page without the table (maintenance page), list and `countOnly`.
- Failures, 5: scheda 503 and 404; ostr index 500; a list 502 under `countOnly`; a 200 that is not a scheda (an
  anti-bot page without the markers: the original's long error, not an empty result).
- Refused before any request, 4: a Senato DDL (the original's test), a deputy URI, `ac19_` without id, a trailing
  slash.
- Refused by the schema, 3 (deviation P1): `billUri` not a URL; `limit` 5001; `billUri` missing + `countOnly` a string
  + `limit` 0.

**Result: 32/32 equal**, 29 exactly, 3 within P1 (the `offline-camera-amendments-*` cases). `tools/list`: the
`camera-amendments` entry (title, description with examples, JSON Schema with `format: "uri"`, defaults, range,
annotations) equals the original's, and the order is the original's. Mutation checks: ours with a different
`Accept-Language` fails on `HEADERS DIFFER`; ours stripping only spaces (not all whitespace) from hrefs fails 8 cases.

Harness changes (CKAN's copy untouched): `replay.ts` compares `accept-language` too (the SPARQL requests send none, so
the earlier recordings compare as before); `record.test.ts` may reach `www.camera.it` and `documenti.camera.it` live
besides `dati.camera.it` (same rules: sequential, ≥ 2.5 s apart, each distinct request once; senato.it never), and
with `PARLIAMENT_PARITY_REUSE_LIVE=1` serves a request from a live answer already in the recordings instead of asking
again (used to record in steps without asking anything twice); a dry run now lists only the requests that would
really go out. `cases.ts` has an HTML helper (`text/html; charset=utf-8`) and a synthetic scheda. No change was needed
for HTML answers in `replay.ts`: bodies are stored as text (UTF-8) or base64 whatever the content type; the live
schede and ostr indexes come as `text/html; charset=utf-8`, the lists as `application/xhtml+xml`.

### Recordings

32 new files in `tests/parity/recorded/` (29 cases + 3 schema cases; 440 KB, most of it the live schede, 37-303 KB
each before gzip). Recorded on 2026-11-10 in three steps, every live request distinct, sequential, ≥ 2.5 s apart, all
HTTP 200:

| Step (UTC) | Host | Live requests |
|---|---|---|
| 01:58:36-01:58:42 | documenti.camera.it | 3: the ostr index of AC 19-2696 and its two lists |
| 02:00:22-02:00:48 | documenti.camera.it | 7: the ostr indexes of AC 18-2402, 19-703-B, 19-999999 and the two lists each of 2402 and 703-B (schema cases at 02:00:48, no request) |
| 02:09:15-02:09:30 | www.camera.it | 4: the schede of AC 19-2696, 18-2402, 19-703-B, 19-999999 (everything else reused) |

Totals: **www.camera.it 4, documenti.camera.it 10, dati.camera.it 0, senato.it 0**, no other host. One documenti
answer (the ostr index of 703-B) is no longer used by any case: the live scheda of 703-B links its lists directly. The
files now hold 9 distinct documenti.camera.it answers and 4 www.camera.it answers; every file's `recordedAt` is in
02:00:48-02:09:30 (step 3 rewrote the camera-amendments files, reusing the earlier live answers).

**Synthetic by design** (`synthetic: true`, scheda title and heading marked `[sintetico]`): the schede of the four
AC 2696 cases above that need a scheda shape (no link, link shapes, list order), all failures, the anti-bot page, the
maintenance page, and the parser-shape lists and their schede (act ids 99010-99013, invented names and person ids
9000xx, a list on `example.org`). Public content in the live pages: amendment numbers, articles, first signatories'
names and Camera person ids, and the schede as the Camera publishes them.

## Deviations (new; for the deviation list)

| # | What may differ | Why | Checked |
|---|---|---|---|
| P8 | camera-amendments' HTML requests go through the core: its guards (DNS/SSRF, the 32 MiB cap, the deployment's rate limit (on by default, P13)) apply; at most 5 redirects, each re-validated (the original's `fetch` followed up to 20, anywhere); a 60 s timeout covering the body (the original had none; 60 s is the profile's longest, its SPARQL timeout); an undeclared gzip body is unpacked by its magic bytes (the original would decode the bytes as text). A guard refusal, a redirect loop and a timeout read the core's text (`Error: Response too large (N bytes)`, `Error: Too many redirects (>5)`, `Error: Request timeout connecting to <url>`); a socket/DNS failure reads the original's `Error: fetch failed`. With a domain allowlist configured, the first hop to `www.camera.it`/`documenti.camera.it` is exempt (`fixedUpstream`), but a redirect hop and an absolute list link to any other host must be listed (the original reached them) | all outbound traffic through the core's client (rule 6) | `tests/profile.test.ts` (6 tests: headers, no retry, `fetch failed`, redirect followed and loop, size cap, allowlist) |

P1 also covers the three `offline-camera-amendments-*` cases. No P7-style folding is needed: everything
`camera-amendments` takes from a page goes into the JSONL rows (JSON strings escape a line break), and the only page
values outside JSON are list URLs in an error message, from which the original already strips all whitespace
(`replace(/\s+/g, "")`). No deviation in tool output, `tools/list`, errors or what is sent upstream beyond P1 and P8.

## Not ported (round 3)

- `bill-text` (needs Björn's approval) and the other tools; hosts and CLI (the `camera-amendments list` command of
  `src/cli.ts`).
- `src/cheerio-slim.d.ts` (not needed, see the file map).

## Open points (round 3)

- A deployment with `ALLOWED_DOMAINS` needs `www.camera.it`, `documenti.camera.it` (and, for the SPARQL tools,
  whatever host an endpoint redirects to) listed only for redirects to be followed; the first hop to each of the
  profile's own hosts is exempt.
- Whether a live scheda request redirects is not visible in the recording (the recorder's `fetch` follows redirects,
  as the original's does); the four recorded schede answered 200 at the URL asked for, or after a redirect the
  recorder followed.
- The live pages are cumulative and change: the original's sentinel counts (37/25, 54/53) hold today; a re-record may
  shift them, and the ported `tools.test.ts` tests would then fail, as the original's live tests would.

# Round 4: host (2026-11-10)

`packages/host-parliament`: the parliament profile deployed as the original's server, on the core's hosts, modelled
on `packages/host-ckan`. Out of scope: the CLI (`src/cli.ts`, citty), `bill-text`, the other tools, the DXT manifest,
deploying.

## What the original's entries do (fd46810)

- **`src/index.ts`** (bin `italianparliament-mcp` in its `package.json`; the other bin, `italianparliament`, is the
  CLI): `createServer()` (name `italianparliament-mcp`, version `0.38.0`), `registerAll`, `StdioServerTransport`.
  Nothing on stderr while it runs; on a startup failure `Fatal: <message>` and exit code 1. No HTTP mode on Node and
  **no environment variable read anywhere in `src/`** (checked with grep), so there are no setting names to keep.
- **`src/worker.ts`** (`wrangler.toml`: name `italianparliament-mcp`, `nodejs_compat`, observability on, **no
  analytics binding**):
  - `GET /`: a JSON info document `{"name":"italianparliament-mcp","version":"0.38.0","description":"MCP server for
    querying Italian Parliament SPARQL endpoints (Camera + Senato)","mcp_endpoint":"/mcp","tools":43}`,
    `Content-Type: application/json`, `Access-Control-Allow-Origin: *`. No HTML landing page.
  - `GET /health`: `{"status":"ok","runtime":"cloudflare-workers"}`, same headers. No version, no counts.
  - `OPTIONS /mcp`: 200, empty body, `Access-Control-Allow-Origin: *`, `-Allow-Methods: POST, OPTIONS`,
    `-Allow-Headers: Content-Type`.
  - `POST /mcp`: a new server per request, stateless `WebStandardStreamableHTTPServerTransport` with the SDK's
    default answer, an **SSE stream** (not `enableJsonResponse`); `Access-Control-Allow-Origin: *` added. On an
    exception: 500 with the exception's message in a JSON-RPC error.
  - Anything else, `GET /mcp` and `DELETE /mcp` included: `404 Not Found`, plain text, no CORS header.
  - No log line, no data point, no service-notice headers.

## Design

- **`src/server.ts`**: `SERVER_NAME = "italianparliament-mcp"`, `SERVER_VERSION = profile.version` (`0.1.0`, one
  semver for the platform, as D13 for CKAN), `CONFIG_PREFIXES = ["PARLIAMENT"]` (the core's settings:
  `PARLIAMENT_ALLOWED_DOMAINS`, `PARLIAMENT_RATE_LIMIT_*`, ...; the original reads none), `createParliamentEngine`,
  `buildServer`, as `host-ckan`.
- **`src/node.ts`**: the original's `main()`: `runStdio(buildServer(engine))` with no status line, `Fatal: ...` and
  exit 1 on failure. No `TRANSPORT=http` (the original has none).
- **`src/worker.ts`**: the core's `createWorkerHandler` serves `GET /` (the info document as `landing`), `GET /health`
  and `POST /mcp` (with `jsonResponse: false`, so the answer is an SSE stream as the original's); a thin router in
  front answers the original's preflight and its bare 404 for every other route, which differ from the core's
  CKAN-shaped ones (204 preflight with more methods, 405 on `GET /mcp`, CORS on 404). No `logEntry`, `analytics` or
  `extraHeaders`: the original has none.
- **One engine per isolate** (`engine ??= createParliamentEngine(env)`), as `host-ckan`: the engine holds the host
  policies, so the Senato throttle (≥ 2 s between request starts) spans every request the isolate serves, as the
  original's module-level throttle chain does. An engine per request would give each request its own throttle and
  let concurrent requests reach `dati.senato.it` back to back (the block that does not decay). Tested, and the test
  fails with an engine per request (checked by making that change).
- **`wrangler.toml`**: name `ondata-extended-parliament`, `main = "dist/worker.js"`, `nodejs_compat`,
  `send_metrics = false`, observability on, no `[vars]` and no analytics binding. **Not deployed.** Root scripts:
  `deploy:parliament` (like `deploy:ckan`; not run) and `build` now also builds this package.

## Core changes

Both generic, defaults unchanged (CKAN and vocabulary hosts and their parity tests unaffected):

1. `WorkerHostOptions.jsonResponse` (`packages/core/src/worker.ts`), default `true`: with `false`, `POST /mcp` is
   answered as the transport's SSE stream. The log line's status and error summary are read from a JSON body only, so
   with SSE they would say `ok`; no deployment logs with SSE today. Test: `core/tests/engine.test.ts` (+1).
2. `runStdio(server, label?)` (`packages/core/src/node/stdio.ts`): without a label, no status line on stderr (the
   original prints none). Tested through the binary test (stderr empty).

## File map

| Original (fd46810) | Here (`packages/host-parliament/`) | Note |
|---|---|---|
| `src/server.ts` `createServer` (name, version) | `src/server.ts` | name kept, version ours (P9); `registerAll` → `registerProfiles` |
| `src/index.ts` | `src/node.ts` | `runStdio` without a label; the same `Fatal:` line |
| `src/worker.ts` | `src/worker.ts` | core host for `/`, `/health`, `POST /mcp`; the original's preflight and 404 in the router |
| `package.json` bin `italianparliament-mcp`, `build`, `build:worker` | `package.json` | same bin name; builds as `host-ckan`'s (SDK, express, zod, undici external; cheerio bundled) |
| `wrangler.toml` | `wrangler.toml` | our Worker name, `send_metrics = false`, no `[build]` (the root script builds) |
| bin `italianparliament` (`src/cli.ts`), `manifest.json`, `build:dxt` | not ported | out of scope |

## Tests

`npm run check` before: **1741 passed, 2 skipped**. After (the parliament parity reference present at the default
path): 79 files passed, 2 skipped; **1774 passed, 2 skipped** = 1741 + 21 + 10 + 1 + 1 (core). Without the reference
copy the 21 Worker parity tests are skipped, as the profile's parity tests are.

- **`tests/worker-parity.test.ts` (21)**: the original's `src/worker.ts` is imported in-process from
  `PARLIAMENT_REPO` (the profile's parity helper: skipped when absent, fails on another commit), ours beside it,
  fresh modules per test; both get the same `Request` and are compared on status, headers (all but `Date`) and body.
  - Equal (12, P11 mapped on SSE answers): `GET /health`; `GET /mcp`, `DELETE /mcp`, `OPTIONS /`, `GET /other`,
    `POST /` (all the bare 404); `OPTIONS /mcp`; `POST /mcp` `initialize` (P9 mapped), broken JSON, without the SSE
    `Accept` (406), a notification (202), an unknown method.
  - `GET /`: equal byte for byte once `version` and `tools` are set to ours (P9, P10); the original's values are
    asserted (`0.38.0`, 43), ours (`0.1.0`, 6).
  - `tools/list`: status and headers equal; our six entries equal the original's entries for those names, in its
    order; the original lists 43; everything around the list equal (P10).
  - Tool calls refused before the network, with `fetch` stubbed to record any request (none made, on either side), 6:
    `sparql` CONSTRUCT and a hidden update, `bill-progress` on an unknown host and a look-alike host,
    `camera-amendments` without an act id, an unknown tool.
  - A tool call answered from the parity recording `legislatures` (dati.camera.it, recorded 2026-11-10): both
    sides send exactly the recorded request and give the same SSE answer.
  - **Result: 21/21**; the only differences are P9, P10, P11, each asserted to be exactly that.
- **`tests/host.test.ts` (10)**, without the reference copy: name, version, prefix; the info document; health bytes;
  the preflight; the bare 404 (`GET /mcp` included, no CORS); `POST /mcp` as SSE with the six tools; no log line for a
  tool call; the Senato throttle across two separate `/mcp` requests (≥ 1950 ms; `fetch` stubbed, no request leaves
  the process); P12 (a thrown exception gives `Internal error`, the message not echoed); `wrangler.toml` (name,
  `send_metrics = false`, observability, no analytics binding).
- **`tests/binary.test.ts` (1)**: builds `src/node.ts` as the package script does, runs it over stdio: `initialize`
  gives `serverInfo` `{ name: "italianparliament-mcp", version: "0.1.0" }`, `tools/list` the six tools in the
  original's order, stderr empty. No tool called.
- Core: +1 (`jsonResponse`).
- No live request in any of these tests; none to senato.it.

Workers bundle (`npm run check:worker-bundle`, now with `packages/host-parliament/src/worker.ts`): **621 KiB**
minified, no static Node import (probe 772, `host-vocab` 406, `host-ckan` 519, unchanged). The Node binary
`dist/index.js` is 428 KB.

## Deviations (new; for the deviation list)

| # | What may differ | Why | Checked |
|---|---|---|---|
| P9 | The version is ours, `0.1.0`, where the original says `0.38.0`: the info document at `/` and `serverInfo` of `initialize` (Worker and stdio). The upstream `User-Agent` stays `italianparliament-mcp/0.38.0` (round 1) | one semver for the platform (as D13 for CKAN) | `worker-parity.test.ts` (`/`, `initialize`), `binary.test.ts` |
| P10 | The deployment serves the six ported tools, not 43: `tools/list` lists those six (each entry equal to the original's, in its order), and the info document at `/` says `"tools":6`. A call to any other tool gets the SDK's `Tool X not found` | the port is in rounds; the count states what this deployment serves | `worker-parity.test.ts` (`/`, `tools/list`), `host.test.ts` |
| P11 | SSE answers on `POST /mcp` carry `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` where the original sends `Cache-Control: no-cache` | MCP SDK 1.32.2 here, 1.27.1 in the original (as P1) | `worker-parity.test.ts` (every SSE answer: exactly these two, the rest equal) |
| P12 | An exception while serving `/mcp` answers 500 with `{"code":-32603,"message":"Internal error"}`; the original puts the exception's message there. The detail goes to the Worker log (`console.error`) | no internal detail to callers (core rule, GHSA-6f9w in ondata) | `host.test.ts` |
| P13 | The core's settings apply under `PARLIAMENT_*`: a domain allowlist if set, and the core's per-host upstream rate limit, **on by default** outside tests (5 requests/s, burst 10, at most 5 s wait per request, then a refusal; per isolate on Workers, per process on Node; `PARLIAMENT_RATE_LIMIT_ENABLED=false` turns it off). The original has no limit beyond the Senato throttle. Timing only for a single call; under concurrent load a call can be refused | the core's guard for every deployment; the profile's P3/P8 say "if configured", which for this host means "unless turned off" | not tested here (the core's `rate-limiter.test.ts`) |

No difference in routes, statuses, the other headers, `/health`, the preflight, the 404s, the tool answers or the
requests sent upstream beyond P9-P13 (and the profile's P1-P8).

## Open points (round 4)

- **Rate limit default (P13)**: keep the core's default (protective, as the CKAN and vocabulary hosts) or turn it off
  for this host to match the original. Claude kept the default.
- **`/health` without a version**, as the original; `docs/testing-application.md` keeps "a version number in
  `/health`" open. Adding one would be a deviation from the original's body.
- **Not deployed**; `wrangler deploy --dry-run` not run either (wrangler may contact the network). A test deployment
  should set a service notice somewhere (the original has no notice headers and the info document has no notice
  field), or accept that the Worker looks like the original's apart from P9-P13.
- The stdio binary has no HTTP mode (as the original). The core's Node HTTP host could serve one under
  `PARLIAMENT_HTTP_*` if wanted; that would be an addition, not parity.
- The info document's `tools` counts the profile's tools (6); it will follow the profile as rounds add tools.
