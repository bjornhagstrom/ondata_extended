# Testing and review: how this project applies the best practices

The general rules are in `/Users/bjornhagstrom/Developer/best_practices_testning_och_granskning/` (Swedish). This
file is the project's application of them: answers to the questions in `00-fragor-per-projekt.md`, the project type,
what is in place and what is open. Project-specific names, rules and numbers belong here, not there. Created
2026-11-09; answers marked **open** are not decided yet.

Related files: `review/CHECKLIST.md` (what a review looks at), `review/REVIEWS.md` (review log),
`docs/test-parity.md` (test rule, baseline, ported tests, deviation list), `docs/DECISIONS.md` (decisions).

## Answers to the questions in 00

1. **Whose code?** Both kinds, kept apart.
   - *Own service* (`typer/egen-tjanst.md`): this repository, a derivative of ondata/ckan-mcp-server (MIT) with a
     backend-agnostic core and profiles. We build it and, later, may host it.
   - *Upstream contribution* (`typer/bidrag-uppstroms.md`): anything sent to ondata (issues, PRs, security reports,
     for example the private-host finding D1 in `docs/test-parity.md`). Those follow ondata's `CONTRIBUTING.md` and
     the upstream type file: small, single-purpose, wanted, English, `type: description`, AI assistance disclosed,
     claims reproducible, our own review material never included.
2. **What leaves the machine, and who says yes?** Push to any remote, npm publish, a hosted deployment (Workers or
   other), an issue, PR, comment or private security report to ondata or TemaTres, any message on Björn's behalf.
   Every one needs Björn's explicit ok, each time. Today there is no remote, no publishing and no hosting
   (`docs/DECISIONS.md`).
3. **What is "done"?** For a change: `npm run check` green (typecheck, boundaries, Workers bundle check, tests), the
   test rule in `docs/test-parity.md` met (no weakened expectation without a deviation entry, baseline not
   undercut), `mcp-reviewer` run with its findings handled and logged in `review/REVIEWS.md`. For a CKAN-profile
   change additionally the black-box parity check against ondata at `09e8cdc` (**open**: not built yet). Björn
   decides when something is done enough to leave the machine.
4. **Hard rules set by the owner.** English everywhere; GUI text via `en`/`sv` language files; AI assistance
   disclosed (commit trailer, PR text) here and upstream; nothing leaves the machine without Björn's ok; the build
   rules of the architecture proposal (core names no backend, profiles never import each other, profiles own
   model-facing text, CKAN backward compatibility is hard, all outbound traffic via core, secrets only via core
   config, Workers compatibility); the test rule in `docs/test-parity.md`; MIT and attribution to the onData
   association kept. These are items 1-9 of `review/CHECKLIST.md`; the hook and `scripts/check-boundaries.mjs`
   enforce what can be enforced mechanically.
5. **Which reviewers?** Code is written mostly by Claude (Opus). `mcp-reviewer` runs on `fable` (Björn's
   decision, 2026-11-09), a different model from the author; because it is still the same vendor, anything that leaves the machine also gets a reader from
   another vendor (Codex, with the same checklist) and, where it matters, the strongest available model for the
   reviewer. Björn is the human reviewer and decides. **Open:** which model writes most of the code from here on,
   and whether the reviewer should default to a stronger model than the author.
6. **How is what was tested identified?** Branch + commit + base (`git rev-parse`) in every review row and every
   test report; for the CKAN parity check, also ondata commit `09e8cdc`. **Open:** a version number visible in
   `/health` and the landing page once a hosted variant exists (egen-tjanst asks for it).
7. **Do browser sessions need pre-approvals (Step 0)?** Not now: there is no web UI beyond a landing page and no
   browser testing planned. **Open** if a hosted landing page with language switching is built.
8. **Is the environment shared?** Local only. Ports used by `wrangler dev` and the local Node HTTP host are shared
   with other projects on this machine (**open**: fix the ports and write them down). The live smoke target for
   SKOS, begrepp.hagstrom.nu, is Björn's own instance and read-only; live CKAN portals are third parties, so live
   smoke runs nightly and before release only, never in a loop (`docs/DECISIONS.md`).
9. **What does the recipient accept?** In this repository: everything. Upstream ondata: small, single-purpose,
   disclosed, wanted PRs (issue or OpenSpec first for architecture), no unrelated diffs, no `portals.json` changes
   outside portal issues, no large generated refactors. TemaTres upstream: not planned from this repository.
10. **What does a run cost, and how often?** `npm run check`: seconds to minutes, on every change. Reviewer: tokens
    and minutes per run, on every non-small change and before anything leaves the machine. Live smoke: third-party
    load, nightly and before release. Reviewer trial: when prompt, checklist, hook or model changes.
11. **Who changes the code?** Claude sessions under Björn's direction; possibly several sessions in parallel (as
    today: one builds packages, one sets up review). Rule: one session per area at a time; the reviewer never
    changes code; a review is done on a commit in its own worktree, never in a directory another session works in.
12. **Where are the agent instructions?** `CLAUDE.md` (Claude Code) and `AGENTS.md` (Codex and others) at the
    repository root; both point to the best-practice directory, this file, `review/CHECKLIST.md` and
    `docs/DECISIONS.md`.

## Checklist 06, status

Core (day 1):

- [x] Questions in 00 answered (this file), 2026-11-09.
- [x] Pointer in `CLAUDE.md` and `AGENTS.md`, 2026-11-09.
- [x] Definition of done (question 3 above).
- [x] Fast run: `npm run check` (typecheck, boundaries, Workers bundle check, tests).
- [ ] Full run with a summary of what is red: **open** (live smoke, parity check, coverage).
- [ ] Shared test helper and output format: **open**; Vitest output is the format for now.
- [x] Identification of what was tested: branch + commit + base (question 6).
- [ ] Pinned dependencies and a test that fails on `latest`: **open** (`package-lock.json` exists; no test yet).
- [ ] Reset script for test data: not applicable now (no stateful test data); decide when a hosted variant exists.

Before the first public version (none planned yet):

- [x] Code review agent, checklist, read-only hook with its own test (`review/hook-test/`), 2026-11-09.
- [ ] Reviewer trial (six faults, one decoy): designed in `review/seeds/` (untracked), **not run**; needs a base
  commit with the SKOS profile files the seeds build on.
- [ ] Mutation trial on the security rules (each SSRF guard, cap and sanitizer can be made to fail a test): **open**.
- [ ] Leak check of the hosted surface (landing page, `/health`, errors, telemetry): **open**, when hosting is
  decided.
- [ ] Load and endurance on the public read paths, locally: **open**, when hosting is decided.
- Browser tests (scripted and AI-driven): not applicable now; decide if a landing page with language files ships.

Upstream contributions: before each one, the upstream type file applies in full (same check before and after on the
base, minimal diff in ondata's style, only effects on their main branch, security issues privately first).

## Test inventory and baseline

The test rule, the ondata baseline (697 `it`/`test` blocks at `09e8cdc`, counted with `grep -cE`; coverage thresholds
in ondata's `vitest.config.ts`: lines 80, functions 80, branches 75, statements 80), the ported and new tests and
the deviation list are kept in `docs/test-parity.md`. **Open:** a coverage threshold in this repository's
`vitest.config.ts` at least equal to ondata's; a measured coverage figure for ondata at `09e8cdc` to compare with
(the thresholds are the floor ondata enforces, not its measured coverage).

Classification S/B/R/T (02) of the tests: **open**.

## Project-specific cases and flaky patterns

None yet. Add each with cause and fix.

## Open questions

- Reviewer model: decided 2026-11-09, `fable`. Codex as the second reader for what leaves the machine: confirm.
- Black-box parity check: how it is built (two MCP clients against ondata at `09e8cdc` and the CKAN profile, same
  fixture responses) and where its output is stored.
- Version number in `/health` and the landing page.
- Fixed local ports for `wrangler dev` and the Node HTTP host.
- Whether `.claude/` (agent, hook, settings) and `review/` are committed (proposed: yes, except `review/seeds/`,
  which is untracked so the answer key never reaches a worktree).
