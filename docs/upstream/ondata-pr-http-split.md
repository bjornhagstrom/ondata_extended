<!--
DRAFT PR, not opened. Target: ondata/ckan-mcp-server, branch refactor/split-http-utils from the fork
bjornhagstrom/ckan-mcp-server. Local clone: ~/Developer/ondata-ckan-pr, commit e99adf4. Nothing is pushed or opened
without Björn's ok.
Title: refactor: split backend-free HTTP safety out of utils/http.ts
-->

As agreed in #590: the first step of path B, and only that.

**What changes.** `src/utils/http.ts` is split in two:

- `src/utils/safe-http.ts` (new): the SSRF guards (`validateServerUrl`, `isBlockedIp`, `isPrivateHostAllowed`, the
  redirect check, the DNS checks, `createSsrfSafeLookup`, the safe agents and dispatcher), the response and
  decompression size caps with the decoding they apply, `readBoundedText`, `SsrfGuardError` and `safeFetch`. Nothing
  in it knows the CKAN API (actions, envelope, errors); it still reads the `CKAN_*` settings, and its messages and
  comments name the CKAN and `sparql_query` paths it serves, kept as they are.
- `src/utils/http.ts`: `makeCkanRequest`, `CkanApiError`, `CkanTransportError`, `formatCkanError` and its hints,
  `extractCkanErrorMessage`, the cache-hit flag, the audit log, the User-Agents and the Anubis retry. It re-exports
  the moved public names, so **every import from `utils/http.js` is unchanged** (the same exported names, 19 values and one type).

The moved code is moved verbatim; the only edits in it are `export` on four helpers that `http.ts` now imports
(`readBoundedText`, `MAX_RESPONSE_BYTES`, `decodePossiblyCompressed`, `getSafeAgents`). The `CKAN_*` variable names
in the guards are kept as they are: renaming configuration would be a behaviour change. Two doc pointers follow the
code (`docs/ARCHITECTURE.md`, `CLAUDE.md`).

**How to check.**

- `git show --color-moved=dimmed-zebra HEAD -- src/utils` shows the two blocks as moved, not rewritten.
- `npm test`: 726 passed, 6 skipped, as on `main`.
- `npm run smoke`: 18/18 against the live portals (2026-11-10); `tests/smoke/cases.json` untouched.
- `npm run build` and `npm run build:worker` succeed.

**AI assistance:** prepared with Claude (Anthropic) under my direction and review, with an automated review before
opening.
