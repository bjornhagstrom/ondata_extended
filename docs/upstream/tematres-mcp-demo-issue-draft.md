<!--
DRAFT issue for tematres/TemaTres-Vocabulary-Server (Discussions are off; proposals go in issues, as #118).
Reader: Diego Ferreyra, TemaTres's maintainer: a vocabulary expert and researcher, probably not an AI-tools user. So:
the question first, then what it gives a vocabulary with real answers from his own server, then how to try it, step by
step (Björn: complete enough that a reader new to AI tools does not get lost); no demand.
Decision (Björn, 2026-11-15/16): first contact as a public issue; the demo becomes public at /tematres/mcp with 5
requests a second when this is posted (private at a secret path, 2 a second, until then).
Steps:
  1. Done 2026-11-15: honest user agent deployed and live calls recorded in DECISIONS.
  2. Make public: services.ts path "tematres", TEMATRES_RATE_LIMIT_RPS "5", landing texts (en, sv) say 5, wrangler
     comments and README line, tests. Push (Björn's ok, 2026-11-16: "kör när du är redo"), deploy, then check / and
     /health and re-run the four-step conversation at the public address.
  3. Done 2026-11-16: screenshot taken in the Claude Desktop project "TemaTres demo", questions 1-4 with "Short" added.
  4. Post: `gh issue create` with this body (lines unwrapped), then Björn drags the screenshot into the issue on
     GitHub where it says [screenshot] (gh cannot attach images) and removes the marker.
Facts behind the body:
  - Conversation (checked against services.php on 2026-11-16): NA of 4562 Public libraries; its narrower 4563, 4567,
    4570, 4571; their es target terms Biblioteca móvil, municipal, regional, rural; 4573 Agricultural libraries under
    4572 Special libraries (NA of 4572 quoted), es target Biblioteca agrícola, related 4524 and 4574. Question 2 was
    answered from the first answer (no lookup). ISO 25964 quote: the tool's output through the Worker, 2026-11-15.
  - Projects: "+ New Project", "Set project instructions" (support.claude.com/en/articles/9519177, 2026-11-16; Björn
    created the project in Desktop). The free-plan project limit is not stated (sources disagree).
  - Connecting: claude.ai "Customize > Connectors", "+ Add", "Add custom connector", "No sign in"; Free allows one
    custom connector; connectors added on the web appear in Desktop and mobile; per chat "+" > Connectors; Claude asks
    approval before using a tool (support.claude.com/en/articles/11175166 and 11176164, 2026-11-15).
  - Tool choice (2026-11-15/16): in plain chats with web search on, Claude used the web or memory, also after the
    server sent instructions; naming the connector worked; a project instruction worked without naming it. Björn's
    connector is named "Tematres demo".
  - Paper: May Chan, DCMI 2026, doi 10.23106/dcmi.952633234 (dcpapers.dublincore.org/article/952633234, CC BY 4.0):
    "authority file lookups alone were insufficient to ensure defensible output for every stage of the subject
    cataloguing workflow"; the paper pairs them with the Subject Headings Manual for retrieval.
  - Voice: Björn, iOS app, 2026-11-15. fetchNotes: raw cant_result 0 for ids 129, 132, 407, 737.
  - xml.php: for a vocabulary given by address, one request to xml.php?skosMeta=1; a refusal is remembered for an
    hour (adapter.ts exportRefusedUntil), so it is not repeated on every call.
-->

**Title:** A demo: an AI assistant answering from vocabularies on vocabularyserver.com, through `services.php`

I have built a small open-source server that lets AI assistants such as Claude look things up in TemaTres vocabularies. It only reads, through TemaTres's web service. To show what that gives a vocabulary, I pointed a demo at a few of the vocabularies on vocabularyserver.com. **Is that all right with you?** If you would rather it did not read from your server, I will take it down straight away.

**What it gives.** A person asks a question in ordinary language; the assistant looks it up in the vocabulary and answers from what it finds, with the vocabulary's own terms and structure, instead of from memory. And it is a conversation, not single questions: the assistant keeps the context, so you can follow up the way you would with a colleague. Here is a conversation with the UNESCO Thesaurus on your server (in the screenshot I asked for short answers, only to keep the picture small); every answer comes from the vocabulary, looked up or already returned earlier in the conversation:

1. *What does the UNESCO Thesaurus mean by a public library?* The scope note of *Public libraries*: "A library which serves the population of a community or region free of charge or for a nominal fee.", with its place: Information and communication › Documentary information systems › Libraries › Public libraries.
2. *Which kinds of public library does it list?* Four narrower concepts: *Mobile*, *Municipal*, *Regional* and *Rural libraries*. (No new lookup: they came with the first answer.)
3. *What are they called in Spanish?* From the thesaurus's own mappings to the Spanish edition: *Biblioteca móvil*, *Biblioteca municipal*, *Biblioteca regional* and *Biblioteca rural*.
4. *And agricultural libraries? They are not among them.* The thesaurus puts *Agricultural libraries* (*Biblioteca agrícola*) under *Special libraries* ("A library primarily serving one discipline or particular field."), not under public libraries, and relates it to *Agricultural information systems* and *Research libraries*: the thesaurus's own structure, not a guess.

[screenshot]

The same works for a glossary. *How does ISO 25964 describe a thesaurus?* gives the glossary's scope note for *thesaurus*: "controlled vocabulary in which concepts are represented primarily by preferred terms, formally organized so that paradigmatic relationships between the concepts are made explicit, and the preferred terms are accompanied by lead-in entries for synonyms or quasi-synonyms".

**How it works.** MCP (Model Context Protocol) is a common way for AI assistants to call outside tools. The server offers eight read-only tools in SKOS terms (search, suggest, concept, broader, narrower, related, top concepts, vocabulary information), each built on `services.php` tasks such as `search`, `fetchTerm`, `fetchUp`, `fetchDown`, `fetchDirectTerms`, `fetchNotes` and `fetchTargetTerms`. Nothing in TemaTres has to change. I have tried it with TemaTres 3.6.1 and 3.3.

**On your server.** The demo knows five vocabularies by name (the UNESCO Thesaurus in English, Spanish and French, and the ISO 25964-1 and Z39.19 glossaries); any other vocabulary there can be reached by its address, for example *AGROVOC* by asking for "irrigation" in `https://vocabularyserver.com/agrovoc/en/`. It identifies itself as `Vocab-MCP-Server/0.1.0` and sends at most five requests a second from each running copy; if that is too much for your server, tell me and I will lower it. Answers are kept for five minutes (vocabulary information for an hour). It reads `services.php`; for a vocabulary given by its address it also asks `xml.php?skosMeta=1` once, to learn the concept URI pattern. Your browser check refuses that request, so it uses TemaTres's default pattern and does not ask again for an hour. It does not try to get past the browser check.

**Other uses.** Besides answering questions:

- *Consistent terms in a project.* In a Claude project for a report or a presentation, a project instruction (see "Working in a Claude project" below) has the assistant look terms up as it writes, so the same concept gets the same name throughout. I use it this way with our own vocabulary.
- *Checking a draft.* Paste a text and ask which terms are not the preferred ones; the assistant shows the preferred term and its scope note.
- *Subject indexing.* Give it a document and ask for candidate descriptors; each one is confirmed in the vocabulary, with its place in the hierarchy. May Chan has studied this for Library of Congress subject headings, with an MCP server for live LC authority lookup: "Grounding AI Subject Cataloguing in Standards and Policy: An MCP Server for Live LC Authority Lookup and a DITA-Encoded SHM for RAG", DCMI 2026, [doi:10.23106/dcmi.952633234](https://doi.org/10.23106/dcmi.952633234). She found that authority lookups alone were not enough for defensible output at every stage, and pairs them with the Subject Headings Manual; the same holds here: the vocabulary gives the terms, not the indexing policy.
- *By voice.* In the Claude app on the phone you can talk with the vocabulary instead of typing: ask, listen to the answer, and ask a follow-up, in a whole spoken conversation. I have tried it with this demo in the iOS app.
- *Search strings.* Ask for a search on a topic; the assistant adds the narrower and related terms from the vocabulary.
- *Equivalents in other languages,* from the vocabulary's own mappings rather than machine translation.

**Try it.** The address of the demo is `https://ondata-extended-services.ondata-extended.workers.dev/tematres/mcp`.

- *Add it to Claude (on the web at claude.ai, or in the Claude Desktop app):* Customize > Connectors > "+ Add" > Add custom connector. Give it a name, for example "TemaTres demo" (mine is called "Tematres demo", as in the screenshot), paste the address, choose "No sign in" under Authentication, then Add. It works on the free plan, which allows one custom connector. A connector added on the web also appears in the Desktop app and on the phone.
- *In a chat:* make sure the connector is switched on (the "+" button > Connectors), then ask, for example the public-library questions above. You do not need to name the tools, and the assistant asks your permission the first time it uses one.
- *Which source it uses:* the assistant decides for itself. With web search on, a question about the UNESCO Thesaurus may go to UNESCO's own web pages instead, since the thesaurus is also published there. Two ways to point it at the vocabulary:
  - *In a single chat,* name the connector: "Use the TemaTres demo connector: what does the UNESCO Thesaurus mean by a public library?".
  - *In a Claude project,* say it once in the project's instructions; questions in the project then use the vocabulary without your naming it (steps below). This is what I would recommend for real work.
- *The difference is the point:* from memory or the web, the assistant paraphrases; from the vocabulary, it quotes the scope note and follows the thesaurus's own structure.
- *Other assistants:* ChatGPT, VS Code and other MCP clients can also connect to a server by its address, depending on the plan; the menus differ.
- *If something does not work,* ask the assistant itself ("how do I add a custom MCP connector here?"); it usually knows its own menus better than any instructions I could write.

**Working in a Claude project.** A project keeps its own instructions and chats together, so one instruction covers every chat of a piece of work. I set it up in the Claude Desktop app; claude.ai has the same menus:

1. Open *Projects* in the left sidebar (or go to claude.ai/projects) and click *+ New Project*. Give it a name, for example "Library report".
2. In the project, click *Set project instructions*, paste an instruction like the one below, and save. It applies to every chat in the project.
3. Start a chat in the project and check that the connector is switched on ("+" > Connectors).
4. Ask as you normally would, without naming the connector. In the screenshot the assistant shows "Used Tematres demo" each time it looks something up.

An instruction to start from, to adapt to the vocabulary, the work and the name you gave the connector:

> In this project, check every subject term against the UNESCO Thesaurus with the TemaTres demo connector (vocab_ tools) before using it. Use the thesaurus's preferred terms, quote its scope notes when you define a term, and say when a term is not in the thesaurus instead of inventing one. For terms in other languages, use the thesaurus's own mappings. Prefer the connector to web search for anything the thesaurus covers.

**Code and credit.** Tried with Claude Desktop on macOS (in a project, as above) and the Claude app on iOS (by voice); the server answers any MCP client that speaks Streamable HTTP. The code is MIT and public, in [bjornhagstrom/ondata_extended](https://github.com/bjornhagstrom/ondata_extended) (the vocabulary part is `packages/profile-skos`; the README says how to run it locally against your own TemaTres). The server is my project, built on an engine derived from onData's [ckan-mcp-server](https://github.com/ondata/ckan-mcp-server) (MIT), and not affiliated with onData.

**Limits.** A proof of concept with no availability promise: it may be rate-limited or taken down, and the arguments of each call (the search text, for example) are logged. It reads only vocabularyserver.com, and only what `services.php` publishes.

**Two things I noticed**, in case they are useful:

- In *The Dictionary of Knowledge Organization*, `fetchNotes` returned no notes for the terms I tried (for example 129, CLASS). If the definitions there are kept as notes, a tool cannot reach them; perhaps that is a setting of that vocabulary. If it is not intended, I would be glad to look into it and prepare a PR.
- A tool cannot find out which vocabularies a server has; it needs each address. A machine-readable list, like the page vocabularyserver.com/vocabularies, would let an assistant pick the right one. That may be more a matter for vocabularyserver.com than for TemaTres itself.

**What I would like to know.** Do you find this interesting, and do you see potential in it for TemaTres users? Is there something you would want it to do that it does not? Since the code is public, you can also run the server yourself against your own instances.

AI assistance: prepared with Claude (Anthropic) under my direction and review.
