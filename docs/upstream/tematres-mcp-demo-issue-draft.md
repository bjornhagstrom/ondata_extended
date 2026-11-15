<!--
DRAFT issue for tematres/TemaTres-Vocabulary-Server (Discussions are off; proposals go in issues, as #118).
Reader: Diego Ferreyra, TemaTres's maintainer: a vocabulary expert, probably not an AI-tools user. So: what it gives a
vocabulary, with real answers from his own server, before protocol talk; short; one question; no demand.
Decision (Björn, 2026-11-15): first contact as a public issue, so the demo becomes public when this is posted (it was
private until then). The secret path must never appear here.
Before posting (Björn's ok, after mcp-reviewer):
  1. Deploy the honest user agent and repeat the live calls through the Worker; record them in docs/DECISIONS.md.
  2. Make the demo public at /tematres/mcp (packages/host-services/src/services.ts: path "tematres" instead of the
     secretPath), deploy, check / and /health and one call.
  3. Fill in the clients tried (Claude Desktop once Björn has asked example 1 there); optionally attach that screenshot.
  4. Post with lines unwrapped.
Facts: the example answers are the tools' output through the Worker on 2026-11-15 (DECISIONS); the fetchNotes check is
the raw web-service answer (cant_result 0 for ids 129, 132, 407 and 737).
-->

**Title:** A demo: an AI assistant answering from vocabularies on vocabularyserver.com, through `services.php`

I have built a small open-source server that lets AI assistants such as Claude look things up in TemaTres vocabularies. It only reads, through TemaTres's web service. To show what that gives a vocabulary, I pointed a demo at a few of the vocabularies on vocabularyserver.com. **Is that all right with you?** If you would rather it did not read from your server, I will take it down straight away.

**What it gives.** A person asks a question in ordinary language; the assistant looks it up in the vocabulary and answers from what it finds, with the vocabulary's own terms and structure, instead of from memory. Two answers the tools gave from your server:

1. *Which kinds of libraries does the UNESCO Thesaurus distinguish, and what are they called in Spanish?* The concept *Libraries* comes back with its path (Information and communication › Documentary information systems › Libraries), nine narrower concepts (Academic, Childrens, Digital, Government, Institutional, International, National, Public and School libraries), its related concepts, and its mapping to *Biblioteca* in the Spanish edition, whose narrower concepts include *Biblioteca pública* and *Biblioteca escolar*.
2. *How does ISO 25964 describe a thesaurus?* The glossary's scope note for *thesaurus*: "controlled vocabulary in which concepts are represented primarily by preferred terms, formally organized so that paradigmatic relationships between the concepts are made explicit, and the preferred terms are accompanied by lead-in entries for synonyms or quasi-synonyms".

**How it works.** MCP (Model Context Protocol) is a common way for AI assistants to call outside tools. The server offers eight read-only tools in SKOS terms (search, suggest, concept, broader, narrower, related, top concepts, vocabulary information), each built on `services.php` tasks such as `search`, `fetchTerm`, `fetchUp`, `fetchDown`, `fetchDirectTerms`, `fetchNotes` and `fetchTargetTerms`. Nothing in TemaTres has to change. I have tried it with TemaTres 3.6.1 and 3.3.

**On your server.** The demo knows five vocabularies by name (the UNESCO Thesaurus in English, Spanish and French, and the ISO 25964-1 and Z39.19 glossaries); any other vocabulary there can be reached by its address. It identifies itself as `Vocab-MCP-Server/0.1.0` and sends at most two requests a second from each running copy; answers are kept for five minutes (vocabulary information for an hour). It uses `services.php`, and for a vocabulary not in its list one request to `xml.php?skosMeta=1` to learn the concept URI pattern; it does not try to get past the browser check on your pages.

**Try it.** `https://ondata-extended-services.ondata-extended.workers.dev/tematres/mcp`. In Claude: Settings, Connectors, Add custom connector, with that address, then ask one of the questions above. Tried with: [fill in]. Code (MIT): [packages/profile-skos](https://github.com/bjornhagstrom/ondata_extended/tree/main/packages/profile-skos). The server is my project, built on an engine derived from onData's [ckan-mcp-server](https://github.com/ondata/ckan-mcp-server) (MIT), and not affiliated with onData.

**Limits.** A proof of concept with no availability promise: it may be rate-limited or taken down, and the arguments of each call (the search text, for example) are logged.

**Two things I noticed**, only if they interest you:

- In *The Dictionary of Knowledge Organization*, `fetchNotes` returned no notes for the terms I tried (for example 129, CLASS), so a tool cannot show the definitions there.
- A tool cannot find out which vocabularies a server has; it needs each address. A machine-readable list, like the page vocabularyserver.com/vocabularies, would let an assistant pick the right one.

AI assistance: prepared with Claude (Anthropic) under my direction and review.
