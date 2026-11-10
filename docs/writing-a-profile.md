# Writing a profile

A profile is one MCP server's worth of domain knowledge: its tools, queries and texts. The core gives it the rest:
the guarded HTTP client, cache, rate limits, output shaping, hosting (stdio, Streamable HTTP, Cloudflare Workers)
and telemetry. This guide walks through the example profile, `packages/profile-example`, and its deployment,
`packages/host-example`. Read the files next to this text; they are short and commented.

The example reads the Italian Senate's Akoma Ntoso bulk data on GitHub (`SenatoDellaRepubblica/AkomaNtosoBulkData`,
CC BY 4.0, refreshed hourly), with two tools:

- `akn_list_files` lists a bill's document folders, or the files in one folder;
- `akn_document` reads one file: type, number, date and the text without markup.

It is an example, not a product: it is not deployed, and italianparliament-mcp's `amendments` tool already uses the
same source in more depth.

## The parts

| File | What it holds | Rule it shows |
|---|---|---|
| `profile-example/src/akn.ts` | The source alone: URLs, file names, reading the XML. Pure functions, no engine | Keep domain logic testable without a network |
| `profile-example/src/tools.ts` | The two tools | Every request through `ctx.http`; untrusted text wrapped |
| `profile-example/src/index.ts` | The `Profile`: id, prefix, host policies, telemetry fields, error hints | The profile owns every text the model sees |
| `profile-example/tests/` | Unit, contract and end-to-end tests, recorded answers | Fixtures for every tool; contract tests against a fake `ctx.http` |
| `host-example/src/server.ts` | The deployment: name, config prefixes, which profiles | One file per deployment |
| `host-example/src/node.ts`, `worker.ts` | stdio binary and Worker entry | The core hosts; the deployment chooses what to log |
| `host-example/tests/smoke/cases.json` | Known answers against the live source | A smoke file per profile |

## 1. The profile object

```ts
export function createExampleProfile(): Profile {
  return {
    id: "akn-example",
    version: "0.1.0",
    toolPrefix: "akn_",                       // every tool name starts with it
    tools: EXAMPLE_TOOLS,
    hostPolicies: {                           // what each upstream tolerates; applied to every request
      "api.github.com": { minIntervalMs: 1000, timeoutMs: 15_000, retry: { attempts: 2 } },
      "raw.githubusercontent.com": { timeoutMs: 30_000, retry: { attempts: 2 } }
    },
    shrinkableKeys: [],                       // array keys JSON truncation may shrink
    telemetryFields: ["legislature", "ddl", "kind", "file", "response_format"],
    untrustedSourceLabel: "the Senate's Akoma Ntoso files",
    honestUserAgent: "Akn-Example-MCP-Server/0.1.0",
    emptyText: "No entries. Do not assume documents exist that are not listed.",
    describeError(error) { /* a hint per error the profile knows, or null */ }
  };
}
```

- **Prefix.** Tool names are a user contract. A new profile takes a prefix; a port of a server whose names are already
  in use (italianparliament-mcp's 43 names) may leave it out.
- **Host policies** replace hand-written throttles, timeouts and retry loops. The core retries only network failures,
  timeouts, 5xx and 429, never another 4xx.
- **Telemetry fields** are the arguments a host may log, capped at 200 characters. Never a secret.
- **`describeError`** adds a hint after the core's error text. The core never echoes an upstream error body.

## 2. A tool that returns rows

`akn_list_files` returns data, not text. The host formats it: as JSONL with `structuredContent` over MCP, and as CSV
or JSONL in a CLI (`runRowsTool`), so one definition serves both.

```ts
async rows({ legislature, ddl, kind }, ctx) {
  const listing = await ctx.http.json(listingUrl(legislature, ddl, kind), { headers: apiHeaders(ctx) }, options());
  ...
  return { rows, columns: ["name", "type", "size"], notice, emptyText };
}
```

- `ctx.http.json` checks the URL (SSRF guards, the domain allowlist), takes a rate token, applies the host policy,
  follows at most five redirects and checks each, caps the body size, times out the whole request, and parses JSON.
- `options()` is `{ fixedUpstream: true, userAgent: "honest", cache: { ttlSeconds: 3600 } }`. **`fixedUpstream`** says
  the URL is the profile's own constant upstream, not a caller's URL, so the deployment's domain allowlist does not
  apply to the first hop. A profile that takes URLs from callers (CKAN's `server_url`) leaves it out.
- A **`notice`** is kept after the rows even when the output is cut for size: here, that GitHub lists at most 1000
  entries per folder.

## 3. A tool that returns a document

`akn_document` returns a finished result, Markdown or JSON:

```ts
async handler({ legislature, ddl, kind, file, max_chars, response_format }, ctx) {
  const res = await ctx.http.request(url, {}, options());      // any status; never throws on one
  if (res.status === 404) throw new NotInRepositoryError(...);  // the profile's own error, with a hint
  ...
  if (response_format === "json") return o.json({ ... });       // always parseable, truncated safely
  md += o.wrapUntrusted(text);                                  // upstream free text fenced as data
  return o.text(md);                                            // truncated to the character limit
}
```

- **Upstream text is untrusted.** Short values go through `ctx.output.sanitizeInline` (one Markdown line, no
  injection), free text through `ctx.output.wrapUntrusted`, URLs through `safeUrlText`.
- **Input is validated before any request.** The `file` argument must match the repository's file pattern, so
  `../../README.MD` never reaches the network (tested).

## 4. Configuration and secrets

Settings are namespaced per deployment: `host-example` reads `AKN_*` (and `ENGINE_*` as an alias). The profile reads
`ctx.config.get("GITHUB_TOKEN")`, which finds `AKN_GITHUB_TOKEN`. A secret comes only through the config, goes only to
the host that needs it (here `api.github.com`, not `raw.githubusercontent.com`), and never into a message, a log line
or telemetry. All three are tested. The core drops `Authorization`, `Proxy-Authorization` and `Cookie` when a redirect leaves
the origin, so a header given for one host is never forwarded to another. On a Worker: `wrangler secret put
AKN_GITHUB_TOKEN`.

General settings come from the core under the same prefix: `AKN_TIMEOUT_MS`, `AKN_MAX_RESPONSE_BYTES`,
`AKN_RATE_LIMIT_ENABLED`, `AKN_CACHE_*`, `AKN_ALLOWED_DOMAINS`, `AKN_CHARACTER_LIMIT`.

## 5. Tests

| File | Network | What it proves |
|---|---|---|
| `tests/akn.test.ts` | none | URLs, file-name pattern, entity decoding, reading two recorded files |
| `tests/contract.test.ts` | a fake `ctx.http` | What the profile asks of the engine (URL, headers, options) and what it does with each answer: listing, cap notice, 404, a non-listing, other statuses, token placement |
| `tests/profile.test.ts` | `fetch` and DNS stubbed, answers recorded from GitHub | The real engine and an MCP client end to end: registration, output, errors with hints, no request for a bad file name, the token only where it belongs |
| `host-example/tests/host.test.ts` | `fetch` stubbed | Worker routes, the tool list, a completed call's log line: its fields, and no token though the token was sent |
| `tests/smoke/cases.json` | live GitHub | Known answers: `npm run smoke:example` |

Recordings are files with the URL, status and content type in `*.meta.json` and the body beside it. Recording them is
a `curl` per URL; replaying is the `fetch` stub at the top of `profile.test.ts`.

## 6. The deployment

```ts
// host-example/src/server.ts
export const profile = createExampleProfile();
export function createExampleEngine(source?: ConfigSource) {
  return createEngine({ configPrefixes: ["AKN", "ENGINE"], configSource: source, cacheOrigin: "https://akn-example-cache.internal" });
}
export function buildServer(engine: Engine) {
  const server = createMcpServer({ name: "akn-example-mcp-server", version: "0.1.0" });
  registerProfiles(server, [profile], engine);
  return server;
}
```

`node.ts` is four lines around `runStdio`; `worker.ts` is `createWorkerHandler` with a health body, the fields to log
and the Analytics data point. Keep **one engine per process or isolate**: it holds the cache, the rate limiter and the
per-host throttles. Several profiles can share one deployment: pass them all to `registerProfiles`.

## 7. Checks

`npm run check` runs the typecheck, the boundary check (the core names no backend; profiles never import each other),
the Workers bundle check (no Node built-ins in the bundle) and every test. A new profile and host are added to
`scripts/check-worker-bundle.mjs` and the root `build` script.

## Checklist for a new profile

- [ ] `packages/profile-<name>`: `src/index.ts` (the `Profile`), the tools, the domain logic apart from the engine.
- [ ] Every request through `ctx.http`; constant upstreams marked `fixedUpstream`; host policies for each upstream.
- [ ] Upstream text sanitized or wrapped; no error body echoed; hints in `describeError`.
- [ ] Secrets only via `ctx.config`; telemetry fields chosen, none secret.
- [ ] Recorded fixtures for every tool; contract tests against a fake `ctx.http`; an end-to-end test; a smoke file.
- [ ] `packages/host-<name>` if it is deployed on its own; added to the bundle check and the build.
- [ ] Licences of recorded data in `NOTICE.md`; decisions in `docs/DECISIONS.md`.
