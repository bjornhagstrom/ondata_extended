# The CKAN ecosystem profile (proof of concept)

Status: built 2026-11-14; a test Worker on workers.dev since 2026-11-14 (`npm run deploy:ecosystem`). Decision and review: `docs/DECISIONS.md`, 2026-11-14.

## Purpose

An MCP profile that lets a model search and compare CKAN extensions: what an extension does, how recently it was
worked on, and which portals run it. A proof of concept for datHere, who run the CKAN Ecosystem Catalog
(`ecosystem.ckan.org`), built only on data that is already open. Read-only.

`ecosystem.ckan.org` is itself a CKAN instance, but its API sits behind a Cloudflare bot challenge, and datHere's own
pipeline passes it with a secret token. We do not scrape the catalog or route around the challenge. If datHere open
the read API, the CKAN profile can read the catalog directly; this profile shows what the usage data adds.

## Tools (prefix `ecosystem_`)

| Tool | Arguments | Answers | Requests |
|---|---|---|---|
| `ecosystem_search_extensions` | `query`; optional `upkeep`, `family`, `min_portals`, `limit` (default 20, max 100) | extensions ranked by match on repository and plugin names, description and topics, then by use; each with plugins, description, portals running it, stars, upkeep, last push | none |
| `ecosystem_get_extension` | `extension` (`owner/repo`, GitHub URL, package or plugin name); `include_readme` (default true); `response_format` | the card: description, topics, README opening, plugins, family, portals running it, stars, forks, contributors, releases, last push, archived, forks ahead, other repositories providing the plugin, plugins installed with it (most used plugins only) | the README from `raw.githubusercontent.com`, for repositories in the index only |
| `ecosystem_portals_using` | `plugin` (exact name); `limit` (default 50, max 500) | portals reporting the plugin, largest first: name, URL, CKAN version, datasets, crawl status | none |
| `ecosystem_overview` | `response_format` | totals, upkeep and portal status counts, CKAN versions in use, most used non-core plugins, families, data dates | none |

Every answer ends with the data dates and the source, and says that supported CKAN versions, licence and publisher
are not in this data. Upkeep is datHere's push-recency bucket, not a judgement of maintenance: `active` (pushed
within 180 days), `recent` (a year), `quiet` (two years), `still` (older; often finished, not broken), `archived`.

## Data

`packages/profile-ckan-ecosystem/data/index.json` (about 1.3 MB, 170 KB gzipped), committed, built by
`GITHUB_TOKEN=$(gh auth token) npm run build:ecosystem-index`:

| Source | What it gives | Licence |
|---|---|---|
| `dathere/pose-ckanext-metadata` at one pinned commit: `dashboard-data/dashboard.json` | per package: portals running it, share, upkeep, forks ahead; per plugin: portals, family; the co-installation pairs of the most used plugins | MIT |
| same: `extensions-history/<latest>.csv` | per repository: stars, forks, releases, open issues, contributors | MIT |
| same: `extensions-activity/github_activity.csv`, `entry_points.csv` | last push, archived, fork; repository to plugin names | MIT |
| same: `sites-history/<latest>.csv` | per portal: CKAN version, datasets, plugins | MIT |
| GitHub GraphQL, each repository | description and topics | the repositories' own short texts |

Measured 2026-11-14: 1451 extensions, 909 with a description, 467 run by at least one crawled portal; 1319 portals,
954 reporting their plugins. README openings are read at call time (22 of 25 sampled repositories gave a usable
one), cached for a day, wrapped as untrusted, and never stored in the index.

Limits: a weekly crawl (the dates are in every answer); GitHub repositories only; usage is what reachable portals
report; the plugin-to-package match is datHere's; co-installation exists only for datHere's top 60 plugins; the
catalog's hand-entered fields are missing.

## Running it

- Locally: `npm run build`, then `node packages/host-ckan-ecosystem/dist/index.js` (stdio) with
  `ECOSYSTEM_ALLOWED_DOMAINS=raw.githubusercontent.com`, or as a connector in Claude Code:
  `claude mcp add ecosystem -e ECOSYSTEM_ALLOWED_DOMAINS=raw.githubusercontent.com -- node <repo>/packages/host-ckan-ecosystem/dist/index.js`.
- Checks: `npm run check`; `npm run smoke:ecosystem` (known answers, live README reads).
- The test Worker: `npm run deploy:ecosystem` (Björn's ok each time), then
  `SMOKE_URL=https://<worker>/mcp node scripts/smoke-ecosystem.mjs`.
- Refreshing the data: rebuild the index, run the tests and the smoke file, commit the index with the commit message
  naming datHere's commit.

## Not in the proof of concept

Writing to or registering in the catalog; anything behind the Cloudflare challenge; a scheduled index rebuild;
contact with datHere before Björn has seen it working.
