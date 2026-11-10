# ondata_extended (working name)

A modular MCP server platform in TypeScript: a backend-agnostic **core** with pluggable **profiles**.

- `packages/core`: the engine. Hardened HTTP client (SSRF guards, DNS pinning, per-hop redirect checks, size caps,
  timeouts), cache, rate limit, output shaping that always yields parseable JSON, untrusted-content handling,
  stdio / Streamable HTTP / Cloudflare Workers hosts. Extracted from
  [ondata/ckan-mcp-server](https://github.com/ondata/ckan-mcp-server) (MIT); see `NOTICE.md`.
- `packages/profile-contract`: the types between core and profiles.
- `packages/profile-skos`: a general SKOS vocabulary profile (`vocab_*` tools) with backend adapters; TemaTres first.
- `packages/host-vocab`: the vocabulary deployment (stdio binary `vocab-mcp-server`, Node HTTP, Cloudflare Worker).
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

Version: `0.1.0` for every package (`docs/DECISIONS.md`).

Status: a working prototype, published for review by the maintainer of ondata's MCP servers; pre-release, no
packages published, no stability promise for the profile contract yet (0.x; the plan to 1.0 is
`docs/contract-stability.md`). Not affiliated with or endorsed by the
onData association. All credit for the security hardening and the ported servers goes to their authors (`NOTICE.md`).

Written with AI assistance (Claude, Anthropic) under the direction and review of Björn Hagström; the claims about
behaviour in `docs/test-parity.md` and the issue draft name the command that checks them.

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

Test deployment (Cloudflare Workers, `docs/DECISIONS.md`): `npx wrangler login` once, then `npm run deploy:ckan` and
`npm run deploy:vocab`. wrangler sends no usage telemetry (`send_metrics = false`). `npm run deploy:parliament`
exists but has not been run (deploying needs Björn's ok).

Read first: `docs/DECISIONS.md`, `docs/test-parity.md`, `docs/tematres-api-derisking.md`.
