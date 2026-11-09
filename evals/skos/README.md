# SKOS profile evals: tool selection

Does a model pick the right `vocab_*` tools for a question, and reach the right concept? Same idea as ondata's
`evals/tool-selection` (ckan-mcp-server), at small scale.

`tool-selection.jsonl`, one case per line:

| Field | Meaning |
|---|---|
| `question` | what a user would ask (Swedish or English) |
| `expect_tools` | the tools, in order, a good answer calls; the first one is the routing decision |
| `expect_concept` | the concept id the answer must reach in the test vocabulary (begrepp.hagstrom.nu), or `null` |

Scoring per case: **routing** (first tool called is `expect_tools[0]`), **reach** (some call returned
`expect_concept`), **calls** (number of tool calls; fewer is better for the same reach).

## How to run (not automated yet)

Manually: connect an MCP client to the local server (`npm run build`, then `TRANSPORT=http
VOCAB_ALLOWED_DOMAINS=begrepp.hagstrom.nu node packages/host-vocab/dist/index.js`, endpoint
`http://127.0.0.1:3000/mcp`), ask each question in a fresh conversation, note the tools called.

Automated: a runner that sends each question with the tool list to a model API and scores the calls is planned. It
needs an API key and costs money per run, so it is not added without a decision (see docs/DECISIONS.md). Cases depend
on the live vocabulary's content (2026-11-09); when the vocabulary changes, update `expect_concept` first.
