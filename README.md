# ondata_extended (working name)

A modular MCP server platform in TypeScript: a backend-agnostic **core** with pluggable **profiles**.

- `packages/core`: the engine. Hardened HTTP client (SSRF guards, DNS pinning, per-hop redirect checks, size caps,
  timeouts), cache, rate limit, output shaping that always yields parseable JSON, untrusted-content handling,
  stdio / Streamable HTTP / Cloudflare Workers hosts. Extracted from
  [ondata/ckan-mcp-server](https://github.com/ondata/ckan-mcp-server) (MIT); see `NOTICE.md`.
- `packages/profile-contract`: the types between core and profiles.
- `packages/profile-skos`: a general SKOS vocabulary profile (`vocab_*` tools) with backend adapters; TemaTres first.
- `packages/host-vocab`: the vocabulary deployment (stdio binary `vocab-mcp-server`, Node HTTP, Cloudflare Worker);
  being made a private production service with frozen tools (`docs/vocab-service.md`).
- `packages/profile-ckan`: the CKAN profile, behaving as ondata/ckan-mcp-server 0.4.138 (commit `09e8cdc`): the same
  20 tools, 7 resource templates and 6 prompts, checked case by case against ondata's server (`docs/test-parity.md`).
- `packages/host-ckan`: the CKAN deployment as a drop-in for ondata's server (binary `ckan-mcp-server`, stdio or
  `TRANSPORT=http`, the same `CKAN_*` settings; Cloudflare Worker with ondata's `/`, `/health`, `/mcp`).
- `packages/profile-parliament`: the Italian Parliament profile, behaving as ondata's italianparliament-mcp 0.38.0
  (commit `fd46810`); work in progress, 6 of its 43 tools (`deputies`, `search`, `legislatures`, `bill-progress`,
  `camera-amendments`, `sparql`), checked case by case against the original (`docs/parliament-port.md`).
- `packages/host-parliament`: the parliament deployment as the original's server (stdio binary
  `italianparliament-mcp`; Cloudflare Worker with the original's `/`, `/health`, `/mcp`), core settings under
  `PARLIAMENT_*`. Not deployed.
- `packages/profile-example` and `packages/host-example`: the worked example of `docs/writing-a-profile.md`, two
  `akn_*` tools over the Italian Senate's Akoma Ntoso bulk data on GitHub. Not deployed.
- `packages/profile-ckan-ecosystem` and `packages/host-ckan-ecosystem`: a proof of concept for the CKAN Ecosystem
  Catalog, four `ecosystem_*` tools that search CKAN extensions and the portals running them, from datHere's open
  crawl data and GitHub (`docs/ckan-ecosystem-profile.md`). A test Worker on workers.dev.
- `packages/host-services`: several services in one Cloudflare Worker, each at its own path: the ecosystem service public
  at `/ecosystem/mcp`, a demo of TemaTres vocabularies (on vocabularyserver.com, a lunfardo lexicon at the
  University of Buenos Aires, and the project's own TemaTres test instance) public at `/tematres/mcp`, and the vocabulary service private at a secret path
  (`docs/DECISIONS.md`, 2026-11-15). On workers.dev.

Version: `0.1.0` for every package (`docs/DECISIONS.md`).

Status: a working prototype, published for review by the maintainer of ondata's MCP servers; pre-release, no
packages published, no stability promise for the profile contract yet (0.x; the plan to 1.0 is
`docs/contract-stability.md`). Not affiliated with or endorsed by the onData association. All credit for the
security hardening and the ported servers goes to their authors (`NOTICE.md`).

Outcome of the proposal ([ondata/ckan-mcp-server#590](https://github.com/ondata/ckan-mcp-server/issues/590)):
ondata does not adopt a shared core for now. The maintainer agreed to one small step, splitting the backend-free
HTTP safety out of `src/utils/http.ts` in ckan-mcp-server, merged as
[ondata/ckan-mcp-server#591](https://github.com/ondata/ckan-mcp-server/pull/591) (2026-11-11). The question is to be revisited
when this core runs in production with at least two profiles, or if a third TypeScript server is needed
(`docs/DECISIONS.md`, 2026-11-10).

Written with AI assistance (Claude, Anthropic) under the direction and review of Björn Hagström; the claims about
behaviour in `docs/test-parity.md` and the issue draft name the command that checks them.

## Steering the assistant: server instructions and project instructions

An assistant with a connector switched on still decides for itself whether to use it, and may answer from memory or
search the web instead. Three levels steer it, weakest first:

| Level | Who writes it | Where | Strength and cost |
|---|---|---|---|
| Tool descriptions | the profile | each tool | always present; say what a tool does, and at most a line on when to prefer it |
| Server instructions | the profile, from the deployment's data, plus an optional sentence of the deployment's own | the MCP `instructions` the client receives when it connects | automatic for every user and client; must stay general, and the client decides how much weight they get |
| Project instructions | the user | a Claude project's instructions, a `CLAUDE.md` or an `AGENTS.md` | strongest and most precise, because they know the purpose; each user writes their own |

The vocabulary profile sends server instructions built from its list of vocabularies (`skosInstructions`): use the
tools for these vocabularies' terms instead of memory or a web search, quote definitions as given, say where the
answer comes from. For dependable use in a piece of work, add a project instruction, for example:

> In this project, check every subject term against the UNESCO Thesaurus with the vocabulary connector (vocab_ tools)
> before using it. Use the thesaurus's preferred terms, quote its scope notes when you define a term, and say when a
> term is not in the thesaurus instead of inventing one.

In a single chat, naming the vocabulary in the question ("look it up in the UNESCO Thesaurus …") has the same effect.

## Develop

```sh
npm install
npm run check        # typecheck, boundaries, Workers bundle, tests
npm run build        # packages/host-{vocab,ckan,parliament,example}/dist/{index,worker}.js
npm run smoke:vocab  # known answers against the live test vocabulary
npm run smoke:ckan   # ondata's known answers against live CKAN portals (builds first)
npm run smoke:example # known answers against the Senate's Akoma Ntoso files on GitHub (builds first)
```

Run locally: `node packages/host-vocab/dist/index.js`, `node packages/host-ckan/dist/index.js` or
`node packages/host-parliament/dist/index.js` (stdio; the parliament one has no HTTP mode, as the original), or with
`TRANSPORT=http` and an allowlist (`VOCAB_ALLOWED_DOMAINS=begrepp.hagstrom.nu`, `CKAN_ALLOWED_DOMAINS=...`) for
`http://127.0.0.1:3000/mcp`.

**Against your own TemaTres.** The vocabulary server reads any TemaTres whose web service (`services.php`) is on. Build
(`npm install`, `npm run build`), allow your server's host, and pass your vocabulary's base URL as `vocab` in a call:

```bash
VOCAB_ALLOWED_DOMAINS=vocab.example.org TRANSPORT=http node packages/host-vocab/dist/index.js
# then connect an MCP client to http://127.0.0.1:3000/mcp and ask, e.g. vocab_scheme_info with
# { "vocab": "https://vocab.example.org/myvocab/" }
```

To give your vocabularies ids, a default and a sentence for the assistant, change the list in
`packages/host-vocab/src/vocabularies.ts` (see "Steering the assistant" above).

Test deployment (Cloudflare Workers, `docs/DECISIONS.md`): `npx wrangler login` once, then `npm run deploy:ckan` and
`npm run deploy:vocab`. wrangler sends no usage telemetry (`send_metrics = false`). `npm run deploy:parliament`
exists but has not been run (deploying needs Björn's ok).

Read first: `docs/DECISIONS.md`, `docs/test-parity.md`, `docs/tematres-api-derisking.md`.
