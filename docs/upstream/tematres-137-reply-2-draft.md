<!--
POSTED 2026-11-17 (Björn's ok): https://github.com/tematres/TemaTres-Vocabulary-Server/issues/137#issuecomment-6953272311
(the text after this comment, paragraphs unwrapped for GitHub).
Was: DRAFT reply (a comment) on tematres/TemaTres-Vocabulary-Server#137, to Diego Ferreyra's answer of 2026-11-17
(https://github.com/tematres/TemaTres-Vocabulary-Server/issues/137#issuecomment-6948976694).
Reader: Diego Ferreyra, TemaTres's maintainer, researcher in knowledge organisation at UBA.
Aim (Björn, 2026-11-17): say plainly who he is and how the work is done; answer his questions; agree on his API
designs, with what the code already has; a concrete proposal for the session-free API, the annotator's JSON and the
experiment (goal and steps).
Background from hagstrom.nu (/, /cv/, /om/) and Björn's own words. Jargon examples checked 2026-11-17 (NE, ISOF,
sv.wikipedia, Wiktionary citing SO and Carling 2005). Code claims checked against TemaTres master by Claude; the
session-free change built and measured locally by tematres-test. Reviewed (mcp-reviewer) 2026-11-17; findings applied.
Björn 2026-11-17: model runs at our cost ok; asking about Claude-made PRs ok; "a few talks"; his role as critical
reviewer, not decision maker; ask about the form of the write-up.
Before posting: Björn's ok; unwrap paragraphs for GitHub.
-->

Thank you, Diego, for the context and the warm answer. First, something I should have said at the start.

**Who you are talking to.** I have worked with open data and information management in the Swedish public sector
since 1997, at municipal, national and EU level, and am now a consultant: open data guidance, CKAN metadata catalogs,
and lately data spaces. I have given a few talks on linked data and know vocabularies at a basic level. I am not
an expert, a researcher or a developer. I set the goals and decide what is sent; the code, the reading of TemaTres's
source and much of the writing are done by Claude, working under my direction, and I read and approve everything
before it is posted. So when I write "we" below, I mean Claude and me. I could not write the PHP myself, so the PRs we
offer would be made this way, and I would like to know if that is fine with you. I say it so you know what to expect:
time, persistence and a working tool from me, while on knowledge organisation and lexicography you are the expert.
What I am good at is reviewing critically and asking questions, and I will keep doing that, but I do not want to take
over the discussion or the decisions; those are yours. Please correct me freely.

**Jargon in Sweden.** Yes, and some of it from the same years as early lunfardo:

- *ekensnack* or *söderslang*, the working-class slang of Stockholm around 1900, when most of the city's people had
  moved in from elsewhere (from the countryside rather than from abroad). It lives on in popular novels and revue songs
  of the time, a little as lunfardo does in tango and sainete;
- *knoparmoj*, the secret jargon of Stockholm's chimney sweeps, built on word games and loans from Romani; a few of its
  words, such as *brallor* (trousers), passed into everyday slang;
- the language of the Swedish travellers (*resanderomani*), which gave everyday words of Romani origin such as *tjej*
  (girl) and *lattjo* (fun);
- and today's suburban Swedish (*förortssvenska*), shaped by immigrant languages: *guss* (girl, from Turkish *kız*),
  *keff* (bad, usually traced to Arabic).

Ulla-Britt Kotsinas has written on both the old and the new, in *Stockholmsslang* (1996) and, with Dogge Doggelito,
*Förortsslang* (2004).

And your point lands: in jargon, inflection and elision are part of the play, so "recognises *chorros* as *chorro*" is
a guess the model makes, not a rule. That is one more reason for the experiment below, and for your annotator's exact
matching as the part that certifies.

**Dates and feeds.** Thank you for going through them. What we see in the code:

- `relationsSince` already exists and returns the relation tuples with a creation date (`lterm_id`, `rterm_id`,
  `relType`, `relSubType`, `created`). So your `fetchRelationsSince` may only need three things:
  - paging;
  - a stable order (date, then id). When many rows share one date, as after an import, two calls can now return
    different rows;
  - a way to report deletions. Today a deleted relation, note or term simply disappears, so no feed can show it; a
    small log of deleted rows would do.
- With a third feed, `notesSince`, and the mappings (which have their own dates), the term's own date can stay atomic,
  as you want, and a proxy can still see every change.
- A flag for `lastMod` sounds right to me: writing stays cheap, and the date is recomputed once when it is read.

We would like to send the note date in `fetchNotes` and the text-encoding fix first, as small PRs referring to this
issue. We can prepare the paging and the deletion log too, if you want them.

**The API without a session: a proposal.** `services.php` loads the configuration, which starts a PHP session
(`common/include/session.php`). So every call without a cookie gets one, and PHP's default cache limiter adds
`Cache-Control: no-store`. As far as we can see, the API path uses the session only to carry the settings during the
request. The change:

1. `services.php` sets a constant before loading the configuration. When the client sends no session cookie,
   `session.php` then skips `session_start()`, and `$_SESSION` is a plain array for that request.
2. Successful read answers get `Cache-Control: public` with a short max-age and an `ETag`, so a client gets
   `304 Not Modified` when nothing changed.
3. With a session cookie (logged in), and for login and editing, everything is as before.

We have tried it on a local copy of master: two files, about 25 lines. Without a cookie, the read calls we tested
answer the same, byte for byte, but with no cookie, a short public cache time, an ETag and `304`. Any HTTP cache in
front of the server could then do part of the work, the server would stop writing a session file for every anonymous
call, and your proxy's update script could ask with `If-None-Match` and get a `304` for whatever has not changed. We
will put it on our test instance so you can try it before we propose a PR. Does any API task need a real session that
we may have missed?

**A full SKOS file, SPARQL and ResourceSync.** I agree a SPARQL endpoint answers questions better. To me the file
does a different job: it lets someone take a copy, version it and cite "the lexicon as of date T", which is also what
your proxy does. Turtle is a good choice; it is the same SKOS, and TemaTres already exports it for admins. A JSON
version with one line per term (URI, label, notes, relations, date) would be close to your proxy file and easy to use
in a RAG pipeline. In ResourceSync terms, the file is a *resource dump*, a list of URIs with their dates is the
*resource list*, and the `…Since` feeds are the *change list*. All formats can be written in the same pass, since the
data is small, and rewritten only when the vocabulary changed. Our test instance, a plain TemaTres with the UNESCO
Thesaurus and a small script beside it, already does this hourly for RDF/XML and N-Triples, next to a small DCAT catalog
of its vocabularies, with `ETag` and `304`: `https://vocab.hagstrom.nu/dumps/catalog.jsonld`.

**Notes in the Dictionary of Knowledge Organization.** About `fetchNotes` being empty there: on a local TemaTres we
found that a note type created with a code longer than three characters stores its notes with a cut code, and in our
tests they then showed nowhere: not on the term page, in the API or in the exports. Could its definitions use such a
note type? If so, we have a small fix ready.

**Your answers.** A link to the PortalThes variant would be very welcome. Thank you for explaining "accreditation" as
attribution to a responsible subject. Then every answer should name the lexicon and its authors, not only the entry's
URI, and I will add that to the demo. On meta terms, I will follow you: node labels, as ISO 25964 has them.

**A JSON endpoint for the annotator.** It would live in your annotator, so this is only a sketch to start from, for
example a `format=json` option, with the text sent in a POST body:

```json
{
  "lexicon": { "id": "dicrodriguez", "title": "…", "responsible": "…", "date": "2026-11-17" },
  "matches": [
    { "start": 112, "end": 118, "surface": "chorro", "term_id": 2753, "uri": "…" }
  ]
}
```

`start` and `end` count Unicode characters, with the end excluded, so the assistant can quote the exact place. The URI
points to the entry, and the lexicon's date and responsible subject make the answer citable. TEI stays as it is for
editions. If it helps, we can write the matching tool on our side and test it against your endpoint.

**The experiment.** I would be glad to have researchers from your side. A first idea of what it should give:

- **Goal:** find out whether an assistant that must ground every gloss in an authoritative lexicon gives more correct
  and more checkable glosses than the same assistant alone, and whether it adds anything to your annotator, on a
  variety that models know little about.
- **What we measure**, against a gold annotation made by your researchers:
  - the right sense chosen for the annotator's marks;
  - what is found that exact matching misses (inflected and elided forms);
  - what is invented: a sense or an entry the lexicon does not have;
  - whether each claim points to an entry that exists and says what is claimed;
  - how much the answers vary between runs.
- **Four conditions:** your annotator alone; the assistant alone; the assistant with the lexicon tools; your marks
  passed to the assistant with the tools.
- **Who does what:** your side, the texts, the gold annotation and the lexicographic judgement; our side, the
  protocol draft, the tools, the scripts and the model runs, at our cost.
- **Steps:**
  1. agree on the texts (free to use, perhaps from your DraCor or tango corpus), the lexicon version and how gold is
     annotated;
  2. a pilot on one text, "Cambalache", in all four conditions, a few runs each;
  3. the annotator's JSON endpoint, so the fourth condition runs without pasting;
  4. the full run on a small corpus with at least two models, so it is not about one vendor;
  5. an open write-up together, with the data and scripts.

I think the pilot alone would show whether the rest is worth doing. What would you change? And what form would you
like the write-up to take: a report, or a paper with your team? I am not an academic, so I would leave that to you,
but if it becomes a paper I would be glad to take part, in whatever role fits my contribution.

AI assistance: prepared with Claude (Anthropic) under my direction and review.
