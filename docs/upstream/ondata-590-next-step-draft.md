<!--
DRAFT comment, not posted. Target: ondata/ckan-mcp-server#590 (the discussion issue; #591 is merged).
Purpose: ask, softly, whether Andrea wants step 2 of path B, based on his own notes on #591; easy to decline.
Quote source: his merge comment on #591 ("Much appreciated, and looking forward to the next steps of path B.").
Post only with Björn's ok. Post with lines unwrapped (GitHub renders each newline as a line break).
-->

Thanks for the review and the merge of #591, and for the two notes. You wrote that you were "looking forward to
the next steps of path B", so here is what I would suggest next. Please say no if you would rather leave it where
it is: that is a perfectly good place to stop.

**Step 2 (your first note): make `safe-http.ts` free of CKAN.**

- `safe-http.ts` gets its settings from `http.ts` instead of reading `process.env` itself: allowed domains,
  private hosts, the allow-all flag, the two size caps, and the wording of the messages that name them (one
  warning also says "CKAN hosts").
- `http.ts` supplies the CKAN values, so the `CKAN_*` variables, the defaults, when each one is read, and every
  message stay exactly as they are. Nothing changes for users or deployments, including Workers; `npm test` and
  `npm run smoke` stay green, smoke file untouched.
- The CKAN and `sparql_query` mentions in comments move to `http.ts` or become generic.

**Step 2b (your second note): move the SSRF tests** that test the guards themselves next to `safe-http.ts`,
importing it directly; the tests that go through `makeCkanRequest` stay where they are. I would do this after
step 2, so the moved tests are written once against the new settings; done first, they would need changing again.

If you want either, tell me, and whether you have a preference for how the settings are passed in. Step 2 changes
a few function signatures, so it is a real change to review rather than a pure move like #591, but I will keep it
to that one purpose. And if not now, no problem at all.

AI assistance: prepared with Claude (Anthropic) under my direction and review.
