# ondata_extended (working name)

A modular MCP server platform in TypeScript: a backend-agnostic **core** with pluggable **profiles**.

- `packages/core`: the engine. Hardened HTTP client (SSRF guards, DNS pinning, per-hop redirect checks, size caps,
  timeouts), cache, rate limit, output shaping that always yields parseable JSON, untrusted-content handling,
  stdio / Streamable HTTP / Cloudflare Workers hosts. Extracted from
  [ondata/ckan-mcp-server](https://github.com/ondata/ckan-mcp-server) (MIT); see `NOTICE.md`.
- `packages/profile-contract`: the types between core and profiles.
- `packages/profile-skos`: a general SKOS vocabulary profile (`vocab_*` tools) with backend adapters; TemaTres first.
- `packages/host-vocab`: the vocabulary deployment (stdio binary `vocab-mcp-server`, Node HTTP, Cloudflare Worker).
- Planned: `packages/profile-ckan`, behaving identically to ondata's server.

Status: private, local, pre-release. Not affiliated with the onData association.

## Develop

```sh
npm install
npm run check        # typecheck, boundaries, Workers bundle, tests
npm run build        # packages/host-vocab/dist/{index,worker}.js
npm run smoke:vocab  # known answers against the live test vocabulary
```

Run locally: `node packages/host-vocab/dist/index.js` (stdio), or with `TRANSPORT=http
VOCAB_ALLOWED_DOMAINS=begrepp.hagstrom.nu` for `http://127.0.0.1:3000/mcp`.

Read first: `docs/DECISIONS.md`, `docs/test-parity.md`, `docs/tematres-api-derisking.md`.
