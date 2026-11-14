# The vocabulary service (production)

The SKOS profile with the TemaTres adapter, run as a service: a Cloudflare Worker for Björn and invited users.
Decided 2026-11-14 (`docs/DECISIONS.md`). The test Worker (`ondata-extended-vocab`) stays as it is, for trying
changes before they reach the service.

## What it offers

- **Endpoint:** `https://<service host>/mcp` (Streamable HTTP). `/` is a landing page (English, Swedish with
  `?lang=sv`), `/health` a JSON status. The host is not announced; it is shared with invited users.
- **Tools (frozen):** `vocab_search_concepts`, `vocab_get_concept`, `vocab_broader`, `vocab_narrower`,
  `vocab_related`, `vocab_top_concepts`, `vocab_suggest`, `vocab_scheme_info`. All read-only. Their names,
  arguments, types, ranges, defaults and annotation hints (read-only, idempotent and so on) are fixed by `packages/profile-skos/tests/frozen-tools.test.ts`;
  titles and descriptions may still be improved.
- **Vocabularies:** only those approved for the service, listed in `KNOWN_VOCABULARIES`
  (`packages/profile-skos/src/vocabularies.ts`) and allowed in `VOCAB_ALLOWED_DOMAINS` (`[env.production.vars]` in
  `packages/host-vocab/wrangler.toml`). Today: `svada`, `https://begrepp.hagstrom.nu/`. A tool call naming any
  other host is refused before a request is sent.

## Connecting

- **Claude (claude.ai, Claude Desktop):** Settings, Connectors, Add custom connector, URL
  `https://<service host>/mcp`. No sign-in.
- **Claude Code:** `claude mcp add --transport http vocab https://<service host>/mcp`.
- **Other MCP clients:** any client that speaks Streamable HTTP, with the same URL.
- **Locally, without the service:** `npm run build`, then `node packages/host-vocab/dist/index.js` (stdio) with
  `VOCAB_ALLOWED_DOMAINS=begrepp.hagstrom.nu`.

## Limits

- Requests to a vocabulary server: at most 5 per second per host, bursts of 10, then a wait of up to 5 s and a
  refusal (the core's rate limit, per Worker isolate). This protects the TemaTres servers, not the Worker.
- Answers are cached; responses are capped in size, and a large JSON answer is shortened with a note rather than
  cut mid-value.
- No access control: anyone with the URL can call it. What it serves is public vocabulary content, and the
  allowlist and rate limit bound what a caller can make it do. If the URL is misused, redeploy under another host.

## Operating it

Every deploy needs Björn's ok, each time.

1. **Before a deploy:** `npm run check` and `npm run smoke:vocab` green; the change tried on the test Worker
   (`npm run deploy:vocab`) when it touches the vocabulary path; reviewed as `review/CHECKLIST.md` requires.
2. **Deploy:** `npm run deploy:vocab:production` (builds `dist/worker.js`, deploys `[env.production]` as the Worker
   `vocab-mcp`).
3. **Check it:** `SMOKE_URL=https://<service host>/mcp node scripts/smoke-vocab.mjs` (the known answers, through the
   deployed Worker); `curl https://<service host>/health` gives `status: ok` and the version; the landing page shows
   the service status line, not "test service".
4. **Roll back:** `npx wrangler rollback -c packages/host-vocab/wrangler.toml --env production` (the previous
   version; `npx wrangler deployments list ... --env production` lists them).
5. **Logs:** `npx wrangler tail -c packages/host-vocab/wrangler.toml --env production`, or Workers Observability in
   the Cloudflare dashboard. A log line per tool call holds the tool, its arguments `vocab`, `query`, `prefix`,
   `id`, `limit` and `response_format` (the profile's `telemetryFields`), the status with a short error summary,
   the duration, whether the cache answered and, for `vocab_get_concept`, the concept id; never a secret. The search text users type is logged, so tell
   invited users so.

## Adding a vocabulary

1. An entry in `KNOWN_VOCABULARIES` (id, base URL, adapter, default language, title, concept URI base as the
   instance's SKOS export writes it).
2. Its host in `VOCAB_ALLOWED_DOMAINS` of `[env.production.vars]` (comma-separated) and, to try it first, of the
   test Worker's `[vars]`.
3. Recorded fixtures and a smoke case with known answers (`packages/profile-skos/tests/fixtures`,
   `packages/host-vocab/tests/smoke`), so a change in that instance shows up as a failing smoke case.
4. Deploy as above.

## Changing a tool

A change to a tool's name, arguments or annotations fails `frozen-tools.test.ts`. It needs a decision in
`docs/DECISIONS.md`, migration help for the invited users, and then
`VOCAB_FREEZE_UPDATE=1 npx vitest run packages/profile-skos/tests/frozen-tools.test.ts`. Adding a new tool also
updates the frozen file; that is a decision too, but not a breaking one.
