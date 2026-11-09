# De-risking: the TemaTres web service API against begrepp.hagstrom.nu

Date 2026-11-09. Instance: `https://begrepp.hagstrom.nu`, TemaTres 3.6.1, web service 2.1, vocabulary
"Svada - termer och begrepp", language `sv`, 39 terms (`fetchVocabularyData` → `cant_terms`). Source compared:
`tematres-test/uppstrom-utkast/upstream` at commit `9be0b0a`, `common/include/fun.api.php`, `vocab/xml.php`.
All calls are GET requests to the public read-only instance, made with curl. No code written.

## Endpoint and envelope

- API: `GET /services.php?task=<task>&arg=<arg>&output=json`. (Not `/vocab/services.php`, which returns 404.)
- Success: `{"result": {...}, "resume": {"status","param":{task,arg},"web_service_version","version","cant_result"}}`.
- **`result` is an object keyed by id, not a list.** Order is carried by the `order` field where present (search,
  suggestDetails, fetchUp), otherwise by key order in the JSON (fetchDown is alphabetical). **Pitfall found by the
  tests:** `JSON.parse` orders integer-like keys ascending, so a plain `Object.values(result)` returns id order and
  silently loses the service's order. The adapter rewrites the id keys before parsing to keep document order.
- **No hits / unknown id**: HTTP 200, *no* `result` key, `cant_result: 0`. Applies to search, fetchTerm (id 99999),
  fetchURI, fetchTargetTerms and others. The adapter must tell "no hits" from "concept does not exist" itself
  (for fetchTerm: 0 = does not exist).
- **Invalid task**: HTTP 200, `text/xml`, an XML help page with `<error><message>invalid task param</message>`,
  **despite `output=json`**. The adapter checks the content type and treats XML as an error.
- Without `output=json` the response is XML (`text/xml;utf-8;charset=UTF-8`, note the malformed content-type string).
- **Types differ between tasks**: `term_id` is a number in `search` but a string elsewhere; `isMetaTerm` is `0`/`1`
  (number) in search, `"0"`/`"1"` (string) in fetchTerm/fetchUp, `null` in suggestDetails. Normalize in the adapter.

## Task by task

| Task | Probe | Shape | Notes |
|---|---|---|---|
| `fetchVocabularyData` | – | `result` = flat object (title, author, lang, uri, createDate, lastMod, status, cant_terms …) | `uri` = `https://begrepp.hagstrom.nu/` = ConceptScheme URI |
| `fetchTopTerms` | – | 3 terms (35, 36, 34), all `isMetaTerm:"1"` | The top level consists only of meta-terms (groupings) |
| `search` | `data` → 13, `zzzqqq` → 0 | `{term_id,string,isMetaTerm,no_term_string,index,order}` | `no_term_string` = matched altLabel or `false`; `index` = path `|36|10` |
| `suggestDetails` | `da` → 13 | like search, without `index` | Also matches altLabels |
| `fetch` | `Dataområde` → id 2 | exact term → id | Good for "lookup label" |
| `fetchSimilar` | `dataomrade` → `{"string":"dataområde"}` | **one string, no id** | "Did you mean"; needs a follow-up `fetch` |
| `fetchTerm` | 2 | `{term:{term_id,tema_id,code,lang,string,isMetaTerm,date_create}}` | |
| `fetchTermFull` | 2 → 0 hits | – | **Empty stub in upstream code** (`fun.api.php:1039-1042`: `break` with no call). Unusable; the adapter composes the full concept itself |
| `fetchUp` | 10 → [36, 10] | path from the top *including the term itself*, `order` 1..n | Gives `concept_path` directly |
| `fetchDown` | 36 → 6 | `relation_type:"NT"`, `relation_type_id`, `relation_code/label` (sub-relations), `hasMoreDown` | |
| `fetchRelated` | 2 → 4 | `relation_type:"RT"` | |
| `fetchAlt` | 2 → `dataspace` | `relation_type:"UF"` | `lang` is inherited from the term: English altLabels are tagged `sv` (data quality in the instance, not an API bug) |
| `fetchNotes` | 2 → 1 note | `{note_id,note_type:"DF",note_lang,note_text}` | **`note_text` is HTML** (`<h4>`, `<p>`, `<ul>`, links). Convert to text and treat as untrusted content |
| `fetchDirectTerms` | 10 | all direct relations (here RT) | |
| `fetchRelatedTerms` | `2,4` | union of related, id+string only | |
| `fetchCentralTerms` | – | `{term_id,string,width}` | |
| `fetchLast` | – | most recently created, with `date_create/date_mod` | The instance contains the test term `test2` (id 54) |
| `fetchTargetTerms`, `fetchSourceTerms`, `fetchURI` | 2; fetchURI tried for ids 1–45 | 0 hits everywhere | **The instance has no mappings.** The mappings tool can only be tested with fixtures |
| `fetchCode` | `X` → 0 | – | Calls `fetchTargetTermsById` in the source (`fun.api.php:1050-1053`), looks like an upstream bug; avoid |
| `letter` | `d` | mixes preferred and alt (`relation_type_id:"4"` + `no_term_string`); keys are the *alt term's* id | Not needed for the MVP |

## Found while building the adapter

- **`fetchDirectTerms`** returns all direct relations of a term in one answer: `BT`, `RT` and `UF`
  (`relation_type_id` 3, 2, 4). The adapter uses it for broader, related and altLabels.
- **`isMetaTerm` in `fetchDirectTerms` is the queried term's flag, not the related term's.** Term 10's broader term 36
  is a meta-term (`fetchTerm&arg=36` → `"1"`), but `fetchDirectTerms&arg=10` reports `"0"` for it. Cause in the
  source: `fun.api.php:149` returns `$array["isMetaTerm"]`, which `SQLverTerminoRelaciones` (`fun.sql.php:719-754`)
  selects as `tema.isMetaTerm` (the queried term); the related term's flag is selected as `BT_isMetaTerm` but not
  returned. Probable upstream bug; a one-line candidate for the TemaTres contributions. The adapter does not read
  the flag from these rows.
- **`lang` in relation rows is the vocabulary's language** (`c.idioma`), not the term's: the same reason English
  alternative labels come out as `sv`.
- **`fetchUp` rows have no `lang`**, and `fetchUp` for a top term returns nothing; the adapter then uses the term
  itself as its path.
- **Notes are keyed by note id** (same ordering pitfall as above) and carry `note_src`.
- **Target terms** (`fetchTargetTerms`, from `fetchTargetTermsById`) carry `string`, `url`, `uri` and the target
  vocabulary's label, tag and title, but no SKOS mapping property; the adapter reports them as type `unknown`.
  `fetchURI` rows carry `link_type` (`uri_value`) and `link`; a `link_type` that names a SKOS mapping property is
  used as the type.

## SKOS export (`xml.php`)

- The parameter is `schema` (+ `term_id`), not `skosTema`: `xml.php?schema=skos&term_id=2`. Without `term_id` the
  body is empty (HTTP 200, 0 bytes). The whole vocabulary (`dis=rfile`) requires login (`xml.php:29`).
- `schema=skos&term_id=N`: RDF/XML with the ConceptScheme + one `skos:Concept rdf:about="https://begrepp.hagstrom.nu/skos/N"`,
  `prefLabel`, `altLabel`, `definition` (HTML stripped to text), `broader`, `related`, `inScheme`, `dct:created`.
  No `topConceptOf` for concepts under meta-terms.
- `skosMeta=1`: ConceptScheme with `hasTopConcept` (35, 36, 34). `skosNode=N`: as above for one node.
- **Unknown id** (`term_id=99999`): HTTP 200 with an *empty* Concept `rdf:about=".../skos/"` and empty `prefLabel`. No error.
- `schema=jsonld&term_id=N` is **broken JSON-LD**: prefLabel is under the key `"@value="` (with an equals sign), the
  definition uses `"@lang"` instead of `"@language"`, and the `dct:` prefix is missing from `@context`. Readable as
  plain JSON but not interpretable as JSON-LD. Worth an upstream report, and a reason not to build on it.
- `schema=json&term_id=N`: TemaTres' own JSON (`tema_id`, `string`, `notes[]` as text without HTML).

## Conclusions for the adapter

1. **JSON via `services.php` is the primary path.** It avoids an XML parser in the Workers bundle (architecture
   proposal, section 8). **Concept URIs are instance configuration, not a TemaTres constant** (`_URI_BASE_ID` +
   `_URI_SEPARATOR_ID` + id, `fun.xml.php:312-323`; default `CFGURL` + `xml.php?schema=skos&term_id=`). This instance
   uses `https://begrepp.hagstrom.nu/skos/`, declared in the vocabulary registry. For an unknown instance the adapter
   reads the pattern once from `xml.php?skosMeta=1` (first `hasTopConcept`), else uses the default. (Corrected after
   review: an earlier version hard-coded `skos/` and claimed a contract test that did not exist.)
2. `get_concept` is composed from `fetchTerm` + `fetchAlt` + `fetchNotes` + `fetchUp` + `fetchDown` + `fetchRelated`
   (+ `fetchTargetTerms`/`fetchURI` for mappings): six to eight calls per concept, in parallel and cached.
   This is the main performance question for the MVP.
3. Note types map `DF`→`definition`, `NA`→`scopeNote`, `NH`→`historyNote`, `NB`→`note` etc.; unknown types pass
   through in `ext.notes` with their TemaTres type. HTML in notes becomes text and is marked as untrusted content.
4. Meta-terms (`isMetaTerm`) are closest to `skos:Collection`/grouping; in the MVP they are shown as concepts with
   `ext.tematres.isMetaTerm: true` and one sentence in the tool description. Revisit if a Skosmos adapter shows otherwise.
5. Error classification in the adapter: XML content type or missing `resume` = protocol error; `cant_result:0` on an
   id lookup = "does not exist", with a hint pointing to `vocab_search_concepts`.
6. The smoke file is built on named concepts: Dataområde (2, altLabel dataspace, definition, 4 RT),
   Dataägare (10, broader 36), Stadens roller (36, 6 NT). Mappings are covered by fixtures only.
