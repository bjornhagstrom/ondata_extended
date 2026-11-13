<!--
DRAFT comment, not posted. Target: ondata/italianparliament-mcp#117 (Andrea's own issue: record SPARQL answers once,
replay them offline). Purpose: share what we built for the same tools, offer his design as a PR, easy to decline.
Facts checked 2026-11-14 against packages/profile-parliament/tests/parity/ (record.test.ts, replay.ts,
parity.test.ts, cases.ts; 133 recordings, 514,494 bytes gzipped) and italianparliament-mcp fd46810 (MIT).
Post only with Björn's ok, after mcp-reviewer. Post with lines unwrapped. No Claude Code line.
-->

I saw this issue while working on the parity tests for my port of your tools, and I built something close to it there, so here is what I learned, in case it helps. If you would rather do it yourself, or not at all, that is completely fine.

**What I have.** A record/replay harness that runs your server (`fd46810`) and my port side by side on 133 cases ([`tests/parity/`](https://github.com/bjornhagstrom/ondata_extended/tree/main/packages/profile-parliament/tests/parity)). It works at the `fetch` level, not inside `sparqlRequest`, because it also covers the Camera HTML pages. One difference matters here: **it has never sent a request to any senato.it host.** Every Senato answer in it is synthetic: the successful ones in the shape of Virtuoso's SPARQL JSON, the failures as HTTP errors. That is enough to compare two implementations, but not to test against the real Senato, which is what this issue needs. So the recording at release time, with real Senato requests, would stay yours.

**What bears on your "Da decidere" list:**

- **Queries with today's date:** I freeze `Date` at the recording time during replay (`vi.useFakeTimers({ toFake: ["Date"], now: recordedAt })`), and the recording stores that time. Queries built from "today" then hash the same in replay as when recorded, so they need not be excluded.
- **No silent fallback:** a missing recording fails and names the request, as you propose. I added the reverse too: a recorded request that the replay never makes is also a failure, which catches a tool that silently stops asking something.
- **Determinism:** each case replays your own code first and checks that it reproduces its recorded output exactly. That separates "the harness is flaky" from "the code changed".
- **The Senato throttle:** at `fd46810`, `snQuery` calls `throttleSenato()` before `sparqlRequest` (`src/core/client.ts:131`). With the replay inside `sparqlRequest`, every Senato query would still wait 2 s, so roughly 5 minutes for the ~156 Senato requests you measured. Skipping the throttle in replay mode keeps it to seconds. This one I noticed while reading your code for this comment; I have not run it.
- **Size:** gzip per case keeps the 133 cases at about 515 KB together; the largest, a leg. 18 act with its scheda page, index and two amendment lists, is 36 KB.

**What I can offer:** your design as a PR, done as you describe it (`SPARQL_FIXTURES=record|replay` in `src/core/client.ts`, a file per `sha256(query)`, no network in replay), without bringing my harness in. Your proposal covers SPARQL only; if you want `camera-amendments` replayed too, the same idea works for its HTML pages from www.camera.it and documenti.camera.it, which my harness already records live. Or nothing beyond this comment, if you prefer.

AI assistance: prepared with Claude (Anthropic) under my direction and review.
