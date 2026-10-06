# Project Knowledge Base — Content Factory

A deep-reference document covering every module in this repo: what it does,
why it's built the way it is, and the engineering concepts it demonstrates.
Written for two purposes — (1) so future-you (or anyone else) can pick this
project back up without re-deriving context, and (2) as interview-prep
material for discussing RAG, agentic AI systems, and data pipeline
engineering.

> **⚠️ Partially superseded.** §3 below (`generate-long-post.mjs` /
> `run-batch.mjs`, the Claude/Gemini/OpenAI API-key agentic batch generator)
> describes a pipeline that **has since been removed**. It was replaced by
> `Automation/long-post-runner/run_pipeline.py` — a free, key-free
> browser-automation approach driving DeepSeek's web chat via Playwright —
> because keeping two separate generation pipelines side by side was more
> confusing than useful. See `Automation/long-post-runner/README.md` and
> `Automation/core/README.md` for what actually runs today. §1–2 (content
> types, the block-tag contract) and §4 (the NCERT RAG corpus — BM25,
> Kruti-Dev decoding, the Unicode `\p{M}` bug) are still accurate; only the
> *generation* mechanism in §3 changed, not the corpus or content contract.
> Folder paths throughout (`automation/`, `ncert-knowledge-base/`,
> `Notes-Automate/`) also predate a folder-structure rename — the current
> layout is `Automation/{core,ncert-knowledge-base,long-post-runner}/`.

---

## 1. What this repo is

A set of tools that generate exam-prep study content (in Hindi/English —
"Hinglish") for a WordPress site, aimed at Indian
government-exam aspirants (CTET, BPSC TRE, DSSSB, UPTET, KVS, NVS, and
similar teacher-recruitment exams). Three content pipelines exist, each a
progressively more automated version of the same idea: **produce an article,
get it onto WordPress as a draft, review, publish.**

| Tool | Content type | Automation level |
|---|---|---|
| `question-factory/` | MCQ question banks | Browser tool + free chat AI (manual copy/paste) |
| `notes-factory/` | Standard exam notes | Browser tool + free chat AI, one-tap GitHub save |
| `long-post-factory/` | Long-form (6,000–8,000 word) SEO articles | Browser tool + free chat AI (manual), **or** fully automated via `automation/` (this session's work) |

All three share one underlying pattern regardless of automation level:

```
generate content (AI)  →  <slug>.json dropped into pending-*/
        │
        ▼  (GitHub Actions workflow, triggered by the push)
   POST to WordPress REST API as a DRAFT
        │
        ▼
   file moved to published-*/ with the new post's id + link
```

The site is **static** (GitHub Pages) — nothing served to a browser may ever
contain a secret. WordPress credentials live only as GitHub Actions
encrypted secrets. This constraint is why the whole system is shaped the way
it is: the "hard" parts (calling AI APIs with a key, publishing to
WordPress) either happen in GitHub Actions (server-side, secrets available)
or — for this session's new pipeline — on your own machine (local secrets,
never in the repo at all).

---

## 2. Long Post Factory — the content contract

`long-post-factory/index.html` is the browser tool this session's
automation extends. Understanding its contract is essential, because
`automation/generate-long-post.mjs` reproduces it exactly so both paths
produce interchangeable output.

### 2.1 The exam-persona system

`EXAM_PROFILES` (a lookup table keyed by exam name — `ctet`, `bpsc tre`,
`dsssb tgt`, etc.) supplies a **persona** ("a veteran CDP & Pedagogy faculty
member who has coached 10,000+ CTET aspirants..."), a **subject scope**, and
an **angle** (exam-specific framing notes) for whichever exam is typed.
`getExamProfile()` does substring matching against the longest keys first
(so `"dsssb tgt"` matches before the generic `"tgt"` does), and
`genericExamProfile()` synthesizes a plausible persona for any exam name not
in the table — so the tool never refuses an unrecognized exam, it degrades
gracefully to an honest, uncertain-where-appropriate persona.

### 2.2 The block-tag system

Instead of having the AI hand-write styled HTML for every card (definition
boxes, tips, mistakes, questions...), the prompt has it write lightweight
markers:

```
{* type: Title text *}
...plain content...
{* END *}
```

`expandLongPostBlocks()` (in `parse-reply.mjs`, ported from
`long-post-factory/index.html`) turns each block into styled HTML via a
lookup table of renderer functions (`BLOCK_RENDERERS`). This halves the
output tokens an AI needs to spend on a run, since it never writes
`<div style="background:#f8fbff;border-left:6px solid...">` by hand — a real
token/cost optimization, not just a code-cleanliness one. A dropped
`{* END *}` auto-closes at the next marker rather than corrupting output —
the parser is deliberately fault-tolerant.

### 2.3 The output contract

Every generation must produce three sentinel-delimited sections:

```
<<<SEO_JSON>>> ... <<<END_SEO_JSON>>>          — focus keyword, title, slug, meta description, etc.
<<<NOTES_BODY_HTML>>> ... <<<END_NOTES_BODY_HTML>>>  — the block-tagged article body
<<<PUBLISHER_NOTES>>> ... <<<END_PUBLISHER_NOTES>>>  — self-reported word count, sources, density stats
```

`parseResponse()` extracts each piece independently, trying multiple
fallback strategies per piece (a strict sentinel match, then a loose
`json fence` scan, then a label-text scan) — because different AI models (or
the same model on different days) wrap output slightly differently, and
requiring one strategy to match *all three* pieces at once breaks the moment
any single piece drifts format. This resilience-by-independent-extraction
pattern is worth remembering: **don't couple unrelated parse failures.**

### 2.4 Hard requirements baked into the prompt

- **6,000–8,000 prose words**, non-negotiable, with a mid-generation
  self-checkpoint (`[[WC: <number>]]` markers) so the model catches a
  shortfall before it's too late to fix, not after.
- **Rank Math SEO 90+ gate**: keyword density 1.0–1.4%, keyword in ≥3 H2s,
  ≥6 inline citations, ≥7 internal + ≥3 external links, a fixed word-budget
  table across 9 sections.
- **A "silent seed"** derived from `topic + examType` (a simple character-sum
  hash) picks which headline formula, lede type, misconception style, and
  FAQ position to use — deterministic per topic (same topic always gets the
  same seed), but varies output structure *across* topics so 50 articles
  don't all read identically templated.

---

## 3. `automation/` — the batch generation pipeline (this session's build)

**The problem this solves**: the browser tool is one-topic-at-a-time,
requires manually pasting into a chat AI and pasting the reply back. To
publish dozens of articles across an exam's full topic list, you'd do that
loop by hand dozens of times. `automation/` replaces the "paste into chat,
paste back" step with a direct, agentic Claude API call — batched over a
whole topic list, with NCERT-grounded research and a resumable/cooldown-
respecting runner.

**Runs on your machine only.** This is a deliberate architectural
constraint: the Claude API key must never be committed to git or exposed on
GitHub Pages, and you wanted to rotate/change keys freely (including
free/rotating credentials). GitHub Actions secrets don't fit that — they're
static per-repo config, not something you swap per run. So generation
happens locally; only the *output* (the same `pending-long-posts/<slug>.json`
shape the browser tool produces) gets pushed, and the existing
`pub-lpost.yml` workflow (unchanged) picks it up from there.

### 3.1 Module map

```
prompt-builder.mjs        exam-persona table + buildLongPostPrompt() — ported verbatim
                           from long-post-factory/index.html; the single source of truth
                           for the output contract (both pipelines must agree on it)

parse-reply.mjs            extractSEO / extractBody / expandLongPostBlocks / parseResponse
                           — also ported verbatim; turns a raw AI reply into the same
                           {seo, bodyHtml, publisherNotes} shape the manual tool produces

prompts/research-writer-system.md   the persona + agentic-grounding-discipline system
                                     prompt (see §3.2) — edited as prose, not code
prompts/self-check.md               the accuracy-audit prompt for the second Claude call

generate-long-post.mjs     the actual per-topic worker (see §3.2 and §4)
run-batch.mjs               CLI: loops topics.json, calls generate-long-post.mjs per
                             topic, writes the pending JSON, commits + pushes, cools down
topics.json                 the checklist you author: [{exam, topic, subject,
                             hindiPercent, status, slug, error, attempts}]

retrieve.mjs                 BM25 search over the NCERT corpus (see §4)
build-index.mjs               builds ncert-index.json from ncert_corpus.csv

extract_ncert_text.py         unzips book-library/*.epub|zip, pulls raw chapter text
decode_krutidev.mjs            fixes legacy font encoding → real Unicode (see §4.3)
organize_ncert_corpus.py       cleans + groups chapters by subject, writes the CSV
verify_corpus.py               data-quality gate: word counts, Devanagari density, cross-checks
rebuild-corpus.mjs             orchestrates all five corpus-pipeline steps in one command
```

### 3.2 Why generation is *agentic*, not a single prompt

`generate-long-post.mjs`'s `runAgenticDraft()` doesn't pre-fetch context and
stuff it into one prompt (that's "naive RAG" — a preprocessing step). It
gives Claude two **tools** inside a proper tool-use loop:

- `search_ncert(query, subject?)` — a client-side tool; the loop intercepts
  the model's `tool_use` block, calls `retrieve()` locally, and feeds the
  result back as a `tool_result` message before continuing.
- `web_search` — Anthropic's server-side tool (type `web_search_20250305`);
  the API executes it and returns results within the same turn, no
  client-side handling needed.

The model decides *when* and *what* to search, section by section, as it
writes — driven by `prompts/research-writer-system.md`'s explicit
instruction to verify a claim via `search_ncert` before stating it, and to
use `web_search` for anything time-sensitive (current exam cycle, recent
policy). The loop (`for turn < MAX_AGENT_TURNS`) keeps calling
`client.messages.create()` and resolving tool calls until `stop_reason`
isn't `'tool_use'` anymore — i.e. the model has finished writing.

### 3.3 The self-check pass — an LLM-as-judge guardrail

After drafting, `runSelfCheck()` makes a **second, independent** Claude call:
given the finished draft body *and* the exact NCERT chunks that were
retrieved while writing it, the model is asked (via `prompts/self-check.md`)
to flag any claim that contradicts or isn't supported by those chunks —
outputting a structured `<<<SELF_CHECK_JSON>>>` verdict (`clean`, a `flags`
array with `issue`/`suggestedFix`/`needsManualReview`). Flags get appended to
the bundle's `publisherNotes` for manual review rather than silently
auto-editing the article. This is a real, nameable production pattern:
**using a second model call as a verifier**, cheaper and more scalable than
requiring a human review pass on every single article.

### 3.4 `run-batch.mjs` — the operational loop

Reads `ANTHROPIC_API_KEY` from the environment only (`requireEnv()` — exits
loudly if unset, never prompts-and-stores). For each `pending`/`failed` topic
in `topics.json`:

1. mark it `running`, increment `attempts`
2. call `generateOne()` (§3.2 + §3.3)
3. write `pending-long-posts/<slug>.json`
4. `git add` + `git commit` + `git push` immediately (so `pub-lpost.yml`
   starts drafting to WordPress right away, not batched at the end)
5. sleep `COOLDOWN_SECONDS` (default 120s) before the next topic
6. on any failure, mark the topic `failed` with the error message and move on
   — one topic's failure never aborts the batch

This makes the whole run **resumable**: killing the process (Ctrl+C) and
re-running `node run-batch.mjs` only reprocesses topics still `pending` or
`failed` — already-`done` topics are skipped, and a topic that's failed
`MAX_RETRIES` times (default 2) is skipped with a log line instead of
retried forever.

---

## 4. The NCERT RAG corpus — how it was actually built

This is the part with the most genuinely instructive engineering content:
the "hard" parts weren't the AI, they were data cleaning.

### 4.1 The retrieval method: BM25, deliberately not embeddings

Two ways to build a search index:

- **Dense (embeddings)**: turn each chunk into a vector via an embedding
  model API call, then rank by cosine similarity. Catches semantic
  similarity ("photosynthesis" ↔ "how plants make food") even with zero
  shared words. Costs an API call per chunk indexed *and* per query, needs a
  vector store.
- **Sparse (BM25)**: score chunks by term-frequency statistics — no AI call
  at all, pure math over word counts. Misses semantic-only matches, but
  needs zero API key and zero cost.

This project uses BM25 (`build-index.mjs`, `retrieve.mjs`) — a deliberate
trade-off given the "never require a paid/rotating key just to search my own
corpus" constraint, and because NCERT-topic queries tend to share vocabulary
with the source text (a student query about "कोशिका" will find chapters that
literally say "कोशिका"). **BM25 mechanics**, worth being able to explain:

```
score(query, doc) = Σ over query terms:
    idf(term) × [ tf(term, doc) × (k1 + 1) ]
                ─────────────────────────────────────────────
                [ tf(term, doc) + k1 × (1 − b + b × |doc| / avgDocLen) ]
```

- `idf` (inverse document frequency): a term that appears in few documents is
  more informative than one appearing in most of them.
- `k1` (term-frequency saturation, 1.5 here): caps how much repeating a term
  within one document keeps helping its score — the 50th occurrence barely
  adds more than the 10th did.
- `b` (length normalization, 0.75 here): a term appearing once in a short
  chapter is weighted more than once in a very long one, so long documents
  don't win purely by being long.

### 4.2 The corpus-building pipeline (five stages)

```
book-library/*.epub, *.zip
        │  extract_ncert_text.py
        ▼   unzips each archive (each "book" is a zip of one mini-epub
        │   per chapter, e.g. Science/5451_1.epub .. 5451_18.epub);
        │   opens each inner epub as its own zip, strips HTML tags with
        │   BeautifulSoup, writes raw chapter text
        ▼
ncert-corpus/_raw/<book>/chNN.txt   (gitignored — copyright-sensitive, large)
        │  decode_krutidev.mjs
        ▼   see §4.3
        ▼
ncert-corpus/_raw/<book>/chNN.txt   (same files, now real Unicode Devanagari)
        │  organize_ncert_corpus.py
        ▼   strips repeated running headers/page numbers (any line
        │   repeated ≥4 times and <60 chars is noise, not content);
        │   guesses subject from the folder name; writes both outputs:
        ▼
ncert-corpus/by-subject/<Subject>/<book>__chNN.txt   (COMMITTED — canonical corpus)
ncert-corpus/ncert_corpus.csv                         (gitignored, derived convenience export)
        │  build-index.mjs
        ▼   tokenizes every chunk, builds term-frequency + document-
        │   frequency tables
        ▼
ncert-index.json   (COMMITTED — the BM25 index retrieve.mjs actually queries)
        │  verify_corpus.py
        ▼   data-quality gate (§4.4)
        ▼
        pass/fail report
```

One command runs the whole chain: `node rebuild-corpus.mjs`. It's
**idempotent** — `extract_ncert_text.py` and `organize_ncert_corpus.py` both
clear their own output directory before regenerating, so removing a book
from `book-library/` doesn't leave an orphaned stale chapter file behind on
the next run. This matters for reproducibility: the corpus is always a
faithful function of what's currently in `book-library/`, never an
accumulation of past runs.

### 4.3 Bug #1 — legacy glyph-font encoding (Kruti Dev)

The downloaded NCERT epubs (sourced from `upschub.com`, an older
digitization) don't store Hindi text as real Unicode. They use a legacy
approach common in older Indian government documents: text is stored as
ASCII bytes that only *display* as Devanagari when rendered in one specific
proprietary font ("Kruti Dev" / "DevLys" style — each Latin character maps
to a Devanagari glyph purely as a font's visual rendering trick). Extracted
as plain text (ignoring the font), it comes out as unreadable soup:

```
ikniksa esa iks"k.k  →  (should read) पादपों में पोषण  ("Nutrition in Plants")
```

**How it was diagnosed**: not by assuming the extraction script was buggy,
but by testing a real query (`retrieve('photosynthesis...')`) and noticing
the *results* were nonsense, then inspecting the raw extracted text directly
and recognizing repeating tokens (`esa`, `gSa`, `osQ`) as a known signature
rather than random garbage.

**How it was fixed**: rather than hand-writing a Kruti-Dev→Unicode mapping
table (a genuinely error-prone task — matra reordering and conjunct rules
are non-trivial), the fix was finding an existing, tested library —
`@anthro-ai/krutidev-unicode`, a JS port of `kru2uni`, a converter built by
IIIT-Hyderabad's Language Technologies Research Centre — and verifying it
against the actual corrupted sample before wiring it in
(`decode_krutidev.mjs`, applied to 297 of 298 files; auto-skips anything
already real Unicode). **The lesson**: recognize when a problem is a solved
one elsewhere, and verify a candidate solution against your real data before
trusting it, rather than reimplementing it from first principles.

### 4.4 Bug #2 — the Unicode property-class regex bug

After fixing the font encoding, a specific query (`कोशिका जीव विज्ञान` — "cell
biology") returned *nothing*, even though `grep` confirmed "कोशिका" appears
19–43 times across multiple chapters. The bug was in `tokenize()`:

```js
// WRONG — silently destroys Devanagari vowel signs
text.replace(/[^\p{L}\p{N}\s]/gu, ' ')

// RIGHT
text.replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
```

`\p{L}` is the Unicode "Letter" category. Devanagari vowel signs (matras
like ो, ि, ा) are category **Mark (`\p{M}`)**, not Letter — a base consonant
plus its vowel sign are two separate codepoints combined visually, and only
the base consonant is a "Letter." Without `\p{M}` in the allowed set, the
regex treated every matra as punctuation to strip, shredding words:
`कोशिका` (6 codepoints: क+ो+श+ि+क+ा) became `क श क` (3 bare consonants) —
each fragment too short to pass the `length > 1` filter, so it vanished from
the index entirely. **This is a bug class worth knowing by name**: assuming
Unicode "Letter" covers everything script-relevant is a common mistake for
any script that uses combining diacritics (Devanagari, Thai, many Indic and
Southeast Asian scripts, plus combining accents in Latin script itself).

**How it was found**: isolated `tokenize()` and tested it directly against
the failing query string outside the full pipeline — `console.log` on a
10-line reproduction, not staring at 46,000 indexed terms trying to guess.
After the fix, unique indexed terms went from 8,112 (shredded consonant
fragments — a small, degenerate vocabulary) to 46,252 (real words) — that
count alone was a strong signal the fix was structurally correct, before
even re-testing retrieval quality.

### 4.5 The data-quality gate: `verify_corpus.py`

Rather than eyeballing 298 files, this script automates three checks per
chapter (word count ≥100, Devanagari density ≥50%, no leftover Kruti-Dev
signature words) plus three cross-checks (by-subject file count == CSV row
count == index doc count; every raw book folder represented in the CSV).
Current corpus: **298 chapters, 9 subjects, 1,155,170 words, 0 flagged
files, all cross-checks pass.** This is the same instinct as a CI test suite
applied to a data pipeline instead of code — an automated gate you run after
every corpus change, not a one-time manual spot-check.

---

## 5. Reporting dashboard

`reporting/index.html` — a static page (same self-contained-HTML pattern as
every other tool in this repo) that fetches `automation/topics.json` (batch
status) and `published-long-posts/index.json` + per-slug files (what's
actually live), and renders a searchable/filterable table: topic, exam,
status, NCERT citation count, self-check clean/flagged, publish date, draft
link. No secrets involved — safe to host on GitHub Pages like everything
else. `published-long-posts/index.json` is maintained additively by
`pub-lpost.yml` on every successful WordPress draft creation (a
small `jq` append in the workflow's existing success path), since GitHub
Pages can't directory-list and the dashboard needs *some* file telling it
which slugs exist.

---

## 6. Security model — where secrets can and can't live

| Secret | Lives where | Never appears in |
|---|---|---|
| `WP_SITE_URL` / `WP_USERNAME` / `WP_APP_PASSWORD` | GitHub Actions encrypted secrets | any HTML/JS file, any commit |
| `ANTHROPIC_API_KEY` | your shell's environment variable, for that session only | any file, any commit, any log |

Only two functions in the entire `automation/` codebase ever touch the
Anthropic key (`generateOne()`'s two `client.messages.create()` calls) — the
corpus-building pipeline (extraction, decoding, organizing, indexing,
retrieval) is deliberately kept 100% key-free, both to minimize the blast
radius of what needs a secret and because you wanted to rotate/change the
key freely without re-touching more code than necessary. `run-batch.mjs`
calls `requireEnv()`, which exits with a clear error if the key is unset —
it never prompts for one interactively and writes it anywhere, by design.

---

## 7. Directory map (as of this document)

```
Notes-factory/
├── question-factory/          MCQ tool (browser, self-contained)
├── notes-factory/              standard notes tool (browser, one-tap GitHub save)
├── long-post-factory/          long-form article tool (browser) — the prompt/parse
│                                contract automation/ ports and extends
├── automation/                 THIS SESSION'S BUILD — batch generation + NCERT RAG
│   ├── book-library/            ← add more .epub/.zip books here over time (gitignored)
│   ├── ncert-corpus/
│   │   ├── by-subject/           COMMITTED — canonical corpus (298 chapters, 9 subjects)
│   │   ├── _raw/                 gitignored — near-verbatim extracted text
│   │   └── ncert_corpus.csv      gitignored — derived flat export
│   ├── ncert-index.json         COMMITTED — the BM25 search index
│   ├── prompts/                  research-writer-system.md, self-check.md
│   ├── topics.json               your batch checklist
│   └── *.mjs / *.py              see §3.1 module map
├── reporting/                  status dashboard (browser, reads repo JSON only)
├── pending-long-posts/          drop zone: new articles awaiting WordPress publish
├── published-long-posts/        processed articles + their WordPress post id/link
├── pending-notes/ published-notes/     same pattern, for notes-factory
├── pending-questions/ published-questions/   same pattern, for question-factory
├── .github/workflows/
│   ├── pub-lpost.yml    WordPress-drafting automation for long posts
│   ├── pub-note.yml         same, for notes
│   └── pub-quiz.yml    same, for questions
└── _archive/                    retired/superseded local working data (gitignored)
```

---

## 8. Day-to-day operation quick reference

**Add more knowledge to the RAG corpus:**
```
# drop .epub/.zip files into automation/book-library/
cd automation
node rebuild-corpus.mjs
```

**Generate a batch of articles:**
```
cd automation
# edit topics.json with your exam + topic list
$env:ANTHROPIC_API_KEY = "sk-ant-..."
node run-batch.mjs
```

**Check corpus quality any time:**
```
cd automation
python verify_corpus.py
```

**View status:** open `reporting/index.html`.

---

## 9. Interview-relevant concept glossary

- **RAG (Retrieval-Augmented Generation)** — grounding LLM output in
  retrieved documents instead of relying purely on training-data memory.
  Two independent subsystems: retrieval (search) and generation (writing).
- **Sparse vs. dense retrieval** — BM25 (term-frequency statistics, free, no
  vector store) vs. embeddings (semantic similarity, costs an API call per
  index/query, needs a vector store). Know when each is the right call —
  this project chose sparse deliberately, for cost and simplicity, given
  the corpus's vocabulary-sharing characteristics.
- **BM25** — a probabilistic ranking function; understand `idf`, term-
  frequency saturation (`k1`), and length normalization (`b`) well enough to
  explain the formula, not just name it.
- **Agentic tool use** — a model deciding *when* and *what* to call a tool
  mid-generation, versus a fixed retrieve-then-generate pipeline ("naive
  RAG"). The `tool_use` / `tool_result` loop shape is framework-agnostic.
- **LLM-as-judge / self-critique** — using a second model call to audit the
  first one's output against source material, catching unsupported claims
  before they ship.
- **ETL (extract-transform-load)** — most of the actual engineering effort
  in a real RAG system is data cleaning, not model calls. This project's
  two hardest bugs were both in the "transform" stage (font decoding,
  tokenization), not in prompting or retrieval logic.
- **Idempotent pipelines** — a rebuild step should be safe to re-run any
  time and always produce output that's a faithful function of current
  input, never an accumulation of past runs (stale-file cleanup before
  regenerating).
- **Data-quality gates** — automated sanity checks (word counts, script-
  density heuristics, cross-count consistency) run after every pipeline
  change, the same instinct as a CI test suite applied to data instead of
  code.
- **Secret minimization** — architecting so only the smallest possible
  surface of code ever touches a credential, and that credential is never
  persisted to disk/git/logs.
