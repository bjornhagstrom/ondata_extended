# ondata_extended

A modular MCP server platform in TypeScript: a backend-agnostic core engine (`packages/core`) extracted from
ondata's MIT-licensed ckan-mcp-server (commit `09e8cdc`), a profile contract (`packages/profile-contract`) and
pluggable profiles: SKOS vocabularies (`packages/profile-skos`, tools `vocab_*`, TemaTres as first adapter, its
specifics in an `ext` object) and later CKAN (`packages/profile-ckan`), which must behave exactly like ondata's server.
Published for review (public repository); everything in English (GUI text via `en`/`sv` language files).

Note for readers of the public repository: `review/` (review checklist, review log) and the general testing guide
named below are the maintainer's local material and are not published; `docs/DECISIONS.md` records why.

## Read first

- Testing and review rules: `/Users/bjornhagstrom/Developer/best_practices_testning_och_granskning/` (general) and
  `docs/testing-application.md` (how this project applies them). They apply to all testing and review here.
- `review/CHECKLIST.md`: what a review checks. `docs/DECISIONS.md`: decisions. `docs/test-parity.md`: the test rule,
  the ondata baseline and the deviation list.

## Rules

- **Nothing leaves the machine without Björn's explicit ok**, each time: push, npm publish, deploy, an issue, PR,
  comment or security report to ondata or anyone else.
- **Review order**: `mcp-reviewer` -> fix -> proof (`npm run check`, parity, smoke as needed) -> Björn's ok. Start
  `mcp-reviewer` yourself, without asking, before a commit that is not small and before anything leaves the machine
  (when: `review/CHECKLIST.md`). Give it the commit, the diff command and what the change should achieve, not why it
  is right. Log every review in `review/REVIEWS.md`. Do not read `review/seeds/`.
- **Commits**: `type: description` (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`), English, subject under 72
  characters, no final period, ending with a `Co-Authored-By:` trailer for the AI model. AI assistance is also
  disclosed in every PR text and upstream text.
- **Build rules** (architecture proposal, section 9):
  1. Core names no backend (no "ckan", "skos", "tematres", "solr" or portal names in `packages/core`); checked by
     `npm run check:boundaries`, no temporary exceptions.
  2. Profiles import core and the contract, never each other; shared helpers go into core.
  3. Profiles own all model-facing text; core only generic errors and security warnings.
  4. CKAN backward compatibility is a hard requirement: tool names, arguments, JSON shape, `CKAN_*` env names (as
     aliases), bin, `/`, `/health`, `/mcp`, telemetry fields. Deviations go in the deviation list with migration help.
  5. No stability promise for the profile API (`0.x`) until two profiles run in production.
  6. All outbound traffic via the core HTTP client; upstream content is untrusted (`sanitizeInline`,
     `wrapUntrusted`); no echoing of error bodies.
  7. Config namespaced per profile; secrets only via core config, never in logs, errors or telemetry.
  8. Per profile: fixtures for every tool, contract tests against a fake `ctx.http`, a smoke file with known answers,
     a before/after check for every change to a tool's output.
  9. Workers compatibility for core and profiles: no Node built-ins in the bundle except via the dynamic-import
     technique (`npm run check:worker-bundle`).
  10. ondata's norms for anything going upstream (`CONTRIBUTING.md`): small, single-purpose, wanted, disclosed.
  11. Record decisions in `docs/DECISIONS.md`.
