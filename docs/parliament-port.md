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
