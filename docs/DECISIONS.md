# Decisions

Dated record of why things are the way they are. Owner: Björn Hagström.

## 2026-11-09: project start

- **Repository**: private and local to begin with; working name `ondata_extended` (the directory name). No remote,
  no npm publishing, no hosted deployment until decided. Names may change later.
- **Language**: everything in English (code, comments, commits, docs, review material). User-facing GUI text
  (landing page and similar) goes through language files, `en` and `sv`.
- **AI disclosure**: AI assistance is disclosed in this repository (commit trailers, PR texts) and in anything sent
  upstream to ondata, in line with ondata's `CONTRIBUTING.md` ("AI-Assisted Contributions").
- **SDK**: `@modelcontextprotocol/sdk` 1.x (1.32.2), wrapped inside core so that a later move to v2
  (`@modelcontextprotocol/server`) is a core-only change.
- **SKOS profile tool prefix**: `vocab_`.
- **MVP tool set**: chosen by us for now; every tool name and argument is reviewed and decided before anything is
  sent to ondata.
- **Live smoke tests** (CKAN portals): nightly and before release, not on every change.
- **Smoke target for SKOS**: begrepp.hagstrom.nu. Its content will change, but only slightly; smoke cases name
  stable concepts (2, 10, 36).
- **Hosting**: deferred. Work is local (stdio, local Node HTTP, `wrangler dev` to prove Workers compatibility).
- **License**: derivative of ondata/ckan-mcp-server (MIT, copyright onData association); MIT LICENSE and NOTICE
  with attribution from the first commit.

## 2026-11-09: test rule

Tests must be at least as comprehensive as ondata's today and cover new code and features; new code may create the
need for new or changed tests. Three principles: (1) how a test reaches the code may change; (2) expectations,
fixtures and smoke cases for existing behaviour are not weakened, and any deliberate change is logged with its
reason; (3) black-box parity for every CKAN tool against ondata at `09e8cdc`. Details and the deviation list:
`docs/test-parity.md`.

## 2026-11-09: core design (step 3)

- **Layout**: npm workspaces. `packages/profile-contract` (types only), `packages/core` (engine; Node-only
  transports under the `./node` export), `packages/profile-skos`. Profiles import the contract and the core, never
  each other. `scripts/check-boundaries.mjs` enforces it, plus "no backend words in the core" and "no static Node
  imports outside `core/src/node`". `scripts/check-worker-bundle.mjs` proves the Workers bundle still builds.
- **Config prefixes instead of fixed names**: a setting has an unprefixed name (`ALLOWED_DOMAINS`); each deployment
  lists its prefixes in lookup order. The CKAN deployment will use `["CKAN"]` (identical names for users), the
  vocabulary deployment its own. Messages name the primary variable.
- **One HTTP path (fetch) on Node and Workers.** ondata used axios on Node; on Node the fetch path gets the same DNS
  pinning through the undici dispatcher, so axios is not needed in the core. Consequence: ondata tests that mock
  axios will be re-reached through a fake `ctx.http` or a local server when the CKAN profile is ported (principle 1).
- **`request` never throws on an HTTP status**; the profile interprets status and envelope. `json` is a convenience
  that throws `HttpStatusError`/`TransportError`. The core never echoes an upstream body in a message (GHSA-6f9w).
- **The private-host exemption is per request** (deviation D1 in `docs/test-parity.md`). Found by a new test: the
  strict path could reach a listed private IP literal, because Node skips the DNS lookup for literals.
- **Size cap on decompressed bytes while streaming** (D2).
- **Per-call telemetry is keyed by McpServer instance** (generalized from ondata's search telemetry), which also
  replaces ondata's module-global "last cache hit".
- **Registration checks**: unique tool names across profiles, the profile prefix (unless a tool is `shared`), and
  that every tool a prompt names exists (would have caught ondata's `ckan_resource_show` reference).
- **TemaTres: JSON from `services.php` only**, parsed with document order kept (integer-like keys would otherwise be
  reordered by `JSON.parse`); recorded answers from begrepp.hagstrom.nu are the fixtures.

## 2026-11-09: SKOS profile MVP (step 4)

- **Eight tools**: `vocab_search_concepts`, `vocab_get_concept`, `vocab_broader`, `vocab_narrower`, `vocab_related`,
  `vocab_top_concepts`, `vocab_suggest`, `vocab_scheme_info`. All read-only; `response_format` markdown|json; a
  concept by local id or concept URI; `vocab` optional (known id or service base URL). Names are provisional until
  decided before anything goes to ondata.
- **TemaTres adapter**: a concept is seven parallel cached calls (`fetchTerm`, `fetchDirectTerms`, `fetchDown`,
  `fetchNotes`, `fetchUp`, `fetchTargetTerms`, `fetchURI`) plus the cached scheme data; an unknown id is "not
  found" even if the other calls fail. Notes: HTML → text, fenced as untrusted; TemaTres private notes (`NP`) are
  never shown; the vocabulary's admin e-mail is not repeated. Quirks found on the way are in
  `docs/tematres-api-derisking.md`.
- **Deployment package** `packages/host-vocab`: stdio binary `vocab-mcp-server`, Node HTTP (`TRANSPORT=http`), Worker
  entry with `/`, `/health`, `/mcp`; landing page and health counts generated from the profile; GUI text in
  `src/i18n/{en,sv}.json`. Config prefixes `VOCAB_*`, then `ENGINE_*`. `wrangler.toml` is for local `wrangler dev`
  only.
- **Proof**: `npm run smoke:vocab` (10 known-answer cases against begrepp.hagstrom.nu, run 2026-11-09: 10/10);
  profile tests end to end through a real MCP client with recorded answers; `evals/skos/` holds 16 tool-selection
  cases, with no automated runner yet (needs an API key: owner's decision).
- **Known limit**: JSON truncation shrinks only top-level arrays, so a huge concept (thousands of narrower terms)
  is cut by the generic fallback rather than by shrinking `concept.narrower`. Fine for the test vocabulary; revisit
  with nested shrink paths in the contract if a real vocabulary needs it. Changed 2026-11-19: see "one concept in JSON is cut
  inside the concept".

## 2026-11-09: reviewer model

`mcp-reviewer` runs on `fable` (Björn's decision), not on the author's model (`opus`).

## 2026-11-09: Node versions

Tested by running the full suite (278 tests) and a standalone dispatcher check on Node 20.18.1, 20.20.2, 22.23.4 and
24.15.0: all green. Node 20/22 bundle undici 6; their `fetch` drives our undici 7 `Agent` through undici 7's
legacy-handler adapter (`dispatcher-base.js`, `wrap-handler.js`), a supported path. Keep `undici@^7` (not `>=7`):
an undici 8 that drops the adapter would break Node 20/22. `engines.node` set to `^20.19.0 || >=22.12.0` to match
vite 8's declared floor.

## 2026-11-09: contract spike against a third backend (parliament)

Björn decided to run the pre-study's spike: four tools of ondata's italianparliament-mcp on the core
(`packages/spike-parliament`, throwaway). Contract changes driven by it, each the smallest that worked: optional
`toolPrefix` (C1), `hostPolicies` and `FetchOptions.retry` (C2), `ctx.output.table` and `text(..., { trailer })`
(C3), `ToolSpec.examples` (C4), shared SPARQL helpers in the core (C5). Not added because the spike did not need
them: capability gating, manifest, per-host counters. Open: a row-level tool result for CLI parity. Details:
`docs/spike-parliament.md`. Björn's direction for the pitch: aim at the family (both TS servers, shared modules),
with Andrea Borruso as the natural owner of the core, since it reduces the code he maintains today.

## 2026-11-09: backlog and repository contents

- **Eval runner: backlog.** `evals/skos/` holds the 16 tool-selection cases; a runner that asks a model and scores
  its tool choices would be new work, measures our tool descriptions (not TemaTres), and costs per run. Not now.
- **`.claude/` and `review/` stay out of the repository** (Björn's decision): listed in `.git/info/exclude`, so they
  live only in this working copy. `CLAUDE.md`, `AGENTS.md` and `docs/testing-application.md` point to them.
- **Upstream candidate (backlog, Björn 2026-11-09): ondata's typecheck.** At 09e8cdc `tsc --noEmit` runs out of
  memory (also with `--max-old-space-size=8192`), so the code is never typechecked; its build (esbuild) does not
  check types. Porting found type errors that `strict` would report (optional fields read as required, fields the
  CKAN interfaces lack). Cause of the memory use not yet established (suspected: zod/SDK type instantiation in
  `registerTool`). A possible small PR: make `tsc` complete, fix what it then reports. Nothing goes upstream
  without Björn's ok.
- **Upstream candidate (backlog): a prompt names a tool that does not exist.** ondata's `ckan-analyze-dataset` prompt
  (src/prompts/dataset-analysis.ts:19-21 at 09e8cdc) tells the model to call `ckan_resource_show`, which ondata does
  not register. The port keeps the text (parity) and lists only registered tools as the prompt's references (the core
  checks them). A one-line fix upstream; nothing goes upstream without Björn's ok.
- **Row-level tool results: yes** (Björn's decision), so a profile can serve both MCP and a CLI. Next step.

## 2026-11-09: row-level tool results (C6), built

`ToolSpec` has `handler` (a finished MCP result) or `rows` (data the host formats); exactly one. `RowsResult`,
`Profile.emptyText`, and `runRowsTool` for CLIs. The spike's tools use `rows`; the SKOS tools keep `handler`
(their output is a document). See `docs/spike-parliament.md` (C6).

## 2026-11-09: CKAN profile, round 1 (parity harness)

Björn: CKAN before the parliament set; work in reviewed rounds, a commit after each. Round 1 is the black-box parity
harness and the recordings (`docs/test-parity.md`, principle 3). Port approach for the next rounds: the profile
keeps ondata's file layout and code, and threads the engine context through instead of a module-global HTTP client
(no hidden per-request state in Workers); a profile-level `makeCkanRequest(ctx, ...)` rebuilds ondata's CKAN
errors and texts on top of `ctx.http`.

## 2026-11-09: CKAN profile, round 2 (request layer, status, tags, organizations)

`packages/profile-ckan` registers `ckan_status_show`, `ckan_tag_list` and the three organization tools, ported
from ondata's files (headers name the source and commit). `makeCkanRequest(ctx, ...)` keeps ondata's fetch path and
its error classes and texts, and sends through `ctx.http`. The axios path is not ported: the parity check now also
replays ondata's own Node path (axios, the npm package) and finds it gives the same observation as its fetch path in
all recorded cases, so one path serves both. The request headers differ (D9 in `docs/test-parity.md`).

Contract and core changes, each the smallest the port needed:

- `ToolSpec.strictInput`: reject unknown arguments, as ondata's `.strict()` schemas do (`inputSchemaOf` in the core,
  also used by `runRowsTool`).
- `EngineHttp.validateUrl(url, { allowPrivateHosts })`: a profile that builds its own URLs checks the caller's URL
  with the exemption its requests use.
- `EngineCache.defaultTtlSeconds`: ondata's per-action TTL table falls back to the configured default.
- `FetchOptions.allowlistedAs`: the domain allowlist is checked on the caller's host, not on the API host a
  registry rewrites it to (portals.json: `open.toronto.ca` → `ckan0.cf.opendata.inter.prod-toronto.ca`), first hop
  only, as ondata did; redirects and the literal guards still see the real URL (found in review).
- `TransportError.kind` (`timeout`, `network`, `not-found`, `too-many-redirects`, `edge`): a profile words transport
  failures in its own terms (ondata names the portal as the caller wrote it, not the API URL) without parsing
  messages.

The argument validation error text comes from the SDK and is shorter in 1.32.2 than in ondata's 1.27.1 (D8).

## 2026-11-09: CKAN profile, round 3 (groups, datasets, DataStore)

The group, package (search, relevant datasets, show, list resources) and DataStore tools are ported from ondata's
files; with round 2 that is 14 of ondata's 20 tools. What changed in the port, beyond threading `ctx`:

- **Scheming fields** use the core's generic field renderer (`renderFields`, `formatFieldsMarkdown`), which was
  extracted from ondata's `scheming.ts` in step 3; the profile keeps ondata's never-added fields, labels, notes, and
  the schema fetch with its negative cache.
- **Search telemetry** goes through `ctx.telemetry` (the core keys it per server instance, as ondata's WeakMap did).
- **Module-level state stays module-level** where ondata had it (the per-portal Solr parser probe, the "no schema"
  cache): it is a cache across requests, not request state, and per isolate on Workers as in ondata.
- **Types**: the CKAN interfaces gain the optional fields the tools read (`owner_org`, `groups`, `extras`, ...), and
  the core's `formatDate` accepts `undefined`. Types only: ondata's own `tsc` runs out of memory before it reports anything (see the backlog),
  and its build (esbuild) does not typecheck, so its code had never been checked under `strict`.

## 2026-11-09: CKAN profile, round 4 (quality, analysis, SPARQL, portal discovery)

All 20 of ondata's tools are ported. ondata's direct `safeFetch` calls (MQA on data.europa.eu, SPARQL endpoints,
the datashades.info registry) go through `fetchAsResponse` (`packages/profile-ckan/src/utils/fetch.ts`): the core's
request with what ondata's call had (its identity, its timeout, at most three redirects, no rate token, no honest
retry), returned as a `Response` so the ported code reads it unchanged, with fetch-style errors. Contract additions,
each the smallest that worked:

- `FetchOptions.userAgent: { fixed }`: send exactly this identity (ondata's SPARQL calls name themselves
  `Mozilla/5.0 (compatible; CKAN-MCP-Server/1.0)`), with no honest retry.
- `FetchOptions.fixedUpstream`: the URL is the profile's own constant upstream, so the domain allowlist (which limits
  where callers may send requests) does not apply to its first hop, as ondata never checked it there. Redirects and
  the literal guards still apply. Without it, `CKAN_ALLOWED_DOMAINS` would have switched off MQA and portal
  discovery.

The parity harness treats a request without `Accept` as `Accept: */*`, which is what `fetch` sends (Fetch
standard), since the core always sets one. `sparql_query` keeps ondata's unprefixed name (`shared`).

## 2026-11-09: CKAN profile, round 5 (resources and prompts): the port is complete

The seven resource templates and six prompts are ported; with rounds 2-4 the CKAN profile registers everything
ondata's server registers at 09e8cdc (20 tools, 7 resource templates, 6 prompts) and the parity check requires the
same lists. Not ported: the DataStore table UI resource, which ondata does not register. Still to do before the
profile can replace ondata's server: the CKAN hosts (stdio/HTTP bin `ckan-mcp-server`, `/`, `/health`, `/mcp`, the
Worker with ondata's telemetry fields, `CKAN_*` env names), and the smoke run against the live portals.

## 2026-11-09: CKAN deployment (`packages/host-ckan`)

The CKAN profile deployed as ondata's server: the `ckan-mcp-server` binary (stdio; `TRANSPORT=http` for Streamable
HTTP on `/mcp`, with ondata's `CKAN_HTTP_*` settings and status lines) and the Cloudflare Worker (`/`, `/health`,
`/mcp`, CORS, ondata's log line and Analytics Engine data point per tool call, its response headers). Every
`CKAN_*` name ondata reads is read by the core under the CKAN prefix. Checks: the Worker answers exactly as ondata's
for the same requests, including the log line and the data point (`packages/host-ckan/tests/worker-parity.test.ts`);
ondata's smoke cases (copied unchanged) pass live against our binary, 18/18 (`npm run smoke:ckan`, 2026-11-09).

Björn's decisions (2026-11-09):

- **Version: Claude chooses.** One semver for the whole platform, starting at `0.1.0` (all packages, the profiles,
  `initialize` and `/health`). The deployment reproduces ondata/ckan-mcp-server 0.4.138 (README,
  `packages/host-ckan/src/server.ts`); the version field says ours (D13).
- **Landing page `/` stays English**, so ondata's people can read it: ondata's page, unchanged.
- **Deploy, to test fully.** Choice: Cloudflare Workers, as ondata, so what is tested is what would replace ondata's
  service: `ondata-extended-ckan` and `ondata-extended-vocab` on the account's `workers.dev` subdomain
  (`npm run deploy:ckan`, `npm run deploy:vocab`; `npx wrangler login` once, by Björn). wrangler sends no usage
  telemetry (`send_metrics = false`). The service notices are the deployment's settings
  (`CKAN_SERVICE_NOTICE`, `CKAN_SERVICE_RECOMMENDATION`, `CKAN_DEMO_NOTICE`), ondata's texts by default; ours say
  "Test instance of ondata-extended, not ondata's service" and point to ondata's installation guide for a stable
  server. Checked before deploying: `wrangler deploy --dry-run` for both, and the CKAN Worker in Cloudflare's runtime
  locally (`wrangler dev --local`) against a live portal.
- **No domain allowlist on the CKAN test Worker** (Claude's choice, flagged in review): like ondata's public Worker,
  it accepts any public CKAN portal a caller names, so it can be tested against any portal and against what
  `ckan_find_portals` returns. The SSRF guards apply to every request; the URL is not announced. If it is abused,
  set `CKAN_ALLOWED_DOMAINS` in `packages/host-ckan/wrangler.toml` and redeploy. The vocabulary Worker keeps its
  allowlist (`begrepp.hagstrom.nu`).
- **The landing page carries no test-instance notice** (Björn's decision: ondata's page unchanged). The notices are
  in the `/mcp` headers and the Markdown footer.


## 2026-11-10: parliament profile, round 1 (`packages/profile-parliament`)

Björn's direction (2026-11-09): not the whole profile, but a representative hard set built for real; round 1 is the
spike's four tools (`legislatures`, `deputies`, `search`, `sparql`) ported fully from italianparliament-mcp at
`fd46810`, with ranking and birthplace. Details: `docs/parliament-port.md`; tests and P1-P5: `docs/test-parity.md`.
The throwaway `packages/spike-parliament` is deleted; its tests moved onto the port.

Choices made in the round (Claude's, flagged for Björn):

- **`handler`, not `rows`, for exact output.** The core's table output (C3) and row tools (C6) order keys by the
  column list, add `structuredContent` and cut at the character limit; the original prints each row in its own key
  order, has no `structuredContent` and no cap. A faithful port registers the original's `makeHandler`. Contract
  finding: a ported server of this kind uses neither `rows`, `output.table` nor `HostPolicy.retry`. Options for
  later: a "rows as they are, text only" flag and a retry predicate on the host policy, or accept `handler` for
  ported servers. Not decided; the issue draft says so.
- **Retries stay in the profile** (the original's loop retries everything except a 4xx other than 429, including an
  unparsable 2xx); the core's narrower retry is switched off per request. The host policies carry the Senato
  throttle and the 60 s timeouts. All requests still go through the core's client and its guards (P3).
- **The original's identity on the wire** (`User-Agent: italianparliament-mcp/0.38.0`), for parity, as the CKAN
  profile keeps ondata's. A release of ours may want its own (cf. D13).
- **No `sanitizeInline`/`wrapUntrusted` on the parliament tools' output**, as in the original: the output is JSONL
  (`JSON.stringify` escapes newlines; no Markdown structure to break), and parity requires the original's bytes.
  `untrustedSourceLabel` is declared for core messages. Revisit if a tool gains Markdown output.
- **Italian comments and Italian test names kept in files ported from the original** (an exception to "everything
  in English" for ported code only): the files mirror the original file by file, so a reader can diff them against
  upstream, and a translated comment would be a change the original's maintainer has to read past. New code and
  every non-ported file are English. Björn may reverse this; translating is mechanical.
- **Senato data synthetic only**: no request to any senato.it host (it blocks an IP permanently); the recorder
  refuses one. One synthetic Senato row reuses a real deputy's name with an invented id, to exercise the
  Camera-before-Senato tie-break; it is marked synthetic.
- **The parity reference** is a copy of the original at fd46810 with its dependencies in
  `../ondata-italianparliament-mcp/repo` (beside ondata's CKAN clone), so `npm run check` runs the parity tests here.

Core changes (generic, no backend named): `SparqlValidationError.keyword`, so a profile words the refusal in its own
language; the SDK gets the raw input shape unless a tool is strict (an empty shape then lists as the original's).

## 2026-11-10: parliament profile, round 2 (`bill-progress`)

`bill-progress` ported with its helpers (details and parity: `docs/parliament-port.md`, "Round 2"; P6, P7 in
`docs/test-parity.md`). It reaches only the two SPARQL endpoints. Decisions:

- **Untrusted text in notices (revises round 1's "no sanitizing" choice).** Round 1's argument held because every
  upstream value sat inside a JSON string. `bill-progress` quotes endpoint values (phases, states, dates, DDL ids,
  act URIs) in plain-text notices after the rows; a line break there would start a line of its own in the tool
  output. Line breaks in those values are folded into a space (P7), the smallest change that closes it; nothing
  else in the original's text changes, and the rows stay the original's. Rule: a parliament tool that puts upstream
  values outside JSON escaping folds line breaks; Markdown output would need `sanitizeInline`.
- **Parity run time.** The parity file takes about 3 minutes (`npm run check` about 3 min), because the Senato
  throttle (≥ 2 s) applies on both sides. Kept for now: shortening it would mean changing the original's throttle
  in the harness. Open for Björn.

## 2026-11-10: parliament profile, round 3 (`camera-amendments`)

`camera-amendments` ported (details: `docs/parliament-port.md`, "Round 3"; P8 in `docs/test-parity.md`). This is the
round that tests the contract on a tool the original runs outside its client: HTML fetched with the global `fetch`
and parsed with cheerio. Decisions:

- **HTML through the core's client** (`ctx.http.request` with the original's headers, fixed User-Agent, one attempt,
  60 s timeout): the guards apply (P8). The original's texts are kept, including `fetch failed` for a socket or
  DNS failure.
- **cheerio as a profile dependency** (`^1.2.0`, `cheerio/slim` as in the original, which chose it to keep Node's
  `buffer` out of its Worker bundle). The Worker probe bundle grows from 574 to 772 KiB; the CKAN and vocabulary
  Workers are unchanged, since they do not bundle this profile. Licences listed in `NOTICE.md` (MIT, BSD-2-Clause,
  ISC). The contract needed no change: a profile may bring its own parser.
- **The profile's constant upstreams are `fixedUpstream`**: the two SPARQL endpoints and the Camera site hosts, so a
  deployment's domain allowlist (which limits caller-chosen URLs) does not block them; redirects and off-host links
  are still checked. As profile-ckan does for MQA and the portal registry.
- **Recording from the Camera's public sites** (`www.camera.it`, `documenti.camera.it`), 14 requests in all, gently;
  Senato never. The amendment lists are cumulative, so a future re-recording may change the counts the original's
  tests assert; they would then fail, as the original's live tests would.

## 2026-11-10: parliament profile, round 4 (`packages/host-parliament`)

The parliament profile as the original's server: the stdio binary `italianparliament-mcp` and a Worker with the
original's routes (details: `docs/parliament-port.md`, "Round 4: host"; P9-P13 in `docs/test-parity.md`). Built and
tested locally; **not deployed** (deploying it would send Cloudflare traffic to Senato, whose blocks do not decay;
that needs Björn's decision). Decisions:

- **Core hosts where they fit, a small router where the original differs.** `GET /`, `/health` and `POST /mcp` are
  the core's `createWorkerHandler`; the original's preflight (200, `POST, OPTIONS`) and bare 404s differ from
  ckan-mcp-server's and sit in a router in front. Two generic core options: `jsonResponse: false` (answer as an SSE
  stream) and `runStdio(server, label?)` (no status line). A core fix to those two routes would not reach this host.
- **One engine per isolate**, so the Senato throttle covers every request an isolate serves (tested).
- **The core's upstream rate limit stays on by default** (P13), as on the other hosts; it can be turned off.
- **No HTTP mode on Node and no service-notice field**, as the original; the info document and the 404 text are the
  original's bytes (English, not in language files), as the CKAN landing page is ondata's.
- **The binary loads the stdio module only** (`@ondata-extended/core/node/stdio`), so it does not need express.

## 2026-11-10: the proposal to ondata (issue draft, Björn's direction)

- **Preferred path: ondata adopts the core** (a new ondata repository; ckan-mcp-server and italianparliament-mcp
  become profiles over time). We do not want to maintain a separate copy; keeping it ourselves is the last option.
- **Side by side, then switch**: the new version runs as separate test Workers and npm tags next to the current
  servers until the maintainer is satisfied; rollback is redeploying the old version.
- **PR size is the maintainer's choice**: one large PR that starts the new track, or small steps. The earlier "no
  large PR" line is withdrawn.
- **Maintenance offer**: Björn does the work until ondata's services run stably on the core and documents maintenance
  after that; no indefinite co-maintenance promise.
- **Behaviour unchanged for parliament users too**, where possible; differences listed (P1-P13).
- **The issue states plainly that this is a prototype**, with a status per part (CKAN complete, parliament 6 of 43
  tools, core gaps named).
- The plan (`docs/upstream/ondata-issue-plan.md`) is a working note, not part of the issue (public with the repository).
- **Confirmed by Björn**: the parity run time (~3 min) stays; the round 1-4 choices stand (Italian comments in ported
  files, the original's User-Agent, the core rate limit on by default for parliament, P13). `bill-text` waits; the
  issue describes it as not built.

## 2026-11-10: example profile and publishing for review

- **The repository is published publicly for Andrea's review** (Björn, 2026-11-10), with full credit to ondata
  (NOTICE.md, file headers). The push itself still needs Björn's ok at the time, after the pre-publication checks.
- **The issue words security points generally**; details for italianparliament-mcp go to Andrea privately if he
  asks.
- **Example profile** (`packages/profile-example`, `packages/host-example`; guide `docs/writing-a-profile.md`): two
  `akn_*` tools over the Senate's Akoma Ntoso bulk data on GitHub (CC BY 4.0). Chosen because it is a real, keyless,
  Workers-reachable source relevant to ondata, and it shows every part a profile needs (rows and handler tools,
  host policies, `fixedUpstream`, a secret through config, telemetry fields, error hints, untrusted text). A regular
  expression reads the XML instead of a parser, to keep the example free of dependencies. Not deployed.
- **GitHub token as `AKN_GITHUB_TOKEN`** (optional): GitHub's anonymous limit is 60 requests an hour per IP, which a
  shared Worker IP can exhaust. Sent to api.github.com only; never in output, logs or telemetry (tested).
- **Senato and Workers**: the original's own Worker already queries dati.senato.it's SPARQL endpoint from Cloudflare;
  the GitHub bulk data covers documents (texts, amendments, reports), not the linked data most tools query. Our rule
  of no live senato.it requests from this machine stands.

## 2026-11-10: plan for a stable, documented contract

The profile contract is the API others will build on, so it gets a written plan to 1.0: `docs/contract-stability.md`
(Björn). In brief: 0.x until two profiles run in production, the open contract questions are decided and the
contract is reviewed with its future owner; then semver, deprecation before removal and a changelog; safeguards
(an API snapshot checked in `npm run check`, a conformance test per profile, the example profile as living
reference); TypeDoc reference plus the guide. The issue mentions the plan in one sentence, without details.

## 2026-11-10: proposal issue posted

Posted to ondata/ckan-mcp-server as #590, with Björn's ok, after the final review and the numbers refreshed on the
day (1803 tests; smoke 17/18 on our Worker and on ondata's alike, the MQA case failing on data.europa.eu's HTTP 500;
live comparison 20/21, D5). The text is `docs/upstream/ondata-issue-draft.md`. Next: answer within a day, keep
follow-ups short; log his answer and our decision here (`docs/upstream/ondata-issue-plan.md`, "After posting").

## 2026-11-10: Andrea's answer on #590

Andrea Borruso answered on #590 the same day:
- **No shared core for now**, neither path A nor the full path B; italianparliament-mcp stays as it is. Reason: he
  does not expect many more TypeScript MCP servers, and with two servers the benefits do not cover a contract, a
  dependency between them and the work of keeping them in step, which would stay with him.
- **Yes to the first step of path B as a small PR**: split `src/utils/http.ts` into a backend-free part and a CKAN
  part, no export changes, `npm test` and `npm run smoke` green, smoke file untouched; no OpenSpec proposal needed.
- **Revisit** when the core runs in production with at least two profiles, or if he needs a third TypeScript server.
- **Yes to the security details for italianparliament-mcp, privately**, through its private vulnerability reporting.

Next (Björn, 2026-11-10): a short thank-you reply on #590, then the `http.ts` split PR. Both, and the private report,
leave the machine only with Björn's ok each time. What happens to our core (path C in practice) is Björn's decision,
open.

## 2026-11-11: #591 merged; private report sent

- `ondata/ckan-mcp-server#591` (the `http.ts` split, first step of path B) was approved and merged by Andrea Borruso
  on 2026-11-11. He checked the verbatim move, the unchanged 20 exports and the absence of a circular import, and
  wrote that he looks forward to the next steps of path B.
- His two non-blocking notes for those steps: `safe-http.ts` still reads the `CKAN_*` settings and names CKAN and
  `sparql_query` in its messages, so making it backend-free means injecting that configuration; and the SSRF tests
  still reach it through the `http.ts` re-exports and could move next to `safe-http.ts` once it has its own consumers.
- The security details for italianparliament-mcp were sent privately on 2026-11-11, as agreed on #590.
- Next step upstream: Björn's decision, each step agreed with Andrea before a PR.

## 2026-11-12: Andrea's answer on step 2

On #590 (comment 6820640188), Andrea Borruso:
- **Yes to step 2**, kept to one purpose: `safe-http.ts` free of CKAN.
- **Settings passed explicitly, per call:** `http.ts` reads the `CKAN_*` variables and hands them to the
  `safe-http.ts` functions. No module-level `configure()` with mutable state in the security code (a missing or late
  call is easy to miss).
- **Messages byte-identical**, shown by the unchanged tests. The SSRF tests stay where they are for this step.
- **He stops after step 2.** Steps 3 and 4 (hint texts out of the HTTP layer, the profile type) lead towards the
  shared core, and his answer on that is unchanged; his "looking forward to the next steps" on #591 was broader than
  he meant. Revisit only on his earlier conditions: the core in production with two profiles, or a third TypeScript
  server.

So: step 2 is the last upstream step for now. Our core continues on its own (path C in practice).


## 2026-11-12: step 2 merged (#594)

Andrea approved and merged #594 the same day
([review](https://github.com/ondata/ckan-mcp-server/pull/594#pullrequestreview-5875531397)). He checked it against
the base himself: the same 20 exports, no `process.env` or CKAN in `safe-http.ts`, read timing as before, defaults
that fail closed, messages unchanged, tests and both builds green.

- **Path B upstream is done** as far as he wants it: `safe-http.ts` is a backend-free module in ondata's server.
- **Open, optional, his call:** a nit (the redundant `const raw = privateHosts;` in `isPrivateHostAllowed`) and the
  missing test that `CKAN_PRIVATE_HOSTS` reaches the axios agents' lookup ("can come separately if you feel like
  it"). Either would be one small PR; not started.

## 2026-11-14: the vocabulary service goes to production

Björn: build on the core with the TemaTres profile as a production service. This is also the path to the condition
Andrea set for revisiting a shared core (the core in production with two profiles). Björn's decisions:

- **Vocabularies: an approved list only.** The production Worker reaches only the vocabularies in
  `KNOWN_VOCABULARIES` and `VOCAB_ALLOWED_DOMAINS` (today `begrepp.hagstrom.nu`); others are added one at a time,
  each with fixtures and a smoke case. Not an open proxy to any TemaTres, unlike ondata's open CKAN Worker.
- **Hosting: a Cloudflare Worker on an own domain.** `[env.production]` in `packages/host-vocab/wrangler.toml`,
  Worker `vocab-mcp`, deployed with `npm run deploy:vocab:production`; the test Worker `ondata-extended-vocab` stays
  for trying changes. The own domain needs its DNS zone on the Cloudflare account; `hagstrom.nu` is on Loopia
  (checked 2026-11-14), so the route is prepared but commented out until the domain is settled. Until then the
  Worker answers on workers.dev.
- **Users: Björn and invited users.** The URL is shared, not announced; no access control (public vocabulary
  content; the allowlist and the core's upstream rate limit bound what a caller can do). The landing page says
  "a private service for invited users" when `VOCAB_SERVICE_STATUS=service`, and "test service" otherwise.
- **The eight `vocab_` tools are frozen**: names, arguments, types, ranges, defaults, required arguments and
  annotation hints, checked against `packages/profile-skos/tests/frozen-tools.json` (fails on any change; tested by
  renaming a tool in the file). Titles and descriptions are not frozen. A breaking change needs a decision and migration help.
- Operating guide for users and for deploys, rollback, logs and adding a vocabulary: `docs/vocab-service.md`.

## 2026-11-14: watching ondata's servers for changes to follow

- **Why**: `profile-ckan`/`host-ckan` behave as ckan-mcp-server at `09e8cdc` and `profile-parliament` as
  italianparliament-mcp at `fd46810`; both have moved on (v0.4.142 and v0.38.1 on 2026-11-14), and nothing told us.
- **How**: `scripts/upstream-watch.mjs` lists the upstream commits since the baselines in
  `scripts/upstream-watch.json` and maps the files each touches to our packages; bot data updates, docs and other
  ignored paths are counted, not listed. A daily GitHub Action (`.github/workflows/upstream-watch.yml`) keeps one
  issue in this repository up to date: opened when there is something to review, a comment when new commits appear
  (the notification), closed when nothing is left. It decides nothing and uses no model.
- **Follow-up**: each listed commit is reviewed in a session (port, note in the deviation list, or dismiss), then the
  baseline is moved by hand. Our own upstream PRs (#591, #594, #596) appear too; they only move the baseline.
- Run by hand: `GH_TOKEN=$(gh auth token) node scripts/upstream-watch.mjs` (report only, writes nothing).

## 2026-11-14: a CKAN ecosystem profile, a proof of concept for datHere

- **Why**: CKAN's extension registry, the CKAN Ecosystem Catalog (`ecosystem.ckan.org`, run by datHere in the POSE
  project), has no MCP server, and its CKAN API sits behind a Cloudflare bot challenge that datHere's own pipeline
  passes with a secret token. Björn wants a proof of concept for datHere, read-only search only. We do not scrape the
  catalog or route around the challenge.
- **What**: `packages/profile-ckan-ecosystem` (tools `ecosystem_search_extensions`, `ecosystem_get_extension`,
  `ecosystem_portals_using`, `ecosystem_overview`) and `packages/host-ckan-ecosystem`. Prefix `ecosystem_` (Björn),
  not `ckanext_`, to stay clear of the CKAN profile's `ckan_`. Not deployed.
- **Data**: a committed index, `data/index.json`, built by `npm run build:ecosystem-index` from datHere's open
  pipeline files (`dathere/pose-ckanext-metadata`, MIT) at one pinned commit, plus each repository's GitHub
  description and topics. Rebuilt by hand, weekly at most. The build fails when a field it reads is missing. README
  openings are not in the index: `ecosystem_get_extension` reads them at call time, attributed, wrapped as untrusted.
- **Changed after Fable's review of the proposal** (2026-11-14, verdict "go with changes"): no run-time read of
  `dashboard.json` (1.7 MB; above the core cache's 1 MB entry cap, and a wire format datHere change often); the index
  committed, not git-ignored, so a clone builds and the bundle is traceable; README text kept out of the bundle
  (licences, prompt injection); datHere's own push-recency buckets (`active`, `recent`, `quiet`, `still`,
  `archived`) instead of an invented maintenance status; co-installation folded into the extension card with a note
  that datHere compute it for the most used plugins only; four tools instead of six (no portal card, no separate
  used-with tool).
- **Exception to rule 6** (all outbound traffic via the core HTTP client): the index build script calls GitHub
  directly. It is a maintainer's build tool run by hand with a local token, not part of any server; the token is read
  from the environment and never written out (the index test checks for token patterns).
- **Open**: Fable also proposed making first contact a small PR to datHere's pipeline adding repository descriptions
  and topics, so the profile could read them from datHere's own files. That is outward-facing and Björn's call.
- **Backlog (Björn, 2026-11-14): outreach to datHere.** datHere opened
  https://github.com/ckan/ckanext-pose_ecosystem_catalog/issues/222 ("Add MCP server so AI assistants can search the
  Ecosystem Catalog") after Björn's comment in https://github.com/ckan/ckan/discussions/9542; it proposes evaluating
  ckanext-mcp. The plan when it is picked up: a "Try it" guide with a real example, then a comment on #222 that offers
  the test Worker to try, what the usage data adds, what only the catalog has, and design advice (a small read-only
  tool set for an anonymous endpoint), with no demand. The test Worker runs on workers.dev since 2026-11-14.
- **Posted (Björn's ok, 2026-11-14)**: the comment on #222,
  https://github.com/ckan/ckanext-pose_ecosystem_catalog/issues/222#issuecomment-6877656547, after the "Try it"
  guide was pushed.
- **Backlog (Björn, 2026-11-14): several services on one MCP server without mixing them.** Built 2026-11-15; see the
  entry of that date.

## 2026-11-14: no authentication on the deployed services, for now

- **What**: `vocab-mcp` and the CKAN ecosystem test Worker stay open: anyone with the URL can call their read-only
  tools. Björn's call: take the risk and state the limits clearly wherever a service is published.
- **Why acceptable**: public data only, read-only tools, no secret in either Worker, outbound requests limited to
  one host each (`begrepp.hagstrom.nu`, `raw.githubusercontent.com`). For the ecosystem service anonymity is the
  point (ckanext-pose_ecosystem_catalog#222 asks for an anonymous read-only endpoint).
- **The risk taken**: both Workers share one Cloudflare account and its request quota, so heavy use of one can stop
  the other for the rest of the day; the per-isolate rate limit does not cap total traffic to an upstream; repeated
  README reads could get Cloudflare's addresses limited by GitHub.
- **When publishing**: say that it is a proof of concept with no availability promise, that it may be rate-limited or
  taken down, that search text is logged, and what data it does not cover.
- **If it goes wrong**: a secret MCP path for `vocab-mcp`, a token header, or the demo on a separate Cloudflare
  account (options weighed in the session of 2026-11-14).

## 2026-11-14: ondata's CKAN changes since 09e8cdc reviewed (upstream watch, issue #1)

29 commits on ondata/ckan-mcp-server between `09e8cdc` and `cb2119d`: nine code and release commits, reviewed below, and twenty data and docs commits, which the watch ignores. The watch baseline moves to `cb2119d`. The
parity reference stays at `09e8cdc` (the recordings and the clone are unchanged).

- **Ported: `3369eac`** (#593, SPARQL: a `#` in an IRI is not a comment, the endpoint's reason in errors, a clear
  timeout, `"col"::float` in the SQL hint, "endpoint error" classified as `upstream_http`). Deviation D14 in
  `docs/test-parity.md`, checked case by case in the parity test; it leaves the list when the parity baseline moves
  past it. To read only the head of an error body as ondata does, the core's request options gain
  `errorBodyPrefixBytes` (generic: the first N bytes of a non-2xx body, the rest never downloaded; what had arrived
  if it stalls). A change to the profile contract, allowed while it is 0.x.
- **Dismissed: `15517e5`** (#587, CKAN_PRIVATE_HOSTS): its source and test files are byte-identical to `09e8cdc`, which
  was the head of the same pull request branch (only AGENTS.md, CONTRIBUTING.md, LOG.md and a data file differ). Already
  ported.
- **Dismissed: `205ba4a`, `2667613`, `c6ab095`** (#591, #594, #596, ours): refactors with no behaviour change, and a test
  of ondata's axios agents, which our core does not have (it pins connections in its own dispatcher).
- **Dismissed: `d504359`, `3fbc431`, `c58817f`, `48b9003`**: releases v0.4.139 to v0.4.142: version bumps plus release
  notes in LOG.md, no other runtime change. The new baseline `cb2119d` changes only download data.
- **Not reviewed: italianparliament-mcp** (`5ebcc84`, `3699753`). Björn, 2026-11-14: nothing more on the parliament
  or the Senate for now; its watch baseline stays at `fd46810`, so the issue keeps listing them.

## 2026-11-15: several services in one Worker, public and private

The backlog item of 2026-11-14, on Björn's go: some services should be hidden (private), others open for anyone to
find.

- **What**: the core gains `createServicesHandler`: one Worker, several services, each at its own path
  (`/<path>/mcp`, `/<path>/health`). A public service has a fixed path and is listed on `/` and `/health`. A private
  service is served only at a path read from a secret of the deployment and is named nowhere a caller sees; every miss
  (wrong secret, unknown path, the service's id as a path) is the same 404. A missing or short secret (under 32
  characters) switches the private service off, with one warning that does not contain the value; it never falls back to
  a guessable path. The one-service `createWorkerHandler` is unchanged in behaviour (its MCP code is now shared).
- **Kept apart**: each service has its own MCP server and, as the host builds it, its own engine: its own config prefix
  (no shared `ENGINE_*` alias), allowed hosts, cache and rate limit. Tested with the two real profiles in one Worker
  (`packages/host-services/tests/host.test.ts`): each path lists only its own tools, a tool of one service is unknown on
  the other's path, and the vocabulary service is refused a host that only the ecosystem service may reach.
- **`packages/host-services`**: the CKAN ecosystem service public at `/ecosystem/mcp`, the vocabulary service private at
  the secret `SERVICES_VOCAB_PATH`. Workers only (the Node hosts serve one service each, as before). Deployed
  2026-11-15 at `https://ondata-extended-services.ondata-extended.workers.dev` (`npm run deploy:services`, Björn's ok);
  smoke: ecosystem 7/7, vocabulary 10/10 at the private path, `/health` lists the ecosystem service only.
- **Logs**: Cloudflare attaches the request URL, and so the secret path, to what it stores for a request (invocation
  logs, traces, and as far as we can tell the metadata of our own log lines too; only the query string can be
  redacted). So Workers Logs and traces are off for this Worker (`[observability] enabled = false`): nothing is stored
  at Cloudflare. Our log line per tool call (service, tool, arguments, never the path) is still printed and can be
  watched live with `wrangler tail` by the account owner; tail events carry the URL too, so treat a tail session as
  showing the secret. If stored logs are wanted later, check first on a test deployment with a throwaway secret
  whether the stored record holds the URL.
- **What a secret path is**: a capability URL, like a shared link. It keeps a service out of sight; it is not
  authentication, and anyone given the URL can use it. It sits in the client's settings (a claude.ai connector, for
  example), so treat it like a password and rotate it (set a new secret, update the connectors) if it spreads.
- **Migration (done 2026-11-15)**: Björn's connector "Begrepp svada" moved to the private URL (a call seen arriving
  there with `wrangler tail`); the Worker `vocab-mcp` was then deleted (Björn's ok; it had not been shared). Its
  `[env.production]` section stays in `packages/host-vocab/wrangler.toml`, so it can be redeployed. The ecosystem
  test Worker stays, because ckanext-pose_ecosystem_catalog#222 links its URL.
- **Not built**: a combined endpoint with the tools of several services; authentication (decision of 2026-11-14).
- **Also**: `scripts/smoke-vocab.mjs` paces its cases against a deployed server (`SMOKE_PAUSE_MS`, default 1500 ms), so a
  cold cache no longer makes the last case fail on the rate limit.

## 2026-11-15: the SKOS profile knows no vocabulary; a TemaTres demo for its maintainer

- **Standing constraint (Björn)**: every profile is as generic as possible, and so are the interfaces between core,
  contract and profiles and the guides. Instance data (which vocabularies, portals, defaults) comes from the deployment.
- **The SKOS profile**: `createSkosProfile({ vocabularies })` takes the deployment's list; the profile ships none
  (`KNOWN_VOCABULARIES` and `SKOS_TOOLS` are gone; `createSkosTools(entries)` builds the tools). The first entry is the
  default; the `DEFAULT_VOCAB` setting is gone (the order of the deployment's list is the setting, so the generated
  description always names the right default; no deployment had set it). With no list and no `vocab`, a call fails
  with a clear error.
  The `vocab` argument's description is generated from the list (ids and titles, at most 20), so a model sees which
  vocabularies exist; no deployment name is in the profile's text any more. Svada's entry moved to
  `packages/host-vocab/src/vocabularies.ts` (and `host-services`). Tool names and arguments are unchanged (frozen test
  green); only model-facing text changed.
- **A fix found on the way**: a concept URI picked its vocabulary by host, so with several vocabularies on one host (as
  on vocabularyserver.com) a URI of one could silently resolve in another with the same id. Now the longest matching
  base URL (as a directory) or concept URI base (exactly as given, e.g. ending in `?tema=`) wins, and a URI must start
  with one of the chosen vocabulary's; the scheme (http or https) and repeated slashes are ignored. Tested, with mutation
  checks (host-only matching, first match instead of longest, and no concept URI base each fail a test).
- **The TemaTres demo**: a third service in `packages/host-services`, private at the secret `SERVICES_TEMATRES_PATH`
  until the maintainer (Diego Ferreyra) has seen it. It reaches only `vocabularyserver.com`, his server, which
  publishes 391 vocabularies through TemaTres's web service; known by id: the UNESCO Thesaurus (English, the default;
  Spanish; French) and the ISO 25964-1 and Z39.19 glossaries. Others are reachable by their base URL. Rate limit 2
  requests a second with no burst (Björn: at most 2 a second before we tell him), one hostname only, since the limit
  is per hostname; a request waits up to 10 s for its turn. A cold `vocab_get_concept` takes about 7 requests, so
  about 3.5 s. Our tools worked unchanged against his
  instances (TemaTres 3.6.1 for UNESCO, 3.3 for an older glossary). His HTML pages and SKOS export sit behind a
  Cloudflare challenge; `services.php` answered, also from the Worker.
- **Live test through the Worker, 2026-11-15** (six calls): UNESCO scheme info, search "libraries" (32 hits), the
  concept Libraries with path, 9 narrower, related and en/es/fr mappings; the ISO 25964 scope note for "thesaurus"; a
  Spanish UNESCO concept URI resolved to `unesco-es` without `vocab`. A cold `vocab_get_concept` took about 3.5 s.
- **Contact**: test first, keep tests short; then a short note with a couple of concrete examples (Björn's ok before
  anything is posted).

## 2026-11-15: the SKOS profile calls vocabulary servers under its own name

- **What**: the TemaTres adapter's requests (the web service and the SKOS export probe) send the profile's honest user
  agent, `Vocab-MCP-Server/<version>`, instead of the core's default browser identity, which the adapter had used since
  the first version with no recorded reason (inherited from the CKAN side, where some portals block non-browsers). A
  vocabulary server should see who calls it, and the TemaTres maintainer is about to be asked about the demo.
- **Checked**: vocabularyserver.com and begrepp.hagstrom.nu answer `services.php` with 200 to that identity (curl,
  2026-11-15); through the Worker after the deploy (version 78ea66f2, 22:18 UTC): four calls answered, among them
  Public libraries with its scope note, Agricultural libraries under Special libraries, and AGROVOC by its address. Consequence: a TemaTres behind a browser-only firewall
  now gets no browser attempt; such a deployment would need the identity as a setting.
- **The draft** `docs/upstream/tematres-mcp-demo-issue-draft.md`: first contact as a public issue (Björn), so the demo
  becomes public at `/tematres/mcp` when it is posted; its landing texts (en, sv) are ready. Observation in it, from the
  raw web service: `fetchNotes` on The Dictionary of Knowledge Organization gave `cant_result` 0 for ids 129, 132, 407
  and 737.

## 2026-11-15: server instructions, so an assistant picks the vocabulary

- **Why**: Björn's first screenshots showed Claude answering the demo's questions from the web and from memory with the
  connector switched on. An assistant decides for itself whether to use a connector.
- **What**: the contract gains `Profile.instructions` (server instructions, sent as MCP `instructions` in the initialize
  result; a client may pass them to the model and decides their weight). Core: `ServerInfo.instructions` and
  `serverInstructions(profiles)`; the host passes them to `createMcpServer` (not `registerProfiles`, which runs after
  the server exists; a host that does not pass them sends none). Contract 0.x, so allowed.
- **The SKOS profile** builds them from the deployment's list (`skosInstructions`): when the user asks about one of
  these vocabularies or the work uses one, look it up instead of answering from memory or the web; quote definitions;
  name the vocabulary; say when a concept is missing; and, against over-triggering, that general word questions not
  involving these vocabularies do not need the tools. The deployment adds one sentence of its own
  (`SkosProfileOptions.instructions`). `vocab_search_concepts`' description names the deployment's vocabularies.
- **Deployments' sentences**: Svada "a Swedish vocabulary of terms and concepts for the SVADA project" (kept modest:
  the repo has no source for more); the TemaTres demo "published with TemaTres on vocabularyserver.com, the server of
  TemaTres's maintainer". CKAN and parliament send none (their initialize answer is compared with the originals').
- **Three levels** (README, "Steering the assistant"): tool descriptions, server instructions, and the user's project
  instructions, which remain the dependable way for a piece of work. Tried in Claude Desktop after the deploy (2026-11-16): in a plain
  chat with web search on, the server instructions alone did not make Claude use the demo (it searched UNESCO's own
  site); naming the connector did, and so did a project instruction without naming it. So the guidance is: name the
  connector in a single chat, a project instruction for real work. No tool-selection eval runner yet (backlog).

## 2026-11-16: the TemaTres demo goes public with the issue to its maintainer

- **What** (Björn: "kör när du är redo"): the demo moves from its secret path to `/tematres/mcp`, listed on `/` and
  `/health`, and its rate limit to vocabularyserver.com goes from 2 to 5 requests a second (no burst, 10 s wait), as
  the issue says; it offers to lower it. The secret `SERVICES_TEMATRES_PATH` is no longer read (delete it with
  `wrangler secret delete` when convenient).
- **A refused SKOS export is remembered**: for a vocabulary given by address, the adapter asks `xml.php?skosMeta=1`
  for the concept URI pattern. On vocabularyserver.com a browser check refuses it, and the core caches only successful
  answers, so the request was repeated on every call. The adapter now remembers a refusal (a 4xx answer, not 429) for an
  hour per instance and uses TemaTres's default pattern meanwhile. Timeouts, 5xx, 429 and requests our own guards stop
  are not remembered (so a transient error does not stick, and one service's allow-list does not reach another); the
  memory is capped at 200 entries. Tested, with a mutation check.
- **README**: how to run the vocabulary server against one's own TemaTres (checked locally).
- **Posted** 2026-11-16 as tematres/TemaTres-Vocabulary-Server#137, after the deploy (version 5e3a82ec) and a check of
  `/`, `/health` and the conversation's calls at `/tematres/mcp`.

## 2026-11-16: the maintainer's lunfardo lexicon in the TemaTres demo, at most two requests a second

- **Why** (Björn, after the maintainer's answer on #137): build on his work rather than beside it. He pointed to his
  lexicon-based text annotator and its demo on the tango "Cambalache"; the lexicon it uses is a TemaTres vocabulary,
  so the demo can read it live. The plan for the reply: his annotator marks the words (deterministic, every mark tied
  to an entry), the assistant with the vocabulary tools checks each mark against the same lexicon, rejects false
  matches, picks the sense and adds what exact matching misses.
- **What**: the TemaTres demo (`/tematres/mcp`) also knows `lunfardo`, the "Lexicón de 12.500 voces y locuciones
  lunfardas, populares, jergales y extranjeras" (Adolfo Enrique Rodríguez, 1989) at
  `https://terminologias.filo.uba.ar/apps/dicrodriguez/` (TemaTres 4.0, 14,932 terms). UNESCO stays the default.
  `TEMATRES_ALLOWED_DOMAINS` gains `terminologias.filo.uba.ar`; the allow-list is the host, so the other TemaTres
  vocabularies there (his annotator's other lexicons) are reachable by address too, under the same limit.
- **Gentle use** (Björn's ok, 2026-11-16): at most two requests a second to that server from each running copy, with
  the honest user agent, read live and quoted, never copied (its rights field is empty). Done with the contract's
  existing `hostPolicies` (`minIntervalMs: 500`), which the SKOS profile now takes from the deployment
  (`SkosProfileOptions.hostPolicies`, keys lower-cased); vocabularyserver.com keeps its 5 a second.
  A concept costs about seven requests, so about 3.5 s there.
- **Checked** live from a local Worker (`wrangler dev`): searches and concepts for chorro, merengue (five senses), su
  ("Hipoc. de Susana") and cambalache. Tests: the lexicon is listed after UNESCO, its requests go only to its base, and
  requests there start at least 450 ms apart while vocabularyserver.com is not throttled (mutation-checked), and a
  search answer recorded live from the lexicon is read correctly.
- **The core's host throttle no longer chains promises** (review, 2026-11-16). This is its first use in a deployed
  Worker, and on Workers a timer can be dropped when the request that set it ends (a tool that fails while a sibling
  call still waits, a client that disconnects); with a promise chain every later request to that host would then wait
  for the rest of the isolate's life. Each caller now reserves its start time synchronously and waits only on its own
  timer: the same spacing and order, no shared promise. A test drops one waiter's timer and checks that the next one
  still starts (it hangs on the old code). The stall did not show in `wrangler dev`; the change removes the possibility.
- **A bound on the queue** (second review): the throttle had no maximum wait, so on a public endpoint a burst could
  push a host's next turn far ahead and later calls would hang without an error. `HostPolicy.maxQueueMs` (contract,
  optional, 0.x) makes a request whose turn is further away fail at once with a rate-limit error, reserving nothing.
  The demo sets 30 s for the lexicon host (10 s at first; raised 2026-11-17, Björn, after a test conversation left two
  lookups unchecked: the assistant fired a batch of searches at once and the later ones were refused; the server still
  sees at most two requests a second); without it the queue stays unbounded, so the parliament profile behaves as
  before.
- **Reply posted** 2026-11-17 on #137 (Björn's ok): the demo on his lexicon and tango, his proxy (dates that do not
  move, PR offers), questions (`docs/upstream/tematres-137-reply-draft.md`).

## 2026-11-17: the project's TemaTres test instance in the TemaTres demo

- **Why** (Björn, 2026-11-17): the second reply on tematres/TemaTres-Vocabulary-Server#137
  (`docs/upstream/tematres-137-reply-2-draft.md`) offers the maintainer changes to TemaTres's side to try before they
  become PRs, first a session-free web service. They are tried on the project's own instance, run from the tematres-test
  project, so the demo should reach it too.
- **What**: `unesco-test`, "UNESCO Thesaurus (English), test copy on vocab.hagstrom.nu", at
  `https://vocab.hagstrom.nu/unesco/` (a plain TemaTres 4.0 with the UNESCO Thesaurus, CC BY-SA 3.0 IGO, attribution in
  its rights field; concept URIs `/unesco/skos/<id>`). Listed after the lexicon; UNESCO on vocabularyserver.com stays
  the default. `TEMATRES_ALLOWED_DOMAINS` gains `vocab.hagstrom.nu`; no host policy, as it is our own server, so the
  service's 5 a second applies.
- **Checked**: a search answer recorded live from the instance (`tests/fixtures/unesco-test-search-universal.json`) is
  read correctly, and requests go only to its base. The recorded answer already came with `Cache-Control: public` and
  no cookie, the session-free web service being in place there.

## 2026-11-18: a vocabulary can be answered from a snapshot, revalidated once a minute

- **Why** (Björn, 2026-11-18): a vocabulary tool call took 0.3-0.5 s, and repeated calls were no faster. The core's
  cache uses the Workers Cache API, which does nothing on a `*.workers.dev` host, so every call went to TemaTres (the
  Worker logs showed `cache_hit: false` on three identical calls in a row). A small vocabulary fits in memory whole,
  and its server can say cheaply whether it changed.
- **What**: `VocabExt.snapshotUrl` names a full snapshot of a known vocabulary: NDJSON, one SKOS concept per line
  (`packages/profile-skos/src/snapshot.ts`). It is loaded once per process or isolate and kept in memory; after a
  minute the next call asks again with `If-None-Match`/`If-Modified-Since`, a 304 keeps the copy, a 200 replaces it.
  Generic: any server that publishes such a file can be a source; the adapter stays the vocabulary's own.
- **Only complete answers from the snapshot**: an id or a search the snapshot has no answer for (a concept added since
  the file was written), a concept that refers to one the snapshot lacks, scheme information, and every call while the
  file cannot be had go to the live adapter as before. A failed refresh keeps the copy and asks a minute later; a
  failed first load is not retried for a minute. The URL passes the deployment's guards on every call, so one service's
  loaded snapshot is never used by a service that may not reach its host.
- **What changes in answers** (before/after, rule 8), when the snapshot answers:
  - a concept's `ext` is `{ snapshot: { lastModified } }` instead of `ext.tematres`: no code, meta-term flag, relation
    sub-types, other relation types, target vocabularies or partial matches, as the SKOS export does not carry them;
  - mappings carry type and URI only, without the label and target vocabulary name the live service gives;
  - search and suggestion hits have `lang` and no `ext.tematres` (index, meta-term flag);
  - `hiddenLabels` are filled and searched (live: always empty), and never shown as the matched label;
  - relations are in label order (root collation at base strength, so "ä" sorts as "a", as TemaTres orders them;
    Svada's known answer for the narrower concepts of 36 stays the same), and the path follows the first broader concept by URI (in a polyhierarchy it may
    differ from TemaTres's `fetchUp`);
  - search hits: preferred-label matches first (exact, prefix, a word start anywhere in the label, inside a word), then
    matches on other labels with the label that matched; suggestions: prefix or word-start matches only, at most 50;
  - editorial notes are shown, as from the live service, but typed `editorialNote` (live: `note` with
    `sourceType: "ED"`; likewise `changeNote`/`example` for CH/EX), and no note has a `sourceType` (TemaTres's export writes its editorial notes, ED, as
    `skos:editorialNote` and never writes private ones, NP; tematres-test, 2026-11-18); NB notes are missing, as the
    export writes them as `dc:source`;
  - a grouping (meta) term is a plain concept in the export, so answers from the snapshot do not mark it (Svada's
    three top concepts are such terms);
  - top concepts come from the snapshot only when it marks them with `topConceptOf`; otherwise from the live service
    (a concept without a broader one may be outside the hierarchy, and TemaTres does not list those);
  - a change in the vocabulary shows after the server rewrites the file plus at most a minute. The server must replace
    the file atomically: a partial file that still parses would be taken as the whole vocabulary.
  - The log line gains `source` and `snapshot_loaded`. Not changed: the server instructions still say the tools read
    "live from the vocabulary service", and `vocab_suggest` still says "start with or contain"; the copy is at most a
    minute behind the file, and a suggestion that only matches inside a word goes to the live service when nothing
    else matches.
- **A load other calls wait for** (review, 2026-11-18): on Workers a request's I/O ends with the request, so a load
  started by a request that went away may never settle. Each caller waits on its own timer for at most 15 s and then
  answers from the copy it has or live, and a load older than that is started afresh; the same rule as the core's host
  throttle (2026-11-16).
- **Measured**: parsing the UNESCO test copy's 2 MB snapshot (4,500 concepts) takes about 10 ms on a laptop. Against
  the live file: the three known answers of `tematres-test/testinstans/kanda-svar/unesco.json` match; the first call
  took 370 ms (the load), the next 0-3 ms, and the conditional request a minute later got `304`.
- **Where**: `unesco-test` in the TemaTres demo, whose server already publishes `dumps/unesco.ndjson`; Svada since
  begrepp.hagstrom.nu publishes `dumps/svada.ndjson` (tematres-test, 2026-11-18: rewritten every minute when changed,
  `topConceptOf` on its top concepts, 304 through Caddy with and without gzip; checked here the same day), in both the
  several-service Worker and host-vocab.

## 2026-11-18: every vocabulary answer names its source: the vocabulary, its creator and URI

- **Why** (Björn, 2026-11-18): in tematres/TemaTres-Vocabulary-Server#137 the maintainer explained "accreditation" as
  attribution to a responsible subject, and our reply of 2026-11-17 promised that every answer would name the lexicon
  and its authors, not only the entry's URI. Until now the answer named only the vocabulary's id.
- **What** (`packages/profile-skos/src/tools.ts`): every tool that answers about concepts (search, suggest, get
  concept, broader, narrower, related, top concepts) adds `source` to its JSON (`title`, `creator`, `publisher`, `uri`,
  `modified`, each as the vocabulary's own scheme data gives it, each capped at 300 characters) and a closing Markdown
  line "Source: <title>, by <creator>. <URI> (last changed …)", passed as the trailer so truncation keeps it.
  `vocab_scheme_info` is unchanged: it is the source. The server instructions now ask the model to name the source as
  each answer gives it, with the concept URIs.
- **Memory**: per set of tools (one service), so two services in one isolate never share it (the TemaTres demo cannot
  touch the Svada service's source), keyed by vocabulary id, adapter and base URL (a vocabulary reached by base URL by
  adapter and base URL without its final slash, so `/vocab` and `/vocab/` are one). The deployment's own vocabularies
  are never evicted; besides them at most 100 reached by base URL are kept, the oldest evicted first. The scheme
  is read once per vocabulary and hour, in parallel with the first answer; calls racing on a cold memory share one read.
- **Waiting**: the source's read starts before the answer's own requests (so on a throttled host it is not queued
  behind them). An answer waits for it only while the vocabulary's entry is not fresh, and only until 3 s after that
  read began, so a burst of answers arriving during a hang waits once, together. Each answer has its own timer, set to
  the time left until that moment: on Workers a timer dies with the request that set it (as recorded for the throttle
  and the snapshot), so no answer waits on another's. A
  read that fails, answers with nothing usable, or is not done in 3 s leaves the last source (or the stand-in) standing
  for five minutes, so while a vocabulary service hangs answers wait at most once in five minutes, and then at most
  3 s. A read pending for 15 s is taken as lost (on Workers it dies with the request that started it) and started
  again; only the latest read may write. Cost on the demo: one 200 ms
  rate-limit token (its burst is 1), and on terminologias.filo.uba.ar one 500 ms throttle slot, once an hour.
- **Failure**: a source never fails an answer, and an answer's own error wins. If the scheme cannot be read, or
  answers with neither title, creator nor publisher, the last
  source read stands (or, the first time, the deployment's title, else the id, with the base URL), and the read is
  tried again after five minutes.
- **Text from upstream**: each field is cleaned when read, for JSON as for Markdown: line breaks and control
  characters become spaces, at most 300 characters (the stand-in's title too). The URI is never cut, since a cut one
  names nothing: it is kept only if http(s), without spaces or control characters and at most 300 characters, else
  the last good one or the base URL; the stand-in's base URL as given (at most 500 characters, as the argument allows). In Markdown title, creator, publisher and date are also shown with `sanitizeInline`, as
  labels are; the URI with `safeUrlText`.
- **Left as they are** (Codex, 2026-11-19): (1) a `vocab_get_concept` JSON answer too large for the character limit
  (default 50,000) is replaced whole by the core's truncation notice, source included, as is a list answer that does
  not fit even with `concepts` emptied; there is then no answer to attribute. The other six tools shrink their
  top-level `concepts` and keep `source`. (The profile's other shrinkable keys sit inside `concept`, where the core does
  not look; a separate matter.) (2) At a character limit too small for the source line and the truncation marker
  together (at most about 2,800 characters with every field 300 pipes, each escaped to two; the default is 50,000) the
  core keeps only the start of the trailer. (3) The core cached any 2xx answer before the adapter parsed it, so a
  malformed 200, or a well-formed one with nothing usable, came back from the cache for the scheme TTL. Fixed
  separately on 2026-11-19 (next entry): such answers are no longer cached. (1) changed for `vocab_get_concept` on
  2026-11-19: see "one concept in JSON is cut inside the concept".
- **Output change**: a new field in JSON and a new last line in Markdown for seven tools; nothing removed or renamed.
  Not a CKAN tool, so rule 4 does not apply. Tests: `packages/profile-skos/tests/profile.test.ts` ("the source of every
  answer", twenty-four tests), a smoke case (`source.title` of Svada concept 10), the snapshot and host tests now count the
  scheme read apart from the answer's requests, and `host.test.ts` checks that the demo's refused call leaves Svada's
  source untouched. Mutations caught: the hour, the five minutes, the retry, the key, a memory shared between
  services, the trailer, the 3 s bound, recording a slow read, the 15 s restart, latest-read-only writes, protecting
  the deployment's vocabularies, the error waiting for the source, the field cap, keeping the last source; after the
  Codex pass also a timer per answer instead of per read, evicting any entry, the final-slash key, the stand-in cap,
  an empty scheme overwriting the last source, a non-http URI, control characters, and the production timings
  (pinned in a test); after the second mcp-reviewer pass also an answer with no timer of its own (its request's timer
  dropped, as on Workers), a timed-out wait forgetting the read (so a late read could not write), the last good URI,
  and a cut URI.
- **Reviewed** (mcp-reviewer, 2026-11-18): the first version kept one memory per module, awaited a shared read without
  a timer (a read lost with another request could hold every answer for an hour), appended the line to the body (cut by
  truncation) and pinned too little in tests; the second pass found that a wait that ran out recorded nothing (so every
  later answer waited 3 s), eviction of the deployment's own vocabularies and late writes by superseded reads; all
  changed as above. Codex (OpenAI, 2026-11-19, run by Björn on 6ded2ba): JSON fields not cleaned, a burst waiting 3 s
  each (one timer per answer), the deployment's vocabularies evictable when they alone fill the memory, an empty scheme
  answer overwriting the last source, `/vocab` and `/vocab/` as two vocabularies, the stand-in not capped, timings not
  pinned; all changed as above; three points left as they are (above). mcp-reviewer on those changes (2026-11-19): one
  timer per read let an answer on Workers wait on a timer dropped with another request (so it could hang until the
  runtime cancelled it); changed back to a timer per answer, ending when the read's 3 s end. Also: a URI over 300
  characters was cut (now never cut), no test for a late read writing or for the last good URI (added), and the three
  points left as they are were stated wider or narrower than the code (corrected).

## 2026-11-19: the HTTP cache keeps only answers the caller can use

- **Why**: Codex and mcp-reviewer (review of the source of every answer, above): the core cached every 2xx body before
  the adapter parsed it. A TemaTres service that answered once with a maintenance page, invalid JSON or an empty scheme
  record under status 200 kept failing from the cache for the TTL (an hour for the scheme and the SKOS export, five minutes for terms),
  for every cached TemaTres call, after the service had recovered.
- **What**: `FetchOptions.cache` takes an optional `accept(answer)` (`packages/profile-contract/src/index.ts`); the core
  caches a 2xx body only when it returns exactly `true`, and not when it throws (`packages/core/src/net/client.ts`).
  Without it, every 2xx is cached as before, so no other profile changes (CKAN untouched; rule 4). The core names no
  backend: the check is the caller's.
- **TemaTres** (`packages/profile-skos/src/adapters/tematres/`): the vocabulary's own data (`fetchVocabularyData`, an
  hour) is cached only if it parses and names the vocabulary (a title, author or publisher with a character that is
  neither white space nor a control character, the rule the source of every answer uses). The term tasks keep the
  core's default (every 2xx, five minutes): checking them would make a service that keeps answering with a page be
  asked on every call. The SKOS export (`xml.php?skosMeta=1`, an hour) is cached only if it looks like RDF/XML (it
  starts with a tag, and is not HTML by content type or by a leading doctype or html tag). A 200 that does not is not
  cached and is remembered as a refusal for five minutes (a 4xx for an hour, as before), so a passing page does not hold
  the default URI pattern for an hour, and a page that stays is asked once in five minutes, not on every call. RDF/XML
  without a top concept is the vocabulary's real answer and is cached.
- **Cost**: the scheme is parsed twice on a cache miss (once to accept it, once to use it). A vocabulary reached by
  base URL whose scheme never parses (not a TemaTres service) is asked for it on each `vocab_scheme_info` call; the
  source of every answer asks at most once in five minutes.
- **Tests**: `packages/core/tests/client.test.ts` (refused, accepted, a check that throws, a truthy non-boolean);
  `packages/profile-skos/tests/profile.test.ts` ("the HTTP cache keeps only answers the profile can use", six tests,
  with the cache on). Mutations caught: the core ignoring `accept`, a truthy result accepted, a throwing check caching,
  the scheme rule reduced to the title, blanks counted as a name, term tasks not cached, each of the three halves of
  the RDF check, a 200 page not remembered, remembered for an hour, and the export cached whatever it is.
- **Also in this commit**: the test "a burst of answers during a hang waits once" (the source of every answer) no
  longer measures wall-clock time, which failed once under a full parallel run; it records the delay each answer's
  timer is set to and requires each at most the time left of the read's wait.
- **Reviewed** (mcp-reviewer, 2026-11-19): a page that stays was asked on every call (now five minutes); the RDF check's
  halves and the author- or publisher-only scheme were untested; the scheme rule differed from the source's (blanks);
  an empty or plain-text export answer was cached for the hour; a doc comment displaced in the core client; the burst
  test's rewrite unrecorded. All changed as above.

## 2026-11-19: one concept in JSON is cut inside the concept, and keeps its source

- **Why**: a `vocab_get_concept` JSON answer is `{ vocab, concept, source }`. The core shrinks top-level lists only,
  so an answer above the character limit (default 50,000; thousands of narrower concepts, or very long notes) was
  replaced whole by the core's notice: the model got neither the concept nor its source. Markdown already kept its
  start and its source line.
- **What**: `fitConceptAnswer` in `packages/profile-skos/src/tools.ts`, called for JSON only, before
  `ctx.output.json`, with `ctx.limits.characterLimit`. An answer that fits is passed on untouched (no new field).
  Otherwise the answer is rebuilt from its frame (`vocab`, the concept's `id`, `uri`, `prefLabel`, `lang`, and
  `source`, never cut) by filling in order of value: (1) the notes: as many as fit at their shortest, with room kept
  for the least everything else can cost, and up to half the room; (2) `created` and `modified`, each only if what
  follows can still be paid for at its least; (3) the lists in the order `broader`, `path`, `altLabels`, `hiddenLabels`, `mappings`, `related`, `narrower`:
  a list is taken whole only if the least the lists after it can cost still fits, otherwise the longest start that
  fits, and the ones after it get nothing; (4) `ext`, if it fits; (5) the notes again, with all that is left. Notes are
  fitted in their order and shared like water: a note smaller than the level stays whole, a note whose shortest cut is
  above it gets that, the others are cut to the level. A cut note keeps at least 200 characters (code points: an emoji
  counts as one), is never cut inside a character, and ends in " … [cut]"; notes that do not fit at their shortest are
  left out from the end. The answer then carries `_truncated: true` (the core's name), `_cut`
  (`{ <list or field>: { shown, total } }` for every list, field or `ext` cut or left out) and `_note`, a sentence for
  the model that names `vocab_narrower`, `vocab_related` and `vocab_broader` ("one list each, themselves within the
  same limit"). The order is by what the model can get elsewhere and what says least: the notes (the definition) are
  only here. Every step keeps room for what follows at its least (each later part whole or its `_cut` entry,
  whichever is less; for the lists, the next ones whole up to one cut with all after it), so neither the optional
  fields, the lists nor `ext` can cost a whole note, only characters of a cut one; and once a limit gives a fitted
  answer, every larger limit does. An empty list is never reported as cut.
- **Fitting**: one fill. The bare frame (with an empty `_cut`) decides first whether anything can fit. `_cut` is paid
  for as it grows (the notes' entry at its widest, a few digits at most to spare), each entry at its exact size with a comma; the first entry has none, so that character is given
  back, and in the one case where no entry is made the fill is repeated without it. When something divisible takes
  the remainder (a list, a note), the answer ends within a single entry of the limit; when what is left out is
  indivisible (a label of 60,000 characters), the answer is as short as what remains. If even the frame and what
  `_cut` must say do not fit, the answer is left to the core's notice, which then carries neither the concept nor its
  source.
- **Both channels**: unchanged mechanism. The fitted object is at most the limit as compact JSON, so the core sends
  it as it is and builds `structuredContent` by parsing that text.
- **Rejected**: (a) nested shrink paths in the core and the contract (`concept.narrower` in `shrinkableKeys`), the
  idea noted on 2026-11-09: it changes the profile API and the function CKAN's output passes through (rule 4), cuts
  lists only, so one long definition would still empty every list before it and then be dropped whole, and the core
  cannot say which tool gives the rest (profiles own model-facing text, rule 3). (b) Running the core's
  `truncateJson` on the concept alone with the profile's keys: same weakness with long notes, and `_original_count`
  names one list without saying which. (c) Moving `source` first or flattening the concept to the top level: changes
  the JSON shape of every answer to help the rare one. (d) Paging arguments on `vocab_get_concept`: a change to the
  frozen tool surface. (e) Cutting the text and closing the JSON by hand: fragile, and the two channels would differ.
- **Limits**: a character limit too small for the frame (about 1,000 characters with ordinary values and every
  list filled; a hostile label is not cut) still gets the core's notice, as before, decided before any other work.
  With too little room for even the first note at 200 characters, the lists may take what there is.
  `vocab_narrower` and the other list tools are themselves cut at the limit (their `concepts` shrink, with the
  count), so a list above the limit cannot be read whole through any tool; paging would be a separate decision. The
  profile's `shrinkableKeys` still lists keys that sit inside `concept`, where the core does not look; left as is. A
  list answer that does not fit even with `concepts` emptied is unchanged (not reachable with the source capped).
- **Cost** (of `fitConceptAnswer`; when it leaves the answer to the core, the core then serializes it as before):
  nothing when the answer fits beyond one `JSON.stringify`. Otherwise, linear in what upstream sent: each list entry
  measured once (at most the limit's count of entries per list) and each note once (its fixed part, which comes from
  upstream too, and its text capped at the limit); a note that cannot fit even at its shortest in the most room there
  is is left out at once, and of the rest at most the limit's count are fitted. The rest is bounded by the limit, not
  by upstream: at most two fills, each with two note fits; the number of notes comes from their shortest sizes, the
  water level by binary search, and each cut note is searched by serializing only its text's prefix. A label of
  megabytes is decided after two serializations. Tests bound the call count (a list of 200,000, a 2 MB label), the
  characters serialized (a note with a 1 MB `sourceType` among 600) and the time (50,000 tiny notes).
- **Output change**: only answers that were replaced by the notice before; three new top-level fields on those.
  Markdown and the six other tools unchanged; the frozen tool surface unchanged.
- **Tests**: `packages/profile-skos/tests/profile.test.ts`, "one concept in JSON at the character limit"
  (thirty tests, end to end through MCP and on the function). Cases: 3,000 narrower concepts (one more would pass
  the limit); a 120,000-character note taking the room left; long notes and a long list (the notes about half); lists
  given up in order, end to end and at every limit (a list partly kept, those after it empty; once one is cut, a later
  list of tiny entries gets nothing); a small limit; huge `created`, `modified` and `ext` left out and reported with a
  short definition kept, and never pushing the answer over the limit at any limit; `created` and `modified` before the
  lists and `ext` after them; 300 notes; equal notes of emoji; notes of emoji keeping 200 emoji; a note whose 200th
  character is an emoji, at every limit; notes before any list at every limit; `ext` never costing a whole note at
  every limit; more room never fewer notes; an exact-fit limit and one a little larger; a cut list coming back whole at
  an exact fit; a useful note after 1,000 that never fit; a note fitting the limit but not the room; bounded work
  (time, characters, calls); a limit below the frame; Markdown unchanged, also for an oversized concept; and, at every
  limit, once an answer is fitted every larger limit gives a fitted one (never left to the core), also with optional
  fields of 19 to 300 characters and an adapter's empty `ext`, at every limit; an optional field never costing the
  definition, nor dropped again with more room. Mutations caught:
  the entry for `ext` reserved through the lists, the later lists' entries, a whole list ignoring the rest, the notes
  ignoring the rest, an optional field's entry, an entry one character short, the comma given back, the floor in
  UTF-16 units, the cap before the filter, `modified` treated as optional, the first pass sized for the count, the
  level ignoring minimums, strict list order, the frame floor, the 200-character floor, the half-character guard, the
  list cap, hopeless notes kept, a swap in the list order, `ext` always kept, `ext`'s entry unpaid, an optional field taking room blindly, `ext`'s entry reserved when it
  whole is cheaper, an empty list cut, the notes' reserve, the lists' least ignored.
- **Reviewed** (2026-11-19): written by a Fable agent without our proposal (nested shrink paths in the core),
  which it rejected (above); then mcp-reviewer and Codex on that version. They found: every probe re-serialized the
  whole answer (70 to 120 serializations for an answer that could never fit); an optional field or a large `ext`
  could cost the whole concept, and `ext` was emptied only after the notes; the half-limit note budget left room
  unused; the note-length search was not monotonic and could cut inside a character; three behaviours and the order
  were not pinned by tests; cost and limits stated wrongly. Rewritten as a fill by value. Second pass,
  mcp-reviewer and Codex on def7d55: fitting notes tried every count with a sort each (quadratic; 50,000 tiny notes,
  about 1 MB, took tens of seconds) and re-serialized a note's other upstream fields with every probe (a 1 MB
  `sourceType`, gigabytes); the floor used the largest `_cut` and gave up when a smaller answer fitted; the candidate
  was chosen by size; a cut note could keep 199 characters when the 200th split a character; the test of 3,000
  narrower concepts had been loosened; cost and closeness stated wider than the code. All changed as above. Third
  pass, mcp-reviewer: the notes' second fit could lose a note; parts of the order and Markdown for an oversized
  concept were not pinned; a note fitting the limit but never the room could keep the others out; four fills, not
  three; cost stated as arithmetic. Codex on the result: a cut list could not come back whole (its own reserve), the
  floor counted UTF-16 units (100 emoji passed), the note cap came before the filter, `modified` was untested, the cost
  claim stopped at the function. Fixing those, property tests over every limit found the multi-pass reserves
  overrunning or under-using the limit at boundaries; rewritten as one fill paying for `_cut` exactly, with notes
  counted by their shortest sizes and shared like water. Fourth pass, mcp-reviewer on that: an optional field was taken
  without keeping room for what follows (left to the core, or costing the definition, with any date longer than
  TemaTres' 19 characters); `ext`'s entry was reserved even when `ext` whole is cheaper; an empty list could be
  reported as cut; stale comments. All changed as above. The steps (Fable's version and the rewrites) are one commit.

## 2026-11-19: follow-ups from the reviews

- **The CKAN ecosystem's README cache keeps only READMEs** (`packages/profile-ckan-ecosystem/src/tools.ts`). A README
  from raw.githubusercontent.com was cached for a day as any 2xx, so an HTML page in its place (a proxy's or a
  firewall's page under status 200) would stand for the day. Now the cache's `accept` refuses an HTML answer (by
  content type or a leading doctype or html tag), and such an answer is reported as an unreadable README instead of
  being read for its opening (no "HTTP 200" in the note). A README with no prose is still a real answer and is cached.
  Same failure class as "the HTTP cache keeps only answers the caller can use" (above). A README whose file itself
  begins with an html tag or doctype would count as a page (none known in the index). Test:
  `packages/profile-ckan-ecosystem/tests/contract.test.ts`: a page refused by either signal, in Markdown and JSON; a
  README with no prose, or opening with its own `<p align="center">`, `<h1>` or a comment, still cached and read.
  Mutations caught: accepting everything, no HTML check on reading, any leading tag taken for HTML, a no-prose README
  not cached.
- **The SKOS profile's shrinkable keys are only `concepts`.** The others (`results`, `narrower`, `related`, `broader`,
  `altLabels`, `notes`, `mappings`) are never top-level in any answer, so the core never used them; one concept's lists
  are fitted by the profile ("one concept in JSON is cut inside the concept", above). No behaviour change; a test now
  pins that a list tool at the limit shrinks `concepts` and keeps its source (the `_note` relies on it).
- **A source field is cut at a whole character** (`field()` in `packages/profile-skos/src/tools.ts`), with the same
  `prefix` as the notes, so a 300-character cap never leaves half of an emoji. Test: the hostile-text source test, with
  a title of 400 emoji; mutation caught: the old `slice`.
- **The CKAN ecosystem cuts at whole characters too** (follow-up, same day). `short()` (descriptions and plugin lists
  in search rows) and the end of `readmeOpening` cut by UTF-16 unit and could leave half of an emoji; both now use
  `wholePrefix` (`packages/profile-ckan-ecosystem/src/data.ts`), the same rule as the SKOS profile's `prefix` (profiles
  do not share code; the core has no such helper). The first slice in `readmeOpening` stays as it is: it is only
  searched for a space. The helper is a copy of the SKOS profile's `prefix`; moving it into the core would change the
  core's surface for three lines, left for when a third profile needs it. Tests: `data.test.ts` (cuts at whole
  characters, exact values, a late space), `contract.test.ts` (a long description, exact value); mutations caught at
  both cut sites.


## 2026-11-19: ondata's CKAN changes since cb2119d reviewed (upstream watch, issue #1)

23 commits on ondata/ckan-mcp-server between `cb2119d` and `c3d7dc0` (origin/main on 2026-11-19): three code
commits, ported below, two release commits, and eighteen data and docs commits (`chore(data):` telemetry and download
updates, two `docs(log):` live-check notes), which the watch ignores. The watch baseline moves to `c3d7dc0`. The
parity reference stays at `09e8cdc` (the recordings and the clone are unchanged).

- **Ported: `9e52cfa`** (#598): `ckan_find_portals` reads null registry fields as empty (the `language` filter failed
  on every call: 3 of 945 active portals have no default locale); data.gov.au routed to its `/data` API base, Data.NSW
  added to `portals.json`; the "Full JSON metadata" links and `api_json_url` built on the routed base
  (`getPortalActionBase`, in `packages/profile-ckan/src/utils/portal-config.ts`). Deviation D15. ondata has no test
  for the links; two new ones in `package-show-formatting.test.ts`.
- **Ported: `81fad15`** (#600): data.europa.eu in `portals.json` as a migrated portal whose notice says it is not
  CKAN and points to `sparql_query`; `ckan_find_portals` takes `response_format` (JSON through the core's JSON result,
  errors through `formatError`). Deviation D16; the `tools/list` entry is checked against ondata's with exactly this
  change applied. ondata's `docs/JSON-OUTPUT.md` change has no counterpart here.
- **Ported: `bbb4a26`** (#603): `ckan_datastore_search` `q` as a string or `{ column: word }` (sent JSON-encoded); a
  409 hint on `datastore_search` for "full text search is not supported". Deviation D17, `tools/list` checked as D16.
- **Dismissed: `ae9cab2`, `2f84a9d`** (v0.4.143, v0.4.144): version bumps and release notes, releasing #598 and #600;
  no other runtime change. Our version is our own (D13).
- `portals.json` is now byte-identical to ondata's at `c3d7dc0`; the tool texts of `ckan_find_portals` and
  `ckan_datastore_search` and the new hint are ondata's, byte for byte. 14 ondata tests (grep count) ported with
  unchanged expectations, each failing with its change reverted except two that pin existing behaviour; five new
  tests for branches ondata does not test (`docs/test-parity.md`). Reviewed by `mcp-reviewer` before the commit. D15 to D17 leave the deviation list when the parity baseline moves past them.

## 2026-11-20: D10 (undeclared gzip) is not worth reporting to ondata

Checked whether ondata's Worker users meet the gap D10 closes (a gzip body without `Content-Encoding` is unpacked by
ondata's Node path, not by its Worker). ondata added the magic-byte unpacking on 2026-02-01 ("Fix compressed datastore
responses", v0.4.29) for the DataStore of dati.comune.messina.it. Two requests on 2026-11-20 (honest User-Agent, two
seconds apart): with `Accept-Encoding: identity` (ondata's Worker) Messina answers plain JSON; with `gzip, deflate,
br` (ondata's Node path) it answers Brotli and says so in `Content-Encoding: br`. No portal in our 133 recorded
requests to 9 hosts sends undeclared gzip either. So no user-facing failure is known; D10 stays a deviation, not a
report. Revisit only if a portal is seen sending gzip without the header.


## 2026-11-21: TemaTres's term count is not a concept count; a tool for a random concept

- **Why**: `vocab_scheme_info` gave TemaTres's `cant_terms` as the number of concepts (`scheme.conceptCount`,
  Markdown `- **Concepts**: N`). `cant_terms` counts every accepted term, alternative (non-preferred) terms included
  (`ARRAYcantTerms4Thes`, fun.sql.php: `count(*)` over `tema` with `estado_id = 13`): Svada has 23 concepts and 16
  alternative terms, and `cant_terms` is 39. A model told a user "the vocabulary has 39 concepts".
- **What, scheme information** (a JSON shape change in our own profile; rule 4 does not apply, but clients of the
  production service see it):
  - `scheme.conceptCount` (from `cant_terms`) is now `scheme.termCount`; Markdown `- **Terms, preferred and
    alternative**: 39 (not the number of concepts, which is not known here)` replaces `- **Concepts**: 39`; with a
    loaded snapshot, which gives the number of concepts, the line ends at "(not the number of concepts)". The tool description says that
    `termCount` is not the number of concepts.
  - `scheme.conceptCount` is given only where the number is known: when the vocabulary's snapshot is loaded, the
    number of concepts it holds, with `scheme.ext.snapshot.lastModified`; Markdown `- **Concepts**: 17 (in the
    vocabulary's snapshot of <Last-Modified>)`. Scheme information never loads the snapshot for this (it reads only a
    copy already in memory, through the same URL guards), and a file cut at the 200,000 concepts read gives no count.
  - Before/after (rule 8), Svada from the recorded answers: JSON `"conceptCount": 39` → `"termCount": 39`; Markdown
    line as above; nothing else changes. Migration: a client that read `conceptCount` reads `termCount` for the same
    number, and treats it as terms.
- **What, `vocab_random_concept`**: one concept picked at random, answered as `vocab_get_concept` (the same concept
  JSON and Markdown, the source, JSON fitted by `fitConceptAnswer`). Arguments `vocab` and `response_format`.
  Read-only, not idempotent (a new entry in the frozen surface, `tests/frozen-tools.json`; nothing existing changes).
  - The adapter contract gets an optional `randomConcept`; a backend without it, or one that cannot pick, gives
    `RandomConceptNotOfferedError` ("does not offer a random concept", with a hint to browse or search instead).
  - TemaTres: services.php `randomTerm` (in TemaTres 3.6.1 and 4.0; SQLrandomTerms picks one accepted, preferred term,
    `ORDER BY rand()`), added to the adapter's task list and asked without the HTTP cache (a cached pick would always
    be the same one), then the concept by its id as `vocab_get_concept` reads it. A TemaTres without the task answers
    with its XML page for an unknown task ("invalid task param"); that, and only that, becomes the not-offered error.
  - Snapshot: when a snapshot is loaded, a concept is picked among its concepts with equal chance, without a request;
    one the snapshot cannot answer whole (a relation outside it) is read live by its id. Without a snapshot the live
    service picks.
  - Server instructions name the tool for "show me a random term". Smoke: one case with a known part of the answer
    (`source.title`), since the concept varies.
- **Reviewed** (mcp-reviewer, 2026-11-21): no BLOCKER. Fixed: `randomTerm` was tested only against a shape the test
  wrote, so the real answer is now recorded (`fixtures/tematres/random-term.body`, TemaTres 4.0) and the tests build
  on it, with a row in `docs/tematres-api-derisking.md`; a cut snapshot giving no concept count now has a test through
  `vocab_scheme_info`; a concept picked from the snapshot that the live service no longer has now lets the live
  service pick, instead of "the vocabulary may be empty"; the description and the Markdown line say that without
  `conceptCount` the number of concepts is not known and must not be derived from `termCount`; `docs/vocab-service.md`
  names the random tool's concept id in the log and that its pick is not cached. The snapshot's count is the number of
  lines it could read (a line without a usable label or URI is skipped), recorded as such.
- **Meta-terms.** The recorded `randomTerm` answer was a meta-term ("Styrning och regler", `isMetaTerm: 1`, a grouping
  term): TemaTres picks among them too, and the SKOS export (so the snapshot) carries them as ordinary concepts
  without the flag. Both paths therefore may give a grouping term. Kept on purpose (Björn, 2026-11-21): a grouping
  term is a concept in the SKOS export, the answer shows its narrower concepts, and the snapshot could only guess
  which concepts are grouping terms, so skipping them on one path would make the two paths disagree.

## 2026-11-23: An instance's own note types; Svada's change notes as skos:changeNote

- **Why**: TemaTres's web service gives a custom note type by its code only. Svada's change notes (`CH`) came out as
  plain notes (`note`) when a concept was read live (concept 55, recorded as `fixtures/tematres/notes-55.body`), while its SKOS export, and so the
  snapshot, has them as `skos:changeNote`. The same concept read two ways gave two note types.
- **What**: a deployment may declare the SKOS property of an instance's own note codes (`VocabExt.noteTypes`, e.g.
  `{ CH: "changeNote" }`); the TemaTres adapter uses it before its built-in codes, and only for the instance's own
  keys (an inherited key is no declaration). Private notes (`NP`) stay hidden. Both hosts declare it for Svada.
- **Before/after** (rule 8): a live answer for a concept with a `CH` note gives that note `type: "changeNote"`
  instead of `type: "note"`, and in Markdown the heading `## Change note (sv)` instead of `## Note (sv)`; nothing else
  changes. A snapshot answer is unchanged.
- **Only CH for Svada**: the live/snapshot difference recorded for `ED` and `EX` (2026-11-18 entry) does not arise
  there: Svada's dump of 2026-11-23 holds 27 change notes and no editorial notes or examples. Another instance with
  such codes declares them the same way.
- **Also**: a code that is an inherited key of the built-in table (`constructor`, `__proto__`) was taken as a note
  type (JSON without `type`, Markdown heading `undefined`); now only the table's own keys count, as for the
  declaration.

## 2026-11-22: Changes to a vocabulary through the MCP: prepared against a proposed format

- **Why**: Björn wants Svada changed through the MCP. TemaTres has no write API; the two rounds of 2026-11-22 were made
  with php-cli scripts on the server. The tematres-test project builds a write API (preliminary study and plan first,
  the plan approved by Björn); the order and our requirements are in its handoff file of 2026-11-22. This side is
  prepared meanwhile, against the format we proposed there, so that only one file changes when the format is agreed.
- **What**:
  - `vocab_propose_changes` (a dry run: before, after and the change note per change, conflicts, a batch id; writes
    nothing) and `vocab_apply_changes` (the batch id only; `destructiveHint: true`). Offered only when a deployment
    gives a vocabulary `write: { url, keySetting }`, and only for those vocabularies, named by id in every call (no
    default: the reading tools' default may be another vocabulary with the same numeric ids; a base URL is refused, so
    a call never writes to a service the deployment did not name). No deployment has it yet.
  - The key is read from the core config at call time (`<PREFIX>_<keySetting>`) and must be printable ASCII without
    spaces; anything else counts as no key, so a malformed value never reaches an error message (a header value with a
    line break would). Sent only in the Authorization header, only over HTTPS; never in an instance object, an answer,
    an error or the telemetry. A write follows no redirect and is sent once, whatever the host's retry policy.
  - A refusal is answered with our text for its code; the service's message is never shown, neither for a refusal nor
    for a conflict.
  - The dry run is read fail-closed: an answer that does not account for every operation (by a change or a conflict),
    or that cannot be read whole, is an error with no id. A proposal too large to show whole is answered without its
    id. Conflicts come first, so no cut can lose them; a proposal with conflicts says not to apply it. Stopping such an
    apply is the service's job (the handoff asks for it); the MCP holds no state between the calls.
  - Markup is shown as stored whenever the markup written differs from the markup replaced (the plain text would hide
    a script or a dropped link attribute).
  - Apply takes no text, so nothing read from the vocabulary can shape a write: what is written is what the dry run
    showed. The descriptions say to change only what the user's material gives, to show the dry run, and to apply only
    after the user's explicit ok for that batch. A confirmed write is reported as written even if the rest of the
    answer is odd; an answer that does not say (a 5xx, an unreadable 2xx, no answer) is "may or may not have been
    written", with the hint to read back and not to apply again.
  - After an apply that may have written (not after a refusal that says nothing was written, nor when nothing was sent)
    the vocabulary is read live for an hour, the longest TTL of a cached live answer (TemaTres's scheme data): no
    snapshot, no cache read or write (`src/fresh.ts`), and the source line's memory reads the scheme again once. Every
    cached answer is then older than the write by more than its TTL. Per isolate; another isolate may answer from its
    cache until it expires, as before any write.
  - The wire format is provisional (replaced by the agreed one, 2026-11-23 entry) and kept in `src/adapters/tematres/write.ts` alone. The operation set follows the
    TemaTres proposal (`createMetaTerm`, note type codes, the three statuses); it is generalized when a second backend
    writes.
- **Who may call them**: the decision of 2026-11-14 to run without authentication rests on read-only tools and no
  secret in either Worker. A deployment with write access holds a key, and anyone with its URL could propose and
  apply. Decided 2026-11-22 (Björn): a password, see the next entry.
- **Reviewed**: mcp-reviewer, 2026-11-22: one blocker (a malformed key echoed by the runtime's header check) and eight
  should-fixes (fail-open dry-run parsing, truncation losing conflicts, a confirmed write reported as refused, the
  fresh window shorter than the scheme TTL and the source memory, `httpsOnly` without effect, markup hidden, no test
  for no-retry, a deployment's example in profile text), all fixed with a test each that fails without the fix.
- **Not yet**: a deployment with write access (first the test copy on vocab.hagstrom.nu, Svada only with Björn's ok;
  see who may call), the agreed format, smoke cases and evals for the change tools, and the frozen surface (the tools
  are absent from every deployment until then).

## 2026-11-22: The change tools sit behind a login, once, kept alive by refresh

**Decision (Björn)**: writing through the MCP needs a password; he does not want to log in regularly.

- **What**: a service of the several-service Worker may have a `login` (core `src/login.ts`). Its `/mcp` then answers
  only a request with an access token; anything else gets 401 with where to log in (RFC 9728). The login is OAuth 2.1
  with PKCE (S256), the way MCP clients (claude.ai, Claude Code) connect to a protected server: the client registers
  itself (RFC 7591), sends the person to a page where they type the password, and gets an access token (one hour) and
  a refresh token. Its endpoints sit under the service's path (`/<path>/authorize`, `/token`, `/register`); the
  discovery documents at the addresses RFC 9728 and RFC 8414 derive from it. It works the same for a private service
  at its secret path; the secret path then hides the service and the password guards it.
- **Logged in once**: a refresh token lives 90 days unused and is replaced at every refresh, so a client used at
  least once a quarter never asks again. The person logs in again only when the connector is added anew, or after
  the password or the signing secret changes, which ends every login at once.
- **Stateless, no library**: client ids, codes and tokens are HMAC-signed with a key derived from a signing secret, the
  service's id and the password, and carry their expiry. No storage is needed, every isolate accepts what another
  issued, and it runs on Workers and Node alike (Web Crypto only). Cloudflare's `workers-oauth-provider`, named to
  Björn first, was not used: it needs a KV namespace (eventually consistent, up to a minute, for rotating refresh
  tokens), wraps the whole Worker and fixes its routes when the Worker loads, which fits neither a secret path read at
  request time nor the several-service handler. The price of statelessness: a code can be redeemed more than once in
  its two minutes (PKCE still binds it to the client that asked), and a replaced refresh token stays valid until it
  expires. Revocation is the password or the signing secret.
- **Rules**: a password of at least 16 characters and a signing secret of 32-256 characters (generated at random),
  both secrets of the deployment; otherwise the service is off (404, one warning without a value). Redirect addresses
  are HTTPS, or HTTP to this machine for a command-line client; never a redirect to an address the client did not
  register, and a broken request to log in is shown on our own page, never sent to the client's address (registration
  is open, so a registered address is not a trusted one). Registration is open to anyone, so the login page names the
  host the code goes to, and a deployment can list the only hosts a client may be sent to (`redirectHosts`, e.g.
  claude.ai and localhost); a loopback address matches on any port (RFC 8252). The login page forbids framing, sends no
  referrer and is not cached; the password is compared in constant time and never shown or logged. No rate limit on
  the page (stateless): the password's length carries that.
- **The profile**: the SKOS profile offers the change tools only with `offerChanges: true`, which a host sets only
  for a service behind a login; a vocabulary's write access alone no longer offers them.
- **Reviewed**: mcp-reviewer, 2026-11-22: no blocker; a phishing path (a stranger registers their own address and
  sends the person a link to the genuine page) and missing tests, fixed with the host shown on the page, the
  deployment's redirect hosts and the tests; an open redirect for broken requests, two limits that contradicted each
  other, an unset login still listed, loopback ports and an optional `redirect_uri` at the token endpoint, all fixed
  with a test each that fails without the fix.
- **Not yet**: the host's write service (its login page text in `en`/`sv`, the secrets, the writable test
  vocabulary) waits for the write API on vocab.hagstrom.nu; a live check that claude.ai and Claude Code register,
  log in and refresh as expected.

## 2026-11-23: The change tools speak the write API's agreed format

- **Why**: tematres-test's plan for the write API (`docs/skriv-api-plan.md` there, sections 2.1-2.8 and 14) set the
  format, with our answers to its questions recorded in the handoff log of 2026-11-23. The provisional format of
  2026-11-22 is replaced, in `src/adapters/tematres/write.ts` and in the tools' schema; nothing else changes.
- **Request**: `POST <vocabulary>/write.php`, `{ action: "dryRun", vocabulary: <base URI>, reason, source, operations }`
  (flat, not under `batch`) and `{ action: "apply", batchId }`. The tools take the plan's operation fields as they are:
  a concept by `conceptId` (a number) or `conceptRef` (a concept the batch creates), a target likewise
  (`targetId`/`targetRef`), a place in a note by `heading` and one of `paragraph`, `listItemContaining`,
  `paragraphContaining`; `replaceNoteText` (words inside a paragraph, links kept), `addNote` with `sections` or
  `paragraphs`, `moveConcept` with `expectedBroaderId`, `setStatus` with `expectedStatus`, and per operation
  `reason`, `source`, `field` (`comment` on a new concept). Exactly one of each pair is checked before any request;
  a label with `<`, `>` or `"` is refused here as the service would. Texts are plain text, never HTML.
- **Dry run, fail-closed**: `ok: true` and `applicable` are required; `applicable` must be true exactly when there is
  no conflict, and only then is there a batch id (with conflicts the answer has none, and ours neither). Every
  operation still has to be accounted for. A new concept has no id until written; it is shown by its `conceptRef`.
  The service's warning codes are shown with our text (`linkRemoved`), an unknown one by its code.
- **Apply**: a 2xx with `applied: true` (and not `ok: false`) is a write, reported with the time, the backup, the changed concepts and the
  new concepts' ids (`created`). A 4xx with a known code, and a 503 with `transactionsUnavailable`, `dumpFailed` or
  `notInstalled` (refused before the transaction, the plan says), mean nothing was written: not marked, refused with our
  text, the conflict's place (`index`) and the wait the service asks for (`Retry-After`) passed on. Anything else,
  `serverError` and `outcomeUnknown` included, may have written: read fresh, "may or may not have been written".
  `serverError` is counted so on purpose: the plan says nothing was written, but the MCP cannot tell a rollback from a
  lost one, and the cost of the caution is one read back. `batchUsed` ("already written or used up", the plan says)
  is refused as nothing written now, but the vocabulary is read fresh after it and the hint says to read back and
  never to apply the batch again, since it may have been written earlier.
- **Fields from the service** are read as strictly as the request: a new concept's `conceptRef` by the request's
  pattern, `expiresAt` and `appliedAt` as ISO 8601 times (a malformed `expiresAt` makes the dry run unreadable, a
  malformed `appliedAt` is left out of a confirmed write).
- **Key**: exactly 64 hex characters, the API's form; anything else is no key and is never sent.
- **Reviewed**: mcp-reviewer, 2026-11-23: no blocker; seven of ten operation kinds and four groups of hints untested,
  and the too-large JSON answer's conflicts no longer asserted: tests added (every kind sent and compared field by
  field). The `batchUsed` hint claimed a write; "nothing written" accepted for any 5xx with the three codes (now 503
  only); `conceptRef` and `appliedAt` read loosely; a comment and two model-facing texts out of date: all fixed, each
  with a test that fails without it. The reviewer could not read the plan (outside the repository); its open points
  were checked against the plan by hand.
- **Not used**: the API's `info` action. The tools are offered by the deployment's configuration (and a login); a key
  without the right gets 403 `forbidden`, shown as such.


## 2026-11-24: The write test service, and a batch's status

- **Why**: tematres-test put the write API on the test instance (`https://vocab.hagstrom.nu/skrivprov/write.php`, a
  copy of Svada) with a key for this server, and added the `status` action we asked for (their plan, 2.5b).
- **Service**: `skrivprov` in host-services, private (secret path `SERVICES_SKRIVPROV_PATH`) and behind the core login
  (`SKRIVPROV_LOGIN_PASSWORD`, `SKRIVPROV_LOGIN_SIGNING_SECRET`; clients sent back only to claude.ai, localhost and
  127.0.0.1), with its own engine (`SKRIVPROV_*`, allowed host vocab.hagstrom.nu only). The only service that offers
  the change tools, for one vocabulary, `skrivprov`, read live (no snapshot) with the key `SKRIVPROV_WRITE_KEY`.
  Without the path, the password or the signing secret it is off (404); without the key it reads only.
- **Status**: a third change tool, `vocab_change_status`, asks `{ action: "status", batchId }` what became of a batch:
  `proposed` (not written so far), `applied` (with the apply's result; the vocabulary is then read fresh, as after an
  apply), `expired`, `stale`, `failed` (not written). Read fail-closed: `ok: true`, the same batch id and a known status
  are required. Only a refusal about the key or the id (401, 403, 404) is passed on; anything else (a server error, a
  limit, a code meant for apply, no answer) is "did not say what became of the batch", never "nothing was written". The
  hints after an unknown outcome or a used batch now send the model to this tool instead of reading back.
- **`serverError` at apply, changed from 2026-11-23**: a 500 with `serverError` now counts as nothing written by that
  request, not marked. The caution of 2026-11-23 rested on the MCP not being able to tell a rollback from a lost one;
  the plan (2.6, and tematres-test's log of 2026-11-24) now separates them: every failure after a commit has begun is
  `outcomeUnknown`, and `serverError` is given only before it, with the transaction rolled back. The batch may be
  `failed` or still `proposed` afterwards, which the status tool tells; the hint says to ask it first. A `serverError`
  on any other 5xx, `outcomeUnknown` and any other 5xx still count as possibly written.
- **Fields shown**: a backup's name and a log id are shown only in a safe form (file-name and id characters), in JSON as
  in Markdown.
- **Tried live**, from Björn's computer through a real MCP client and the real engine (not deployed), 2026-11-24:
  reading concept 18; a dry run of `replaceNoteText` on it (before, after, change note, an id); a dry run with a wrong
  `expected` (`staleText`, no id); status `proposed` for the first and `unknownBatch` for an invented id; with Björn's
  ok, that batch applied (backup, log entry, concept 18 changed, the change note written by the service), status
  `applied`, a second apply refused as `batchUsed`, and the concept read back with the new text. The three status
  answers are recorded as fixtures (`tests/fixtures/write/`).
- **Reviewed**: mcp-reviewer, 2026-11-24: no blocker. A status `applied` promised live reads without marking them; the
  `serverError` hint also given after a dry run; a rate-limited or busy status call answered "nothing was written";
  four new behaviours and the login page's language untested; status answers only in shapes the test wrote; this entry
  and the test table missing; two misleading `wrangler.toml` comments and three stale ones; a backup name or log id
  passed into JSON unchecked. All fixed; each new behaviour has a test, and eight mutations were each caught.
- **Not yet**: the deployment (with Björn's ok), a live check of
  login and refresh from claude.ai and Claude Code, smoke cases for the change tools, and the frozen surface of the
  three tools (after the first trial batches, while their text may still change).
