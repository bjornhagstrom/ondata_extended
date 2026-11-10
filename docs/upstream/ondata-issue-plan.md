# Plan: the proposal issue to ondata

Status: draft, local. Nothing is posted without Björn's explicit ok (CLAUDE.md). The issue text is
`docs/upstream/ondata-issue-draft.md`.

## Purpose

Ask Andrea Borruso (aborruso), the maintainer of ondata/ckan-mcp-server and ondata/italianparliament-mcp, whether he
wants a shared, hardened core for his two TypeScript MCP servers, and in what form. The issue asks a question; it
proposes no code change in his repository by itself. ondata's CONTRIBUTING asks for an issue (or an OpenSpec
proposal) before architecture changes and for work that is wanted first; this is that step.

## Audience and angle

- **One reader first: Andrea.** The family is in practice one person (pre-study, section 1, point 4). The pitch is
  realistic only if it reduces his work, so every section answers "what does this cost or save the maintainer".
- **ondata second**: users of the hosted Worker and the npm package must see that nothing changes for them.
- **English**, plain, no marketing. Claims are either reproducible (command, portal, output) or marked as ours.
- **AI assistance disclosed** in the issue body (CONTRIBUTING, "AI-Assisted Contributions"; our rule).

## Where

ondata/ckan-mcp-server: the core's origin, the larger user base, and the repo with CONTRIBUTING and OpenSpec.
Mention italianparliament-mcp inside it and offer to open a pointer issue there if he wants one. Do not open both.

## Preconditions before posting (Björn decides each)

1. **The repository must be readable by him.** The draft cites tests, a parity harness and a deployment. CONTRIBUTING
   says to claim only what a reviewer can verify. Options: publish `ondata_extended` (public GitHub repo, MIT, with
   NOTICE.md crediting ondata), or give him read access to a private repo. Without one of these the issue must drop
   every "you can run" claim. Check before publishing: no secrets, `review/` and `.claude/` stay excluded, licences
   and headers are complete, `review/seeds/` is never published.
2. **The test deployment stays up** while the issue is open (`ondata-extended-ckan` on workers.dev), or the
   live-comparison claim is reworded as a dated observation.
3. **mcp-reviewer** reviews the issue text and the published repo state (CLAUDE.md: before anything leaves the
   machine). Fix, then Björn's ok.
4. **Numbers refreshed on the day**: test counts, parity case counts, ondata's current version (0.4.139 when drafted),
   live comparison rerun (`node scripts/compare-live-ckan.mjs`), smoke against the deployment
   (`SMOKE_URL=... node scripts/smoke-ckan.mjs`).
5. **Decide what we offer** (the issue says it plainly): co-maintenance of the core, for how long, and what happens if
   either side stops (MIT, forkable, a port list for security fixes). The draft offers co-maintenance; Björn confirms
   or removes it.

## Structure of the issue (as drafted)

1. Summary and the question asked (yes/no and which path).
2. Who is asking, and disclosure.
3. What exists: core, contract, three profiles, three hosts (two deployed as test instances: CKAN and vocabulary).
4. What it gives ondata and the maintainer (the main section).
5. What it costs the maintainer (as plainly as section 4).
6. Architecture sketch: layers, a tool call's path, the contract in brief.
7. Principles we build by.
8. Evidence that CKAN behaves the same (parity, smoke, Worker parity, live comparison, the deviation list).
9. Parliament: what a port looks like, what moved into the core, what differs.
10. Paths (A/B/C), with a suggested first small step.
11. What we do not propose.
12. Open questions for him.

## After posting

- Answer within a day; keep follow-ups short.
- If he says no or not now: accept it, keep the core as our own package with ondata credited, and keep a port list of
  his security fixes (architecture proposal, path A).
- If yes: write the OpenSpec proposal he prefers, then the first PR is the smallest behaviour-neutral step (split
  `http.ts` into a backend-free part and a CKAN part, no export changes), with `npm test` and `npm run smoke` green.
- Log the issue, his answer and our decision in `docs/DECISIONS.md`.

## Open items found while drafting

- The parliament section reflects rounds 1-4 (2026-11-10: six tools, the host). Refresh it from
  `docs/parliament-port.md` if more is built before posting.
- `bill-text` (Node-only, starts a browser) is not built; the issue describes capability gating as designed, not as
  shown, unless Björn approves building it first.
- Upstream backlog items (ondata's `tsc` running out of memory; a prompt naming `ckan_resource_show`) are separate,
  small, single-purpose contributions; mention them in the issue only as examples of what the port found, not as
  part of the proposal.
