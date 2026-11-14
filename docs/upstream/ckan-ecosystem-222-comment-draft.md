<!--
DRAFT comment. Target: ckan/ckanext-pose_ecosystem_catalog#222 ("Add MCP server so AI assistants can search the
Ecosystem Catalog", opened by a5dur of datHere 2026-10-19 after Björn's comment in ckan/ckan discussion #9542).
Purpose: offer a working proof of concept to try, what datHere's usage data adds, what only the catalog has, and
design notes for the issue; no demand. Facts checked 2026-11-14 against the deployed test Worker, the repository and
ThHanke/ckanext-mcp's README. Post only with Björn's ok, after mcp-reviewer. Post with lines unwrapped.
-->

Following up on the discussion in ckan/ckan#9542: I built a small read-only MCP server for searching CKAN extensions, in case it is useful while you evaluate this issue. It is a proof of concept, and you can try it now.

**Try it.** `https://ondata-extended-ckan-ecosystem.ondata-extended.workers.dev/mcp` (Streamable HTTP, no sign-in; it answers MCP clients only, `/health` shows the status). In Claude: Settings, Connectors, Add custom connector, with that URL. In Claude Code: `claude mcp add --transport http ckan-ecosystem https://ondata-extended-ckan-ecosystem.ondata-extended.workers.dev/mcp`. I have tried this endpoint with the MCP TypeScript SDK client and the same server locally in Claude Desktop, not yet as a claude.ai connector. Setup and an example: [docs/ckan-ecosystem-profile.md](https://github.com/bjornhagstrom/ondata_extended/blob/main/docs/ckan-ecosystem-profile.md). Code (MIT): [packages/profile-ckan-ecosystem](https://github.com/bjornhagstrom/ondata_extended/tree/main/packages/profile-ckan-ecosystem).

**What it does.** Four tools: search extensions, show one extension, list the portals running a plugin, and an overview. It never calls ecosystem.ckan.org. Everything comes from what you publish on GitHub in `dathere/pose-ckanext-metadata` (MIT): the list of extensions, the usage counts, the plugin names and the portal data, taken at one commit. To that it adds each repository's GitHub description and topics, and, when you ask about one extension, the opening of its README, read from GitHub at that moment. Your data is what makes the answers useful. Asked for DCAT-AP harvesting that is still worked on, it puts `ckan/ckanext-dcat` (506 portals) first, then `ckanext-dcatapit` (32) and `ckanext-dcatde` (25). Asked about publishers and contact points, the case from ckan/ckan#9542, it finds my `ckanext-actor-registry` and shows how the near matches differ.

**What it cannot do.** It does not have the catalog's own fields: supported CKAN versions, the descriptions entered in the catalog, licence. The data is a snapshot of your weekly crawl (now the week of 2026-11-08), which I refresh by hand. An MCP server on the catalog itself would have all of that.

**Notes for this issue, if they help.**

- For an anonymous endpoint, a small set of read-only tools seems safer and easier for a model than the full action set. ckanext-mcp, going by its README, groups about 200 actions into roughly 25 tools that include create, update and delete, scoped to the logged-in user.
- The usage counts (portals running a plugin, last push) are what let a model rank results. Without them a search returns forks and abandoned copies next to the extension everyone uses.

**Limits.** This is a proof of concept with no availability promise. It may be rate-limited or taken down, and the arguments of each call, such as the search text, are logged.

If any of it is useful, I can adapt it or contribute the tool design to whichever route you choose. If you would rather build it differently, that is fine too.

AI assistance: prepared with Claude (Anthropic) under my direction and review.
