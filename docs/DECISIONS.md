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
  with nested shrink paths in the contract if a real vocabulary needs it.

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
