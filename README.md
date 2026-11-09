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

Version: `0.1.0` for every package (`docs/DECISIONS.md`).

Status: private, local, pre-release. Not affiliated with the onData association.

## Develop

```sh
npm install
npm run check        # typecheck, boundaries, Workers bundle, tests
npm run build        # packages/host-{vocab,ckan}/dist/{index,worker}.js
npm run smoke:vocab  # known answers against the live test vocabulary
npm run smoke:ckan   # ondata's known answers against live CKAN portals (builds first)
```

Run locally: `node packages/host-vocab/dist/index.js` or `node packages/host-ckan/dist/index.js` (stdio), or with
`TRANSPORT=http` and an allowlist (`VOCAB_ALLOWED_DOMAINS=begrepp.hagstrom.nu`, `CKAN_ALLOWED_DOMAINS=...`) for
`http://127.0.0.1:3000/mcp`.

Test deployment (Cloudflare Workers, `docs/DECISIONS.md`): `npx wrangler login` once, then `npm run deploy:ckan` and
`npm run deploy:vocab`. wrangler sends no usage telemetry (`send_metrics = false`).

Read first: `docs/DECISIONS.md`, `docs/test-parity.md`, `docs/tematres-api-derisking.md`.
