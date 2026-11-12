<!--
OPENED 2026-11-12 as https://github.com/ondata/ckan-mcp-server/pull/596 (commit a569f6e, lines unwrapped, no Claude Code line).
Was: DRAFT PR. Target: ondata/ckan-mcp-server, branch test/private-hosts-agent-lookup from the fork
bjornhagstrom/ckan-mcp-server. Local clone: ~/Developer/ondata-ckan-pr, on main c58817f.
The two optional items from Andrea's #594 review (5875531397). Nothing is pushed or opened without Björn's ok.
Title: test: check that CKAN_PRIVATE_HOSTS reaches the safe agents' lookup
Post with lines unwrapped.
-->

The two optional items from your review of #594.

- **The test:** a request through the axios safe agents to `localhost`, which, unlike an IP literal, goes through their DNS lookup. With `CKAN_PRIVATE_HOSTS=localhost` it reaches a local listener. After the list is changed, the same agents refuse it, so the list is read at lookup time and not when the agents are built.
- **The nit:** the redundant `const raw = privateHosts;` in `isPrivateHostAllowed` is gone. No behaviour change.

**How to check.**

- `npm test`: 739 passed, 6 skipped (738 on `main`, plus this test).
- The test fails if `http.ts` builds the agents without the list (`createSafeAgents(() => '')`): "Access to private/internal IP addresses is not allowed ("localhost" resolves to 127.0.0.1)".
- `npm run build` and `npm run build:worker` succeed.

**AI assistance:** prepared with Claude (Anthropic) under my direction and review, with automated reviews before opening.
