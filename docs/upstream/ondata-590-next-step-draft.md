<!--
DRAFT comment, not posted. Target: ondata/ckan-mcp-server#590 (the discussion issue; #591 is merged).
Purpose: ask, softly, whether Andrea wants step 2 of path B, based on his own notes on #591; easy to decline.
Sources: his #591 review ("Two notes for the next steps, not blocking"; note 2: "when the module gets its own
consumers"), his merge comment ("looking forward to the next steps of path B"), his #590 answer ("it may give you a
part you can reuse", "listing the costs next to the benefits"). Revised after mcp-reviewer and an independent fable
read (2026-11-12). Post only with Björn's ok. Post with lines unwrapped (GitHub renders each newline as a line break).
-->

Thanks for the review and the merge of #591. Your two notes there describe what a next step would be, so here is
how I would do it, in case you want it. If you would rather stop here, that is completely fine.

**Step 2 (your first note): make `safe-http.ts` free of CKAN.**

- What it gives: `safe-http.ts` usable on its own, without the CKAN settings, which is the reusable part you
  mentioned. What it costs here: `http.ts` gets a small settings object and thin wrappers.
- `safe-http.ts` gets its settings from `http.ts` instead of reading `process.env` itself: allowed domains, private
  hosts, the allow-all flag, the two size caps, and the wording of the messages that name them (one warning also
  says "CKAN hosts").
- **No export changes:** `utils/http.js` keeps the same names and signatures, so no importer and no test changes;
  only `safe-http.ts`'s own signatures change. The `CKAN_*` variables, defaults and messages stay exactly as they
  are.
- The settings are read when a guard runs, as today, not once at load: the tests set `CKAN_PRIVATE_HOSTS` and
  `CKAN_ALLOWED_DOMAINS` per test, and the safe agents are built once and check private hosts at lookup time. So
  getters or per-call settings, not a snapshot.
- `npm test`, `npm run smoke` (smoke file untouched), `npm run build` and `npm run build:worker` green. The CKAN
  and `sparql_query` mentions in comments move to `http.ts` or become generic.

**Your second note (the SSRF tests):** you tied it to the module getting its own consumers, which step 2 alone does
not give it, so it can wait. When it comes, the tests would be split rather than moved: the ones about the guards
themselves go next to `safe-http.ts`; the ones about the `CKAN_*` settings and `makeCkanRequest` stay. Keeping all
of them on `utils/http.js` during step 2 is also what shows step 2 changes nothing.

Step 2 changes a few function signatures, so it is a real change to review rather than a pure move like #591, but I
would keep it to that one purpose. If you have a preference for how the settings are passed in, tell me.

AI assistance: prepared with Claude (Anthropic) under my direction and review.
