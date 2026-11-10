# ondata_extended: instructions for agents

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
- `review/CHECKLIST.md`: what a review checks; use it when you are asked to review (findings in its format, report
  only, change nothing). `docs/DECISIONS.md`: decisions. `docs/test-parity.md`: the test rule, the ondata baseline
  and the deviation list.

## Rules

- **Nothing leaves the machine without Björn's explicit ok**, each time: push, npm publish, deploy, an issue, PR,
  comment or security report to ondata or anyone else.
- **Review order**: review (`mcp-reviewer` in Claude Code, or you with `review/CHECKLIST.md`) -> fix -> proof
  (`npm run check`, parity, smoke as needed) -> Björn's ok. Reviews are logged in `review/REVIEWS.md`. A reviewer gets
  the commit, the diff and what the change should achieve, not why it is right. Do not read `review/seeds/`.
- **Commits**: `type: description` (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`), English, subject under 72
  characters, no final period, ending with a `Co-Authored-By:` trailer for the AI model. AI assistance is also
  disclosed in every PR text and upstream text.
- **Build rules** (architecture proposal, section 9), in brief: core names no backend (`npm run check:boundaries`);
  profiles import core and the contract, never each other; profiles own all model-facing text; CKAN backward
  compatibility is hard (tool names, arguments, JSON shape, `CKAN_*` env aliases, bin, `/`, `/health`, `/mcp`,
  telemetry fields; deviations in the deviation list with migration help); profile API is `0.x` until two profiles
  run in production; all outbound traffic via the core HTTP client, upstream content untrusted, no echoed error
  bodies; secrets only via core config; fixtures, contract tests and smoke cases per profile; Workers compatibility
  (`npm run check:worker-bundle`); ondata's norms for anything upstream; decisions in `docs/DECISIONS.md`.
