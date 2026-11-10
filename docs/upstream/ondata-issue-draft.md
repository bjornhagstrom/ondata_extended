<!--
POSTED 2026-11-10 as https://github.com/ondata/ckan-mcp-server/issues/590 (this file is the text as posted).
Before posting: see docs/upstream/ondata-issue-plan.md (preconditions: a readable repo, numbers refreshed, review).
Numbers refreshed 2026-11-10 (tests, smoke, live comparison, bundle sizes).
-->

# Proposal: one hardened core for ckan-mcp-server and italianparliament-mcp (behaviour unchanged for users of both, as far as possible)

Hi Andrea,

This is a question before any code: **would a shared core for your two TypeScript MCP servers be useful to you, and
if so, in which form?** I have built and tested one outside your repositories so that the question can be answered
with something to look at instead of a sketch. It is a working prototype, not a finished service (section "How
finished this is"). Nothing below requires a change in your repositories unless you want one, and "no, thanks" is a
fine answer.

## Summary

- **What it is.** The parts of ckan-mcp-server that have nothing to do with CKAN (SSRF guards, size caps,
  decompression limits, timeouts, cache, rate limits, truncation that always yields parseable JSON, sanitising of
  upstream text, stdio/HTTP/Worker hosting, telemetry plumbing) extracted into a backend-free core, with a small
  contract that a "profile" implements: its tools, texts, resources, prompts and host policies.
- **What runs on it today.** A CKAN profile that is a port of ckan-mcp-server at `09e8cdc` (0.4.138), a SKOS
  vocabulary profile, and a port of part of italianparliament-mcp (`fd46810`, 0.38.0).
- **The CKAN profile behaves like your server.** Same 20 tools, 7 resource templates, 6 prompts, arguments, Markdown
  and JSON output, `CKAN_*` variables, binary name, `/`, `/health`, `/mcp`, log line and Analytics data point. This is
  checked by replaying recorded portal answers through your server and ours and comparing the outputs, by your smoke
  cases (unchanged) and by a side-by-side run against your public Worker. Thirteen known differences are listed
  below, each with its reason; most are invisible to users.
- **The parliament port aims for the same.** Its six tools give your server's output for the same recorded answers;
  the differences that could not be avoided are listed (P1-P13), most of them timing, error text or added guards.
- **What it would give you.** Security fixes written once for both servers; every request italianparliament-mcp
  makes gets the core's size caps, timeouts and redirect checks; one Worker/stdio/HTTP host instead of
  two; shared SPARQL helpers; a codebase that typechecks under `strict` in seconds; and a ready place for the next
  MCP server you write, which then starts as a profile instead of a copy.
- **What it would cost you.** A boundary (the profile contract) that you would no longer change as freely as internal
  functions, a dependency between your two servers, and review time. Section "What it costs" is as long as the
  section on benefits on purpose.
- **What I ask.** Your view on whether this is wanted, and which of the paths at the end you would consider. My
  preference is that ondata takes the core in as its own, and that the new version runs side by side with today's
  servers until you are satisfied with it. You choose the form: an OpenSpec proposal first or not, one PR or many.

## Who is asking, and how this was made

I am Björn Hagström (bjornhagstrom; #576 and #587 here). I need an MCP server for a SKOS vocabulary service in
Sweden, and ckan-mcp-server's hardening is the best base I found: nothing comparable exists as a reusable package
for data services. Rather than copy your security code and let it drift, I would prefer one core that both of us
use.

**AI assistance:** the code, the tests and this text were written with an AI assistant (Claude), under my direction
and review, with an independent automated review before each step. The claims about behaviour below name the command that
checks them, so you do not have to trust either of us. The work lives in
https://github.com/bjornhagstrom/ondata_extended (MIT; ondata's copyright and licence are kept, and every ported
file names its source file and commit).

## What exists

| Part | What | Size |
|---|---|---|
| `packages/core` | Backend-free engine: HTTP client with guards, cache, rate limits, output (truncation, tables, field rendering), SPARQL helpers, MCP registration, stdio/HTTP/Worker hosting | ~2 400 lines |
| `packages/profile-contract` | The types a profile implements (`Profile`, `ToolSpec`, `EngineContext`, ...) | ~330 lines |
| `packages/profile-ckan` | ckan-mcp-server's tools, resources, prompts and texts, ported file by file | ~6 800 lines |
| `packages/host-ckan` | The `ckan-mcp-server` binary and the Worker, as yours | small |
| `packages/profile-skos` | SKOS vocabularies, TemaTres as first adapter (our need) | ~1 000 lines |
| `packages/profile-parliament` | six of italianparliament-mcp's tools, ported file by file | ~3 000 lines |
| `packages/host-parliament` | The `italianparliament-mcp` binary (stdio) and the Worker, as yours; built and tested, not deployed | small |
| `packages/profile-example`, `host-example` | The worked example of `docs/writing-a-profile.md`: two tools, tests, a Worker; not deployed | ~350 lines |

1 803 tests, 2 skipped (`npm run check`: typecheck, boundary check, Worker bundle check, all tests; a local script, there
is no CI yet). A test deployment
of the CKAN profile runs on Cloudflare Workers, labelled as a test instance in its headers and footer.

## What it gives ondata and you

**Security fixes once.** ckan-mcp-server has published at least eight advisories in its HTTP layer (SSRF, size and
redirect checks: GHSA-3xm7, -g84h, -798p, -vmrr, -38f8, -q5gv, -x32r, -279h; `SECURITY.md`). In the core that code exists once. italianparliament-mcp talks to fixed hosts, so its exposure
is smaller, and it has its own SPARQL client; requests made outside a shared client do not get the same guards by
default. On the core every request, whatever tool makes it, gets the size cap, the timeout and checked redirects,
with no code of its own. (If you want details for italianparliament-mcp, I will send them privately.)

**Less code that is yours alone, honestly measured.** In the parliament port the per-host throttle and the
timeouts became declarations:

```ts
hostPolicies: {
  "dati.senato.it": { minIntervalMs: 2000, timeoutMs: 60000 },
  "dati.camera.it": { timeoutMs: 60000 }
}
```

Two things did *not* move, because exact parity with your output came first: your retry loop (it retries
everything except a 4xx other than 429, including an unparsable 200; the core's retry rule is narrower), and your
row formatting (each row in its own key order, no character cap, no `structuredContent`; the core's table output
differs on all three). The core has both features; whether they should gain the options your server needs, or your
code should keep its own, is one of the questions below. The saving today is the HTTP layer, the host, the guards
and the shared helpers, not your tools' formatting.

**Your CLI pattern is kept.** italianparliament-mcp's rule "CLI e MCP sempre allineati" holds: the ported tools keep
your `Tool` objects, with one extra argument: `execute(input, ctx)`, where `ctx` is the engine context a CLI creates
once. The MCP side registers your `makeHandler`. Your CLI itself (`src/cli.ts`) is not ported. The core also offers
row-returning tools and `runRowsTool` for a CLI, for servers written new.

**Mostly one host for both servers.** stdio, Streamable HTTP and the Worker entry (`/`, `/health`, `POST /mcp`, CORS,
telemetry per tool call) are core code with per-deployment settings, and both deployments here use them. Where your
two servers differ (italianparliament-mcp's preflight and plain 404s, its SSE answers), the parliament Worker has a
small router in front and the core an option; a core fix to those routes would not reach it.

**Shared modules.** SPARQL helpers (`validateSelectQuery`, `injectLimit`, `sparqlStringLiteral`, `flattenBindings`;
the parliament versions, which are the stricter ones; the CKAN port keeps its own `sparql_query` code for exact
parity), table output, field rendering for CKAN scheming, the
untrusted-text wrappers.

**Typechecked.** Your CONTRIBUTING notes that `build:tsc` routinely exhausts the heap and that nothing runs it. On
my machine `tsc --noEmit` at `09e8cdc` ran out of memory before reporting anything, also with an 8 GB heap. The core
and all profiles typecheck under `strict` in a few seconds. The port found a handful of places where optional
fields are read as required; none changes behaviour today.

**Recorded tests for the parliament endpoints.** Senato blocks an IP after a burst, and your issue #117 asks for
recorded SPARQL answers replayed offline. The parliament profile's tests run on recorded Camera answers and
synthetic Senato answers, with no live call to Senato.

**A second and third user of your code.** The vocabulary profile shows that what you built holds outside CKAN.
That is an argument you can use too.

**Room for the servers you have not written yet.** This is a guess about your plans, so correct me: you have built
many command-line tools for Italian public data sources this year (IPA, OpenBDAP, ANAC, AGENAS, the MIMIT price
observatory, among others), and some of them may one day want an MCP server; the Sicilian regional assembly plugin
already ships one. Today each new TypeScript server starts by copying the HTTP hardening, the hosting and the tests
from an existing one. With a core, a new server is a profile: its tools, queries and texts, with the guards, the
hosts, the Worker deployment, the telemetry and the test pattern already there. The SKOS profile was written that
way, and `docs/writing-a-profile.md` walks through a small example profile with its tests and Worker: two tools over
the Senate's Akoma Ntoso files on GitHub, the source your `amendments` tool uses. If more servers are likely, this
may be the largest benefit; if not, the others still hold.

## What it costs you

- **A boundary you would not change as freely.** Today you refactor internals at will (the probe move in
  #534 and #536). With a core, the profile contract is an interface. We propose no stability promise (0.x) until two
  profiles run in production, but it is still one more thing to think about in a change. There is a written plan
  for getting it to a stable, documented 1.0 (`docs/contract-stability.md`).
- **Two packages instead of one**, or one repository with a `core` folder that only CKAN uses at first. Releases of
  the core and of each server would need to stay in step.
- **More combinations to test**: core × profile × transport. Each profile keeps its own smoke cases.
- **Review time**, for the extraction PRs, if you choose that path.
- **A dependency between your two servers.** A bug in the core affects both.
- **Bus factor.** Your family of projects is mostly you; ours is mostly me. A shared core with two single owners is
  not automatically sturdier. What I can promise: I do the work to bring the core and the ported servers to a state
  where your services run stably on it (porting the remaining tools, the side-by-side run, security fixes, reviews,
  documentation), and I write down how it is maintained after that. I cannot promise to co-maintain it indefinitely,
  and I would rather say so now. The core is MIT and written to be maintained by one person: decisions recorded,
  checks automated, no part that only I understand.

If these outweigh the benefits for you, that is a complete answer.

## How finished this is

A working, tested prototype; not a finished service. Rough status, by part:

| Part | Status | What is left |
|---|---|---|
| Core | Covers everything the profiles use; security guards, hosts and telemetry tested | Capability gating for Node-only tools (designed, not written); the retry and table options for your parliament output (question 6); CI; published packages; a stable contract (1.0) |
| CKAN profile and host | Complete: all 20 tools, resources and prompts, equal to yours in every check below | Following your releases (0.4.139 changed only the version string in `src` since `09e8cdc`); a production deployment |
| Parliament profile and host | 6 of 43 tools (about 14 %), chosen as the hardest; host and Worker built and tested, not deployed | 37 tools (mostly mechanical, following the same pattern); `bill-text` (needs the gating above); your CLI; a deployment next to yours (your Worker already queries Senato's SPARQL endpoint from Cloudflare; the Akoma Ntoso files come from GitHub) |
| SKOS profile | Works against one TemaTres instance; our own need | Not part of this proposal |

In effort: the CKAN side is close to done, the parliament side about a seventh of the way, the core most of the way,
with the gaps above named. I would rather you judge from the repository than from these words.

## Architecture

```
 MCP clients (Claude, IDEs, CLI)                            upstream services
        |                                                 (CKAN portals, SPARQL
        v                                                  endpoints, TemaTres...)
 +--------------------------- host ---------------------------+        ^
 |  stdio | Streamable HTTP (Node) | Cloudflare Worker          |        |
 |  /  /health  /mcp, CORS, per-call telemetry, notices        |        |
 +-------------------------------------------------------------+        |
        |  registerProfiles(server, [profiles], engine)                 |
        v                                                               |
 +--------------------------- core ---------------------------+        |
 |  MCP registration: tools, resources, prompts, schemas       |        |
 |  engine context per call:                                   |        |
 |    ctx.http   one client, every request:  ------------------+--------+
 |               SSRF guards (DNS + per redirect hop), size    |
 |               caps, decompression caps, timeouts, host      |
 |               policies (throttle, retry), honest-UA retry   |
 |    ctx.cache  TTL cache (memory / Workers cache)            |
 |    ctx.output truncation (valid JSON), tables, fields,      |
 |               untrusted-text wrapping                       |
 |    ctx.config namespaced settings (CKAN_*, VOCAB_*, ...)    |
 |    ctx.telemetry per-call fields the profile allows         |
 |  shared modules: SPARQL helpers, field rendering            |
 |  names no backend (checked by a script)                     |
 +-------------------------------------------------------------+
        ^                 ^                    ^
        | implements      | implements         | implements
 +--------------+  +----------------+  +-------------------+
 | profile-ckan |  | profile-       |  | profile-skos      |
 | 20 tools,    |  | parliament     |  | vocab_* tools,    |
 | ckan_ prefix,|  | no prefix,     |  | TemaTres adapter  |
 | 7 resources, |  | your output,   |  |                   |
 | 6 prompts    |  | host policies  |  |                   |
 +--------------+  +----------------+  +-------------------+
   profiles import the core and the contract, never each other
```

**A tool call.** The host receives `tools/call`; the core validates the arguments against the tool's zod schema
(strict where your schemas are strict) and calls the profile's handler with a context. The profile builds its
request (CKAN: `/api/3/action/...`, its error envelope and hints; parliament: a SPARQL query) and sends it through
`ctx.http`, which applies the guards and the host's policy. The profile formats the answer, wraps upstream text as
untrusted, and returns a result (or rows that the core formats and truncates). The host adds the telemetry the
profile allows.

**The contract in brief.** A `Profile` has a name, an optional tool prefix, tools, resources, prompts, host
policies, the fields it allows in telemetry, its untrusted-source label, and its texts. A `ToolSpec` has a zod input
schema, annotations, examples, and either a `handler` (a finished MCP result) or `rows` (data the host formats).
The profile owns every text the model sees; the core owns only generic errors and security warnings.

## Principles we build by

1. **The core names no backend.** No "ckan", "skos", "tematres", "solr" or portal names in the core; a script in
   `npm run check` enforces it, no temporary exceptions.
2. **Profiles import the core and the contract, never each other.** Shared helpers go into the core.
3. **The profile owns all model-facing text**: tool descriptions, hints, prompts, URI schemes.
4. **Backward compatibility for your users is a hard requirement**: tool names, arguments, output shape, `CKAN_*`
   variables, binaries, endpoints, telemetry fields; for CKAN and for italianparliament-mcp. Your smoke file,
   unchanged and green, is the definition of behaviour-neutral for CKAN; for parliament, your tests and the parity
   cases. Any deviation is listed with its reason and migration.
5. **No stability promise for the profile API** (0.x) until two profiles run in production.
6. **Security rules are core rules**: all outbound traffic through the core client; upstream content is untrusted;
   error bodies are never echoed.
7. **Configuration namespaced per profile**; secrets only via core config, never in logs, errors or telemetry.
8. **Tests per profile**: fixtures for every tool, contract tests against a fake `ctx.http`, a smoke file with known
   answers, and a before/after check for every change to a tool's output. When porting, the code may change but
   **what a test expects is never weakened**; a changed expectation is a listed deviation.
9. **Workers compatibility for core and profiles**: no Node built-ins in the bundle (checked by building it, in
   `npm run check`).
10. **Your norms for anything upstream**: English, `type: description` commits, small single-purpose PRs that are
    wanted first, AI assistance disclosed, claims a reviewer can reproduce.
11. **Decisions written down** (`docs/DECISIONS.md`), so the core survives a change of maintainer.

## Evidence that CKAN behaves the same

| Check | What it does | Result |
|---|---|---|
| Parity harness | Your server at `09e8cdc` loaded in-process and our profile, both given the same recorded portal answers; tool lists, resource templates and prompts compared entry by entry; 121 cases (tool calls, resource reads, prompts) compared output by output (119 run from the repository; the other two use a 23 MB third-party portal registry kept local, re-recorded on demand); your Node (axios) path replayed as well | All equal, except D8 (SDK version text), checked exactly |
| Your test suite | Every test file ported except the DataStore table UI (not registered in your server); expectations unchanged, reach adapted (fake fetch instead of axios mocks) | Green |
| Your smoke cases | `tests/smoke/cases.json` copied unchanged, run against our binary (2026-11-09) and against our deployed Worker (2026-11-10) | 18/18 and 18/18. Rerun on the Workers 2026-11-10, later: 17/18 on ours and on yours alike; the MQA case fails on both because data.europa.eu answered HTTP 500 |
| Worker parity | Your `src/worker.ts` and ours given the same HTTP requests: status, headers, body, log line, Analytics data point | Equal except the version (D13) |
| Live comparison | The same 21 requests to your public Worker (0.4.139) and our test Worker, sent at the same moment (our observation, 2026-11-10; the test Worker's address on request) | 20 identical; the 21st is D5 below |

Commands: `npm run check`, `npm run smoke:ckan`, `SMOKE_URL=<worker>/mcp node scripts/smoke-ckan.mjs`,
`node scripts/compare-live-ckan.mjs <ours>/mcp` (any deployment of the CKAN host against yours).

<details>
<summary>The 13 listed deviations</summary>

| # | Difference | Visible to users? |
|---|---|---|
| D1 | The private-host exemption applies only to requests that ask for it | No |
| D2 | One fetch-based path on Node and Workers; bodies streamed and stopped at the cap (same 32 MiB) | No |
| D3 | A startup message says "hosts" instead of "CKAN hosts" | Wording |
| D4 | Redirect hops check the private-host exemption on every path | No |
| D5 | DNS check on every first hop; an unknown host reads `Server not found: <url>` (your Worker: Cloudflare's HTTP 530 text) | Error text |
| D6 | One default redirect limit; the CKAN profile passes your values | No |
| D7 | A top-level array in `structuredContent` is wrapped (MCP requires an object); no caller does this today | No |
| D8 | Argument validation errors use the newer SDK's text (1.32.2 vs 1.27.1) | Error text |
| D9 | Node request headers are those of your fetch path (your Worker's) | No |
| D10 | Undeclared gzip is unpacked on Workers too | Fewer errors |
| D11 | MQA, SPARQL and the portal registry get the size cap and first-hop DNS check | No, unless an answer exceeds 32 MiB |
| D12 | The Worker log's `cache_hit` belongs to the current call, never a previous one | Telemetry accuracy |
| D13 | Version is ours; Worker notices are deployment settings (yours by default) | Version field |

</details>

## Parliament: what a port looks like

Ported from italianparliament-mcp at `fd46810` (0.38.0), file by file, with your Italian texts, queries, tool
names (no prefix) and examples unchanged: `legislatures`, `deputies` (with birthplace parsing and filters),
`search` (with ranking), `sparql`, `bill-progress` (both chambers, the navetta, the law lookup) and
`camera-amendments` (HTML from camera.it, parsed with `cheerio/slim`). Six of 43 tools, chosen to cover the hard
cases: both endpoints, the Senato throttle, the cross-chamber logic, and a tool that fetches and parses HTML. The
rest would be mechanical.

- **Your tests:** 152 of your tests ported into the profile with unchanged expectations (plus 10 into the core,
  where two expected message substrings were translated with the core's English text); the ones that call the live endpoints read
  recorded answers instead. Where a Senato answer had to be synthetic, the test checks the code path, not Senato's
  data, and says so.
- **Parity:** your server loaded in-process and the profile given the same recorded answers:
  133 cases, all equal (11 differ only in the SDK's validation text, 1 in the line-break folding below). The
  request on the wire is the same (URL, `Accept`, `Accept-Language`, `User-Agent`).
- **Recordings, not live calls, for Senato.** Camera answers recorded live once, slowly; Senato answers synthetic
  and marked so, and the recorder refuses any senato.it request. This is what your #117 asks for.
- **Differences in the tools** (all listed, P1-P8): the SDK's newer validation text (as for CKAN); the Senato throttle also
  spaces retries; the core's guards apply to SPARQL and HTML requests (size cap, at most 5 checked redirects
  instead of 20, a timeout that covers the body), and a guard refusal is not retried; line breaks in endpoint values quoted in `bill-progress`'s plain-text notes are folded into a space
  (upstream text outside JSON escaping); a log line uses `console.error`; your request counter is not kept;
  `withSenatoLaw`, exported for tests, needs its lookup passed in.
- **The host** (binary and Worker, P9-P13): same routes, bodies and headers as your `src/worker.ts` for the requests
  tested, except the version (ours), the tool count (6), two SSE headers from the newer SDK, a generic `Internal
  error` instead of the exception's message, and one you would want to know about: the core's upstream rate limit
  (5 requests/s per host, burst 10) is on by default on every deployment of the core, also this one, where your
  server has only the Senato throttle. It can be turned off with one setting.
- **Commands:** `npx vitest run packages/profile-parliament/tests/parity` (needs your repository at fd46810 with its
  dependencies, `PARLIAMENT_REPO=...`), `npx vitest run packages/host-parliament`.
- **Bundle:** the parliament Worker is 622 KiB minified, and a probe bundling all four profiles 779 KiB, of which cheerio and its parser about
  200 KiB.
- **Not built:** `bill-text`, which starts a browser and external programs. A core needs a way to say "this tool
  exists only where the host can run it" (Node, not Workers); the design is clear, the code is not written.

Six small contract additions came from italianparliament-mcp, each optional for other profiles: tool names without
a prefix (your 43 names are a user contract), per-host throttle and retry, row output with the notice after the
rows, examples in descriptions, the SPARQL helpers in the core, and row-level results for the CLI.

## Running side by side

Nothing has to be switched over in one go. The new version can run next to today's servers, under its own Worker
name and its own npm tag, while users keep the addresses they have:

1. deploy the core-based servers as separate test Workers (as ours is today) and compare them with yours on the same
   requests, as `scripts/compare-live-ckan.mjs` already does for CKAN;
2. let whoever wants to try them do so, with the differences listed;
3. when you are satisfied, point the existing Worker names and the npm packages at the new version, keeping every
   tool name, argument and address;
4. retire the old code when nothing depends on it.

Rolling back at step 3 is redeploying the old version.

## Paths

**A. ondata takes the core in as its own (my preference).** A new repository under ondata (for example
`ondata/mcp-core`, or one repository holding the core and the profiles), owned by you, with ckan-mcp-server and
italianparliament-mcp becoming profiles on it over time. The work moves in as a starting point, history and
attribution kept; the switch-over follows "Running side by side". The PR size is yours to choose: one large PR that
starts the new track, which you read as a whole while today's servers keep running, or the same content in steps.
Profiles that are not ondata's (our SKOS profile) need not live there: with the core published as a package, they
stay in their owners' repositories and depend on it. Whether ondata's repository should also host others' profiles
is your call (question 8).

**B. Extraction in small, behaviour-neutral steps inside ckan-mcp-server.** Each PR readable in minutes, each with
`npm test` and `npm run smoke` green and the smoke file untouched:
1. split `src/utils/http.ts` into a backend-free part and a CKAN part, no export changes;
2. make cache TTLs and truncation keys parameters, with today's values as defaults;
3. move hint texts out of the HTTP layer;
4. introduce the profile type and register CKAN through it, no names changed.
italianparliament-mcp could then depend on the core folder or package when you choose, not before. Slower, but you
never review more than one step at a time.

**C. Nothing changes in your repositories.** Cost to you: none. Honestly, this is the path I would least like: I do
not want to maintain a separate copy of your servers' security code next to yours, and the two copies would drift.
If this is your answer, I would keep only what the vocabulary profile needs and credit ondata for it.

## What we do not propose

- No renamed tools, arguments, variables, endpoints or binaries; no change to the hosted Workers' addresses.
- No switch-over before you are satisfied: the old servers keep running until you decide otherwise.
- Nothing for the Python servers (istat_mcp_server, opensdmx): a shared TypeScript core cannot reach them. What could
  be shared there is conventions (instance registry format, hint and untrusted-text rules), not code.
- No SDK v2 migration as part of this.

## Questions for you

1. Is a shared core something you want at all, for ckan-mcp-server, italianparliament-mcp, both or neither?
2. If yes: path A (a new ondata repository, side by side), path B (small steps inside ckan-mcp-server), or something
   else?
3. One large PR that starts the new track, or small steps? And would you like an OpenSpec change proposal first
   (`openspec/changes/...`, as for other architecture changes here)?
4. Is italianparliament-mcp a candidate, given its CLI and the Node-only `bill-text`?
5. Anything in the deviation lists you would not accept?
6. For italianparliament-mcp: should the core's retry and table output gain the options your server needs (retry an
   unparsable 200; rows in their own key order, text only, no cap), so your retry loop and formatting can go, or do
   you prefer to keep them in your code?
7. Do you expect to write more MCP servers, and if so, which kinds of sources? That decides how much the core
   should prepare for.
8. Should an ondata core repository hold only ondata's profiles, with others (ours included) in their own
   repositories using the published core, or would you host others' profiles too?

Thanks for ckan-mcp-server. Its hardening is the reason this exists.

Björn

---
*AI assistance disclosed: written with Claude (Anthropic) under my direction; code and claims reviewed by me and by
an automated reviewer. The checks above can be rerun from https://github.com/bjornhagstrom/ondata_extended; the two live rows need
a deployment.*
