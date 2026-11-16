<!--
POSTED 2026-11-17 (Björn's ok): https://github.com/tematres/TemaTres-Vocabulary-Server/issues/137#issuecomment-6932808972
(the text after this comment, paragraphs unwrapped for GitHub; screenshots dragged in by Björn at [screenshot]).
Was: DRAFT reply (a comment) on tematres/TemaTres-Vocabulary-Server#137, to Diego Ferreyra's answer of 2026-11-16.
Reader: Diego Ferreyra, TemaTres's maintainer, researcher in knowledge organisation at UBA. He asked "What do you
think?" about his static-proxy architecture and pointed to his lexicon annotator.
Aim (Björn, 2026-11-16): build on his track, not beside it. Answer his question first, show something on his own
material, offer concrete help for his design, ask what we need to know.
Filled 2026-11-17 from Björn's conversation in Claude (Sonnet 5.5, connector "Tematres demo", one chat, three
questions); every quotation checked against the live lexicon through /tematres/mcp afterwards.
To do before posting:
  - [screenshot]: Björn drags in the two screenshots (answer 1; answers 2 and 3) on GitHub.
Sources: tematres-test handoffs U1-U4 and A1-A6 (ondata_extended/overlamning/, local); research reports of
2026-11-16 (proxy, annotator, research context). Reviewed 2026-11-17 (mcp-reviewer, fable); findings applied.
-->

Thank you, Diego, for such a generous answer, and for the tango! The short answer to your question: I think your
static proxy is the right direction, and I would like to build on it rather than beside it. I spent the evening on
your proposal and your annotator. Below is what I built on your material, then what I found about the proxy, and some
questions.

**Your annotator and the assistant as two halves.** As I see it, they are strong in opposite places:

| | Your annotator | An assistant with the vocabulary tools |
|---|---|---|
| Coverage | every word is checked | it looks up what it notices, and can miss some |
| Reproducibility | the same text gives the same marks | answers vary between runs |
| Inflected and elided forms | only exact headwords | recognises *chorros* as *chorro* |
| Words with several senses | one link per spelling | picks the sense from the context |
| Explanation | the mark; the reader interprets | explains and quotes the entry, follow-up questions |

Both point every claim to an entry, so together the lexicon can propose and certify, and the assistant can choose and
explain. So I added the
lexicon your annotator uses for "Cambalache" (Rodríguez's *Lexicón de 12.500 voces y locuciones lunfardas*, at
`terminologias.filo.uba.ar/apps/dicrodriguez/`) to the demo, as the vocabulary `lunfardo`. It is read live through
TemaTres's web service, at most two requests a second from each running copy of the demo, and kept only in a short
cache. Other vocabularies on that server can also be reached by their address, under the same limit. Please tell me
if you would rather it were lower, or not there at all.

Then, in Claude, I gave the assistant your annotator's 15 marks on the tango and asked three things. Every quotation
below is the lexicon's own entry; I checked them against the server afterwards.

1. *Which marks fit the sense in the tango?* Seven fit: *porquería*, *chorro*, *dublé*, *merengue*, *burro*,
   *caradura* and *Chicho* ("mafioso"). Eight do not:
   - *su* is "Hipoc. de Susana", not the possessive in "su ambición";
   - *Napoleón* is "persona de nacionalidad italiana";
   - *Mignon* is "pan de mesa de tamaño chico";
   - *la Biblia* is "(turf.) calendario de carreras de caballos";
   - *sable*, *vida* and *contra* are likewise other senses;
   - *vidriera* ("escaparate") has the right sense, but the plain Spanish one, not a lunfardo use.
2. *Which words did the annotator miss?* Inflected and elided forms of entries it has:
   - *chorros* → *chorro*;
   - *cambalaches* → *cambalache*, the title word;
   - *maquiavelos*, *amarga'os*, *manosea'os* and *aplaza'os* ("(estud.) Reprobar a un alumno en un examen", for "no
     hay aplaza'os ni escalafón").

   And it said plainly where the lexicon has no entry (*estafá'os*, *colchonero*, *polizón*, *escalafón*) instead of
   inventing one.
3. *Which sense of merengue fits "revolca'os en un merengue"?* It quoted the entry with all five senses and chose
   "asunto o cosa complicada o enredada// barullo, desorden".

[screenshot]

It is not flawless. A lookup can still take a near miss: it first matched *revolca'os* to *revolcar*, "derrotar
ampliamente a otro", and called it a false match itself. And two words were left unchecked because the demo kept to
the two-a-second limit; I have since let requests wait longer for their turn, without sending more. But every claim
points to an entry, so it can be checked.

That is your phrase made concrete, I think: the formal representation guides and checks the probabilistic process.

**Your static proxy.** Your example URL is TemaTres's own REST path (`api/fetchNotes/1/json`), so each row of the
proxy is an answer the service already gives, with its URI as provenance. That is close to ResourceSync (a list of URIs
with their dates and content) and to what Skosmos offers, a full dump next to a change feed.

While checking what such a proxy would rely on, on a local TemaTres (master `474c499`), we found that the dates do not
always move:

- adding a related-term relation or a note did not change the term's modified date;
- `fetchNotes` returns no date for a note, although the notes table has one;
- the vocabulary's `lastMod` (`fetchVocabularyData`) is recomputed at login, not when something changes;
- in the code, `termsSince` and `relationsSince` are limited by a setting (200 rows by default) with no paging, there
  is no `notesSince`, and deletions do not show.

So a proxy that compares dates can keep a stale relation or note without knowing it. I would be glad to send small
PRs that make the dates reliable, so your design can trust them: the note date in `fetchNotes`, and term and vocabulary
dates that move whenever a note, relation or mapping changes. Two more we could offer:

- the API answers carry `no-store` headers and a session cookie, so no HTTP cache or browser can keep them; a
  read-only API call could skip the session;
- a public, cached full SKOS dump per vocabulary, rebuilt when the vocabulary changes, with a setting to turn it off.
  That would be your proxy built into TemaTres, in a format any SKOS tool reads, with the relations as data.

There is also a small text-encoding issue in the exports that I would like to fix in a PR.

**Reproducibility.** A versioned copy also answers a worry you raised about language models, that their answers cannot
be reproduced. If every term in an answer carries its URI and the copy carries a date, an answer can say "according to
lexicon X, entry Y, as of date T", and anyone can check it later.

**Questions for you:**

1. Could you share a sample of your proxy file, and the script that updates it? Which calls do you cache per term, and
   how do you handle relations and deletions?
2. What does "accreditation" mean for you here: attribution to the authoritative URI, rights, or a guarantee that the
   value is current?
3. Would you consider a JSON endpoint for the annotator? Then the assistant could call it as a tool, and your marks
   would be its first step instead of a pasted text.
4. How would you like meta terms to appear in SKOS? Today they are plain `skos:Concept`, so an assistant takes a guide
   heading for a concept. A `skos:Collection` is one option; you know the trade-offs better.
5. If you find it interesting, a small joint experiment: how often an assistant gets terms right with and without the
   vocabulary, measured against the vocabulary itself, perhaps on one of your Rioplatense lexicons, where models
   probably know least.

For trying it in Claude: the demo address is the same,
`https://ondata-extended-services.ondata-extended.workers.dev/tematres/mcp`; in a chat, name the connector and the
lexicon ("Use the TemaTres demo, vocabulary lunfardo: …"). ChatGPT and other assistants that accept an MCP server
by its address should work too, though I have only tried Claude.

AI assistance: prepared with Claude (Anthropic) under my direction and review.
