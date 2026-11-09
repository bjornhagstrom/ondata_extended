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
- **Row-level tool results: yes** (Björn's decision), so a profile can serve both MCP and a CLI. Next step.
