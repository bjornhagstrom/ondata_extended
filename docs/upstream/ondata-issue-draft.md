<!--
DRAFT, not posted. Target: ondata/ckan-mcp-server, addressed to @aborruso. Nothing is posted without Björn's ok.
Before posting: see docs/upstream/ondata-issue-plan.md (preconditions: a readable repo, numbers refreshed, review).
Placeholders: <REPO_URL>, <TEST_COUNT>, <PARLIAMENT_*> (fill from docs/parliament-port.md after the parliament rounds).
-->

# Proposal: one hardened core for ckan-mcp-server and italianparliament-mcp (no change for users)

Hi Andrea,

This is a question before any code: **would a shared core for your two TypeScript MCP servers be useful to you, and
if so, in which form?** I have built and tested one outside your repositories so that the question can be answered
with something to look at instead of a sketch. Nothing below requires a change in ckan-mcp-server unless you want
one, and "no, thanks" is a fine answer.

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
- **What it would give you.** Security fixes written once for both servers; italianparliament-mcp gets the size
  caps, timeouts and redirect checks it does not have today on every request; one Worker/stdio/HTTP host instead of
  two; shared SPARQL helpers; a codebase that typechecks under `strict` in seconds.
- **What it would cost you.** A boundary (the profile contract) that you would no longer change as freely as internal
  functions, a dependency between your two servers, and review time. Section "What it costs" is as long as the
  section on benefits on purpose.
- **What I ask.** Your view on whether this is wanted, and which of the paths at the end you would consider. If the
  answer is yes, the first step is a small, behaviour-neutral PR, after an OpenSpec proposal if you prefer that.

## Who is asking, and how this was made

I am Björn Hagström (bjornhagstrom; #576 and #587 here). I need an MCP server for a SKOS vocabulary service in
Sweden, and ckan-mcp-server's hardening is the best base I found: nothing comparable exists as a reusable package
for data services. Rather than copy your security code and let it drift, I would prefer one core that both of us
use.

**AI assistance:** the code, the tests and this text were written with an AI assistant (Claude), under my direction
and review, with an independent automated review before each step. Every claim below names the command that checks
it, so you do not have to trust either of us. The work lives in <REPO_URL> (MIT; ondata's copyright and licence
are kept, and every ported file names its source file and commit).

## What exists

| Part | What | Size |
|---|---|---|
| `packages/core` | Backend-free engine: HTTP client with guards, cache, rate limits, output (truncation, tables, field rendering), SPARQL helpers, MCP registration, stdio/HTTP/Worker hosting | ~2 400 lines |
| `packages/profile-contract` | The types a profile implements (`Profile`, `ToolSpec`, `EngineContext`, ...) | ~330 lines |
| `packages/profile-ckan` | ckan-mcp-server's tools, resources, prompts and texts, ported file by file | ~6 800 lines |
| `packages/host-ckan` | The `ckan-mcp-server` binary and the Worker, as yours | small |
| `packages/profile-skos` | SKOS vocabularies, TemaTres as first adapter (our need) | ~1 000 lines |
| `packages/profile-parliament` | italianparliament-mcp's <PARLIAMENT_TOOLS>, ported file by file | <PARLIAMENT_LINES> |

<TEST_COUNT> tests (`npm run check`: typecheck, boundary check, Worker bundle check, all tests; a local script, there
is no CI yet). A test deployment
of the CKAN profile runs on Cloudflare Workers, labelled as a test instance in its headers and footer.

## What it gives ondata and you

**Security fixes once.** ckan-mcp-server has fixed at least five advisories in its HTTP layer (GHSA-8hxx, -6f9w,
-q5gv, -279h, -w3gp). In the core that code exists once. italianparliament-mcp's hosts are fixed, so its exposure
is smaller, but its amendment and Akoma Ntoso tools fetch HTML and XML directly with `fetch`, outside its client:
no size cap, no timeout, and redirects followed without checks. On the core every request gets them, with no code
of its own.

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
your `Tool` objects with `execute(input, ctx)`, which a CLI calls exactly as yours does; the MCP side registers your
`makeHandler`. The core also offers row-returning tools and `runRowsTool` for a CLI, for servers written new.

**One host for both servers.** stdio, Streamable HTTP and the Worker entry (with `/`, `/health`, CORS, telemetry per
tool call) are core code with per-deployment settings. A fix to the Worker host reaches both servers.

**Shared modules.** SPARQL helpers (`validateSelectQuery`, `injectLimit`, `sparqlStringLiteral`, `flattenBindings`;
the parliament versions, which are the stricter ones), table output, field rendering for CKAN scheming, the
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

## What it costs you

- **A boundary you would not change as freely.** Today you refactor internals at will (the probe move in
  #534-#536). With a core, the profile contract is an interface. We propose no stability promise (0.x) until two
  profiles run in production, but it is still one more thing to think about in a change.
- **Two packages instead of one**, or one repository with a `core` folder whose only CKAN user is CKAN. Releases of
  the core and of each server would need to stay in step.
- **More combinations to test**: core × profile × transport. Each profile keeps its own smoke cases.
- **Review time**, for the extraction PRs, if you choose that path.
- **A dependency between your two servers.** A bug in the core affects both.
- **Bus factor.** Your family of projects is mostly you; ours is mostly me. A shared core with two single owners is
  not automatically sturdier. We offer to co-maintain the core (security ports, reviews, releases) and to write down
  what happens if either of us stops: the core stays MIT and forkable.

If these outweigh the benefits for you, that is a complete answer.

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
4. **Backward compatibility for CKAN users is a hard requirement**: tool names, arguments, JSON shape, `CKAN_*`
   variables, binary, endpoints, telemetry fields. Your smoke file, unchanged and green, is the definition of
   behaviour-neutral. Any deviation is listed with its reason and migration.
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
| Parity harness | Your server at `09e8cdc` loaded in-process and our profile, both given the same recorded portal answers; tool lists, resource templates and prompts compared entry by entry; 121 cases (tool calls, resource reads, prompts) compared output by output; your Node (axios) path replayed as well | All equal, except D8 (SDK version text), checked exactly |
| Your test suite | Every test file ported except the DataStore table UI (not registered in your server); expectations unchanged, reach adapted (fake fetch instead of axios mocks) | Green |
| Your smoke cases | `tests/smoke/cases.json` copied unchanged, run against our binary and against our deployed Worker | 18/18 and 18/18 |
| Worker parity | Your `src/worker.ts` and ours given the same HTTP requests: status, headers, body, log line, Analytics data point | Equal except the version (D13) |
| Live comparison | The same 21 requests to your public Worker (0.4.139) and ours, sent at the same moment | 20 identical; the 21st is D5 below |

Commands: `npm run check`, `npm run smoke:ckan`, `SMOKE_URL=<worker>/mcp node scripts/smoke-ckan.mjs`,
`node scripts/compare-live-ckan.mjs`.

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
names (no prefix) and examples unchanged: <PARLIAMENT_TOOLS_LIST>.

- **Your tests:** <PARLIAMENT_PORTED_TESTS> of your unit tests ported with unchanged expectations; the ones that
  call the live endpoints read recorded answers instead.
- **Parity:** your server loaded in-process and the profile given the same recorded answers:
  <PARLIAMENT_PARITY>. The request on the wire is the same (URL, `Accept`, `User-Agent`).
- **Recordings, not live calls, for Senato.** Camera answers recorded live once, slowly; Senato answers synthetic
  and marked so, and the recorder refuses any senato.it request. This is what your #117 asks for.
- **Differences** (all listed): the SDK's newer validation text (as for CKAN); the Senato throttle also spaces
  retries; the core's guards apply (size cap, at most 5 checked redirects instead of 20, a timeout that covers the
  body), and a guard refusal is not retried; a log line uses `console.error`; your request counter is not kept.
- **Not built:** `bill-text`, which starts a browser and external programs. A core needs a way to say "this tool
  exists only where the host can run it" (Node, not Workers); the design is clear, the code is not written.

Six small contract additions came from italianparliament-mcp, each optional for other profiles: tool names without
a prefix (your 43 names are a user contract), per-host throttle and retry, row output with the notice after the
rows, examples in descriptions, the SPARQL helpers in the core, and row-level results for the CLI.

## Paths

**A. Nothing changes in your repositories.** We keep the core as our own package, crediting ondata, and port your
security fixes to it. Cost to you: none. Cost overall: two copies of the security code that drift over time.

**B. Extraction in small, behaviour-neutral steps inside ckan-mcp-server.** Each PR readable in minutes, each with
`npm test` and `npm run smoke` green and the smoke file untouched:
1. split `src/utils/http.ts` into a backend-free part and a CKAN part, no export changes;
2. make cache TTLs and truncation keys parameters, with today's values as defaults;
3. move hint texts out of the HTTP layer;
4. introduce the profile type and register CKAN through it, no names changed.
italianparliament-mcp could then depend on the core folder or package when you choose, not before.

**C. A separate core package owned by ondata** (`@ondata/mcp-engine` or similar), with ckan-mcp-server and
italianparliament-mcp as consumers. Only if you want it, and only with us sharing the maintenance.

My suggestion is A now, B if you want it, C only if you ask for it.

## What we do not propose

- No renamed tools, arguments, variables, endpoints or binaries; no change to the hosted Worker's address.
- Nothing for the Python servers (istat_mcp_server, opensdmx): a shared TypeScript core cannot reach them. What could
  be shared there is conventions (instance registry format, hint and untrusted-text rules), not code.
- No large PR. If path B, the first PR is the `http.ts` split alone.
- No SDK v2 migration as part of this.

## Questions for you

1. Is a shared core something you want at all, for ckan-mcp-server, italianparliament-mcp, both or neither?
2. If yes: path B inside ckan-mcp-server, path C as a separate package, or something else?
3. Would you prefer an OpenSpec proposal before the first PR?
4. Is italianparliament-mcp a candidate, given its CLI and the Node-only `bill-text`?
5. Anything in the deviation list you would not accept?
6. For italianparliament-mcp: should the core's retry and table output gain the options your server needs (retry an
   unparsable 200; rows in their own key order, text only, no cap), so your retry loop and formatting can go, or do
   you prefer to keep them in your code?

Thanks for ckan-mcp-server. Its hardening is the reason this exists.

Björn

---
*AI assistance disclosed: written with Claude (Anthropic) under my direction; code and claims reviewed by me and by
an automated reviewer. All checks above are reproducible from <REPO_URL>.*
