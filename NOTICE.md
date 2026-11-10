# Notices

## Origin

This project is derived from **ckan-mcp-server** by the onData association (Andrea Borruso and contributors),
https://github.com/ondata/ckan-mcp-server, released under the MIT License, Copyright (c) 2025 onData association.
The extraction was made from commit `09e8cdc` (release 0.4.138/0.4.139, November 2026).

Code taken from that project keeps the MIT license and its copyright notice (see `LICENSE`). Files derived from it
say so in their header comment, naming the original file. The security hardening in `packages/core` (SSRF guards,
DNS pinning, redirect re-validation, size caps, parseable JSON truncation, untrusted-content handling) is the work
of the ckan-mcp-server maintainers; the GHSA references in comments point to their advisories.

The Italian Parliament profile in `packages/profile-parliament` (its source files, tests and test recordings), its
deployment in `packages/host-parliament` (the stdio entry and the Worker's routes), the
shared SPARQL helpers in `packages/core/src/sparql.ts` (read-only SELECT validation, string-literal escaping,
binding flattening), the per-host throttle and the row output model are derived from **italianparliament-mcp** by
Andrea Borruso, https://github.com/ondata/italianparliament-mcp, MIT License, Copyright (c) 2026 Andrea Borruso,
commit `fd46810`; the files say which original they follow. Its model-facing texts (Italian) are the original's.

Some data files are ondata's, copied unchanged from `09e8cdc` (JSON cannot carry a header): the portal registry
`packages/profile-ckan/src/portals.json`, the test fixtures under `packages/profile-ckan/tests/fixtures/` and the
smoke cases `packages/host-ckan/tests/smoke/cases.json`.

This project is not affiliated with or endorsed by the onData association.

## Data

The test recordings in `packages/profile-example/tests/fixtures/github` are files and folder listings from
**AkomaNtosoBulkData** by the Senato della Repubblica (Italian Senate, IT Office),
https://github.com/SenatoDellaRepubblica/AkomaNtosoBulkData, licensed CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/), recorded unchanged on 2026-11-10.

## Third-party dependencies

| Package | License | Copyright |
|---|---|---|
| @modelcontextprotocol/sdk | MIT | Copyright (c) 2024 Anthropic, PBC |
| zod | MIT | Copyright (c) 2020 Colin McDonnell |
| undici | MIT | Copyright (c) Matteo Collina and Undici contributors |
| express | MIT | Copyright (c) 2009-2014 TJ Holowaychuk, 2013-2014 Roman Shtylman, 2014-2015 Douglas Christopher Wilson |
| cheerio (parliament profile, `cheerio/slim`) | MIT | Copyright (c) 2022 The Cheerio contributors |
| htmlparser2 | MIT | Copyright 2010, 2011, Chris Winberry |
| dom-serializer | MIT | Copyright (c) 2014 The cheeriojs contributors |
| domhandler, domutils, domelementtype, css-select, css-what, cheerio-select, entities, nth-check | BSD-2-Clause | Copyright (c) Felix Böhm |
| boolbase | ISC | Felix Böhm |

Development dependencies (TypeScript, Vitest, esbuild, Wrangler) are not distributed.
