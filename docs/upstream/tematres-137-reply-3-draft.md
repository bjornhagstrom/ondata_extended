<!--
POSTED 2026-11-19: https://github.com/tematres/TemaTres-Vocabulary-Server/issues/137#issuecomment-7008561221
(body posted with paragraphs unwrapped; otherwise as below).
DRAFT reply (a comment) on tematres/TemaTres-Vocabulary-Server#137, to Diego Ferreyra's answer of 2026-11-18 12:25 UTC
(https://github.com/tematres/TemaTres-Vocabulary-Server/issues/137#issuecomment-6978491901).
Reader: Diego Ferreyra, TemaTres's maintainer, researcher in knowledge organisation at UBA.
Aim (Björn's pace rule): short; answer his questions; no new proposals beyond what he asked or we already offered;
the line on earlier PRs (E8.1, decided by Björn 2026-11-18).
TemaTres points from tematres-test's log line "Diegos svar 2" (2026-11-18, tematres-test/overlamning/
2026-11-17-fran-ondata_extended-diegos-svar-137.md): order by date then id in the new feeds; private notes (NP) kept
out of notesSince; fix/since-order offered; the note-type bug is the code, not the label; ask which note type
diccioko's definitions use; the dump scripts read the database, not the API. No date is promised for the
session-free API PR.
Checked by Claude 2026-11-18: nothing in ondata_extended calls relationsSince or termsSince (the rename does not
affect us); the tematres endpoint reaches vocabularyserver.com, terminologias.filo.uba.ar and vocab.hagstrom.nu
(TEMATRES_ALLOWED_DOMAINS); the vocab_* tools only read.
Open for Björn: (1) how to give Diego your email address ([EMAIL] below); (2) whether to offer the dump scripts as a
small separate repository (the bracketed paragraph; tematres-test's suggestion, nothing built).
Reviewed (mcp-reviewer) 2026-11-18, without access to Diego's comment; applied: the note bug says which side is cut,
"no more than three", the fix described as one change (the delete guard left to tematres-test's PR), limits on all
three tasks, [EMAIL] made a posting blocker. Not done: the reply-2 promise to name the lexicon and its authors in
every answer was not built then; built 2026-11-18 (uncommitted at the time), claimed only once deployed.
Second review pass applied: wording (result limit, the schedule, "at most three", "That leaves open"); the
fetchNotes half of the private-notes claim dropped (not confirmed here).
Before posting: review, Björn's ok. Björn 2026-11-18: may go out this evening, once ready. The
sentence on the source line holds only after the change is deployed. Björn's email and the scripts paragraph settled
(Björn 2026-11-18); the AI-rules paragraph added at his request. Unwrap paragraphs.
-->

Thank you, Diego.

**Feeds.** `date_create` is fine; our tools do not read `relationsSince`. Yes to the three new tasks for notes,
internal and external mappings. Two small things:

- sort them by date and then by id from the start. When many rows share one date, as after an import, the result
  limit (200 by default) can otherwise pick different rows from one call to the next. We have that change ready for
  `termsSince` and `relationsSince`, if you want it;
- keep private notes out of `notesSince`, as the SKOS export does.

**The API without a session.** Glad it fits the RSS idea. We will come back with it as a small PR.

**The catalog and the dumps.** I agree with B. Ours is close to it: a script outside TemaTres runs on a schedule and
rewrites the files only when the vocabulary has changed, so TemaTres itself writes nothing to disk. I am glad you want to try it on
terminologias.filo.uba.ar.

If useful, we can put the scripts in a small repository of their own. Today they read the database directly; to
gather vocabularies from other servers, as you describe, they would need to read the API or the SKOS export instead.

**Notes.** Sorry, I was unclear: it is the note type's code, not its label. A note type can be created with a code
longer than three characters, but its notes are saved with the code cut to three. They then no longer match their type
and show nowhere: not on the term page, in the API or in the exports. Your example works because its code has no more
than three characters. Our fix keeps new codes to at most three characters. That leaves open why `fetchNotes` is empty in
the Dictionary of Knowledge Organization: which note type do its definitions use?

**Email and a meeting.** Yes, gladly. You can write to me at bjorn@hagstrom.nu.

**The three tasks.** Yes, I think so. In all three the answers can vary between runs and miss things, so they need
checking, and the third has one more limit:

1. *Describe a term:* this is what the tools do now: the entry with its notes, relations and URI.
2. *Classify a text:* the model reads the text, searches the vocabulary and names concepts by URI, so every label it
   gives can be checked against an entry that exists.
3. *Extract new terminology:* the model can propose candidate terms, check with the tools that the vocabulary lacks
   them, and suggest where each might fit. Whether a candidate becomes a term stays with the editor; the tools only
   read.

The endpoint already reaches the lunfardo lexicon on terminologias.filo.uba.ar, the vocabularies on
vocabularyserver.com and our test instance. As promised, every answer now ends with its source: the lexicon,
its author and its URI, as the vocabulary itself gives them. I would be glad to hear what works and what does not.

The earlier PRs, from #108 on, were made the same way: with Claude, under my direction and review. Thank you for
merging #139 and #140.

Projects differ in how they want AI use disclosed. If you have a preference, a few lines in a `CONTRIBUTING.md` would
help everyone, for example:

- whether AI use must be stated, and where (a line in the PR text, or a commit trailer);
- that the person who opens the PR has read, tested and answers for every line;
- small PRs with one purpose each, which are easier to review whoever wrote them.

AI assistance: prepared with Claude (Anthropic) under my direction and review.
