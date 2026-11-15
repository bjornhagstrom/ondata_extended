<!--
DRAFT issue for tematres/TemaTres-Vocabulary-Server (Discussions are off; proposals go in issues, as #118).
Reader: Diego Ferreyra, TemaTres's maintainer: a vocabulary expert, probably not an AI-tools user. So: what it gives a
vocabulary, with real answers from his own server, before protocol talk; short; one question; no demand.
Decision (Björn, 2026-11-15): first contact as a public issue, so the demo becomes public when this is posted (it was
private until then). The secret path must never appear here.
Before posting (Björn's ok, after mcp-reviewer):
  1. Done 2026-11-15: honest user agent deployed (version 78ea66f2), live calls repeated and recorded in DECISIONS.
  2. Make the demo public at /tematres/mcp (packages/host-services/src/services.ts: path "tematres" instead of the
     secretPath) and raise its rate limit to 5 a second (TEMATRES_RATE_LIMIT_RPS = "5" in wrangler.toml; Björn: 2 until
     he is told, 5 when this is posted; the text below says 5), deploy, check / and /health and one call.
  3. Fill in the clients tried (Claude Desktop once Björn has asked example 1 there); optionally attach that screenshot.
  4. Post with lines unwrapped.
Facts: the example answers are the tools' output through the Worker on 2026-11-15 (DECISIONS); the fetchNotes check is
the raw web-service answer (cant_result 0 for ids 129, 132, 407 and 737).
Connecting (checked 2026-11-15 against vendor docs): claude.ai "Customize > Connectors", "+ Add", "Add custom
connector", "No sign in"; Free allows one custom connector; connectors sync to Desktop and mobile; per chat "+" >
Connectors; Claude picks tools itself and asks for approval
(support.claude.com/en/articles/11175166 and 11176164). ChatGPT's steps and plans are not confirmed, so not detailed.
Use cases: the LC precedent is lc-vocabularies-mcp (May Chan, DCMI 2026, Seoul, doi 10.23106/dcmi.952633234, CC BY 4.0,
dcpapers.dublincore.org/article/952633234); the others follow from the tools, no published example found.
Voice: secondary sources say Claude's voice mode supports connectors since 2026-07-23; a report of 2026-07-13 says custom
MCP connector tools failed in voice mode. Not in the text until Björn has tried it with the demo.
Follow-up example: the tools' output through the Worker on 2026-11-15, 22:20 UTC, with the honest user agent (Public
libraries 4562 and its NA note; target terms of 4543: es, fr, ru; Agricultural libraries 4573 under Special libraries
4572). AGROVOC "irrigation": 30 hits through the Worker. Björn checks the Claude menu labels once more when he takes the
screenshots.
-->

**Title:** A demo: an AI assistant answering from vocabularies on vocabularyserver.com, through `services.php`

I have built a small open-source server that lets AI assistants such as Claude look things up in TemaTres vocabularies. It only reads, through TemaTres's web service. To show what that gives a vocabulary, I pointed a demo at a few of the vocabularies on vocabularyserver.com. **Is that all right with you?** If you would rather it did not read from your server, I will take it down straight away.

**What it gives.** A person asks a question in ordinary language; the assistant looks it up in the vocabulary and answers from what it finds, with the vocabulary's own terms and structure, instead of from memory. Two answers the tools gave from your server:

1. *Which kinds of libraries does the UNESCO Thesaurus distinguish, and what are they called in Spanish?* The concept *Libraries* comes back with its path (Information and communication › Documentary information systems › Libraries), nine narrower concepts (Academic, Childrens, Digital, Government, Institutional, International, National, Public and School libraries), its related concepts, and its mapping to *Biblioteca* in the Spanish edition, whose narrower concepts include *Biblioteca pública* and *Biblioteca escolar*.
2. *How does ISO 25964 describe a thesaurus?* The glossary's scope note for *thesaurus*: "controlled vocabulary in which concepts are represented primarily by preferred terms, formally organized so that paradigmatic relationships between the concepts are made explicit, and the preferred terms are accompanied by lead-in entries for synonyms or quasi-synonyms".

It is a conversation, not single questions: the assistant keeps the context, so you can follow up the way you would with a colleague. Continuing the first example:

- *What exactly counts as a public library?* The assistant opens *Public libraries* and gives UNESCO's scope note: "A library which serves the population of a community or region free of charge or for a nominal fee."
- *And what is "libraries" in French and Russian?* From the thesaurus's own mappings: *Bibliothèque* and *Библиотеки*, with the Spanish *Biblioteca* already given.
- *Where do agricultural libraries fit, then? They were not in the list.* The assistant looks *Agricultural libraries* up and finds it under *Special libraries*, not under *Libraries*, related to *Agricultural information systems* and *Research libraries*: the thesaurus's own structure, not a guess.

**How it works.** MCP (Model Context Protocol) is a common way for AI assistants to call outside tools. The server offers eight read-only tools in SKOS terms (search, suggest, concept, broader, narrower, related, top concepts, vocabulary information), each built on `services.php` tasks such as `search`, `fetchTerm`, `fetchUp`, `fetchDown`, `fetchDirectTerms`, `fetchNotes` and `fetchTargetTerms`. Nothing in TemaTres has to change. I have tried it with TemaTres 3.6.1 and 3.3.

**On your server.** The demo knows five vocabularies by name (the UNESCO Thesaurus in English, Spanish and French, and the ISO 25964-1 and Z39.19 glossaries); any other vocabulary there can be reached by its address, for example *AGROVOC* by asking for "irrigation" in `https://vocabularyserver.com/agrovoc/en/`. It identifies itself as `Vocab-MCP-Server/0.1.0` and sends at most five requests a second from each running copy; if that is too much for your server, tell me and I will lower it; answers are kept for five minutes (vocabulary information for an hour). It uses `services.php`, and for a vocabulary not in its list one request to `xml.php?skosMeta=1` to learn the concept URI pattern; it does not try to get past the browser check on your pages.

**Other uses.** Besides answering questions:

- *Consistent terms in a project.* In a Claude project for a report or a presentation, an instruction such as "check terms against the UNESCO Thesaurus and use its preferred terms" makes the assistant look terms up as it writes, so the same concept gets the same name throughout. I use it this way with our own vocabulary.
- *Checking a draft.* Paste a text and ask which terms are not the preferred ones; the assistant shows the preferred term and its scope note.
- *Subject indexing.* Give it a document and ask for candidate descriptors; each one is confirmed in the vocabulary, with its place in the hierarchy. May Chan has studied this for Library of Congress subject headings, with an MCP server for live LC authority lookup: "Grounding AI Subject Cataloguing in Standards and Policy: An MCP Server for Live LC Authority Lookup and a DITA-Encoded SHM for RAG", DCMI 2026, [doi:10.23106/dcmi.952633234](https://doi.org/10.23106/dcmi.952633234). Her finding that authority lookups alone were not enough for defensible cataloguing, without the indexing policy as well, applies here too.
- *By voice.* On the phone you can talk with the vocabulary instead of typing: ask, listen to the answer, and ask a follow-up, in a whole spoken conversation. [VERIFY before posting: Björn tests the demo connector in Claude's voice mode on the phone.]
- *Search strings.* Ask for a search on a topic; the assistant adds the narrower and related terms from the vocabulary.
- *Equivalents in other languages,* from the vocabulary's own mappings rather than machine translation.

**Try it.** The address of the demo is `https://ondata-extended-services.ondata-extended.workers.dev/tematres/mcp`.

- *Claude, on the web (claude.ai) or in the Claude Desktop app:* Customize > Connectors > "+ Add" > Add custom connector. Give it a name, paste the address, choose "No sign in" under Authentication, then Add. It works on the free plan, which allows one custom connector. A connector added on the web also appears in the Desktop app and, at the next login, on the phone.
- *In a chat:* make sure the connector is switched on (the "+" button > Connectors), then just ask, for example the libraries question above. You do not need to name the connector or the tools; the assistant picks them when the question needs them, and asks your permission the first time it uses one.
- *Other assistants:* ChatGPT, VS Code and others can add an MCP server by address too; the menus differ.
- *If something does not work,* ask the assistant itself ("how do I add a custom MCP connector here?"); it usually knows its own menus better than any instructions I could write.

Tried with: [fill in]. Code (MIT): [packages/profile-skos](https://github.com/bjornhagstrom/ondata_extended/tree/main/packages/profile-skos). The server is my project, built on an engine derived from onData's [ckan-mcp-server](https://github.com/ondata/ckan-mcp-server) (MIT), and not affiliated with onData.

**Limits.** A proof of concept with no availability promise: it may be rate-limited or taken down, and the arguments of each call (the search text, for example) are logged.

**Two things I noticed.** I would be glad to prepare a PR for either, if you want it:

- In *The Dictionary of Knowledge Organization*, `fetchNotes` returned no notes for the terms I tried (for example 129, CLASS), so a tool cannot show the definitions there. Perhaps that is a setting of that vocabulary; if not, I can look into it.
- A tool cannot find out which vocabularies a server has; it needs each address. A machine-readable list, like the page vocabularyserver.com/vocabularies, would let an assistant pick the right one.

**What I would like to know.** Do you find this interesting, and do you see potential in it for TemaTres users? Is there something you would want it to do that it does not? The code is public: you can also run the server yourself against your own instances.

AI assistance: prepared with Claude (Anthropic) under my direction and review.
