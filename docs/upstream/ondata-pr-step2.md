<!--
OPENED 2026-11-12 as https://github.com/ondata/ckan-mcp-server/pull/594 (commit cb9464f, lines unwrapped, Claude Code attribution line).
Was: DRAFT PR. Target: ondata/ckan-mcp-server, branch refactor/inject-safe-http-settings from the fork
bjornhagstrom/ckan-mcp-server. Local clone: ~/Developer/ondata-ckan-pr, commit cb9464f on main 205ba4a (amended from 83621d5 after the Codex review).
Agreed on #590 (comment 6820640188): settings passed explicitly per call, no configure(), messages byte-identical,
SSRF tests stay; Andrea stops after this step. Nothing is pushed or opened without Björn's ok.
Title: refactor: pass the CKAN settings to safe-http.ts per call
Post with lines unwrapped.
-->

Step 2 as agreed in #590, and the last one: `safe-http.ts` no longer reads any configuration or names CKAN.

**What changes.**

- `http.ts` reads the `CKAN_*` settings exactly as before (the two size caps once at load, the others on every
  call) and passes them explicitly. There is no module-level configuration in `safe-http.ts`.
  - `validateServerUrl` and `assertRedirectKeepsPrivateExemption` take a `UrlGuardSettings` object: the
    allowlist and the private hosts as the raw comma-separated strings, plus the two setting names that the
    messages show.
  - `safeFetch` takes a function that returns that object. It is called at each redirect hop, which is when the
    settings are read today.
  - `isPrivateHostAllowed` takes the list, and `decodePossiblyCompressed` takes the decompression cap.
  - `createSsrfSafeLookup` keeps the caller's settings object, as today, and takes a `privateHosts` getter. The
    getter is called at each lookup, because the agents are kept for the process and the list is read at lookup
    time today.
- `http.ts` exports thin wrappers under the same names. **Every export of `utils/http.js` is unchanged in name and
  type (20)**, so no importer and no test changes.
- Two functions move verbatim from `safe-http.ts` to `http.ts`: `warnIfPrivateHostsOverHttp` and
  `assertHttpAllowlistConfigured`. They are startup checks that only read `CKAN_*` settings and print CKAN text.
- The process-wide cache of the safe agents moves to `http.ts`. `safe-http.ts` keeps the builder, `createSafeAgents`.
- Comments in `safe-http.ts` that named CKAN or `sparql_query` now say the same thing generically, or the text
  moved to the wrapper in `http.ts`.

One gap I noticed and left alone, since this step changes no tests: no test checks that `CKAN_PRIVATE_HOSTS` reaches
the axios agents' lookup for a listed host name. The existing agent tests start on `127.0.0.1`, where Node skips
the lookup. The gap is the same on `main`, and a regression there would fail closed. A small test for it can come
later if you want one.

**How to check.**

- `git diff main -- src/utils/safe-http.ts | grep -i ckan` shows only removed lines.
- `npm test`: 726 passed, 6 skipped, as on `main`; no test file touched.
- Timing: changing `CKAN_ALLOWED_DOMAINS` while a `safeFetch` redirect is pending, or the settings object of a
  lookup after creating it, gives the same result as on `main`. I checked this with a throwaway script against
  both commits; it is not added as a test.
- `npm run smoke`: 18/18 against the live portals (2026-11-12); `tests/smoke/cases.json` untouched.
- `npm run build` and `npm run build:worker` succeed. The Worker bundle grows by 0.4 KB, the wrappers.
- The exports of `src/utils/http.ts` are identical before and after, in names and types, compared with the
  TypeScript checker. On `src/utils/` and `src/transport/http.ts`, the checker gives the same four errors as on
  `main`.

**AI assistance:** prepared with Claude (Anthropic) under my direction and review, with automated reviews before
opening.
