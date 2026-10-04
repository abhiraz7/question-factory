# Content Memory

A lightweight, per-article record of what each published note/long-post
actually taught — never the article itself. One JSON file per article,
named `<slug>.json` (same slug as `published-notes/<slug>.json` /
`published-long-posts/<slug>.json`), living in this directory.

## Why this exists

All three pipelines (`notes-factory`, `long-post-factory`, `update-factory`)
already carry a Variety Engine that rolls a random voice/opening/example-domain
per article — but that roll is **topic-local**: it has no visibility into what
the *last N* published articles on the same exam actually did, so two
unrelated topics can independently land on the same voice/opening/example
combination. Content Memory is the missing piece: a queryable record of prior
choices, so a future prompt run can be told "the last 3 BPSC TRE Maths notes
all used a worked-example strategy and the 12/18 HCF example — pick something
else" instead of rolling blind every time.

This also gives a code-side (not self-reported) signal for catching
structural convergence across the corpus — see
`MASTER-PROMPT-ExamNotesPDF_v13.md`'s Variety Engine and HARD BANS for the
honesty rules this complements.

## Schema

```jsonc
{
  "id": "bpsc-tre-hcf-lcm-001",       // == the slug, filename without .json
  "type": "note",                     // "note" | "long-post"
  "topic": "HCF and LCM",
  "subject": "Maths",
  "exam": "BPSC TRE",

  // Everything below this line is reported by the model itself, inside the
  // <<<CONTENT_MEMORY_JSON>>> / <!-- CONTENT MEMORY --> block appended to the
  // pipeline's output contract (see each master prompt's OUTPUT FORMAT
  // section) — never derived from the HTML by the workflow.
  "flavour": "worked-example",        // the FLAVOUR_ENGINE id actually used — see
                                       // Automation/core/src/flavour-engine.mjs
  "concepts_taught": ["HCF", "LCM", "prime factorisation", "relationship between HCF and LCM"],
  "misconceptions_used": ["HCF is always smaller", "LCM is always product"],
  "examples_used": ["12 and 18", "classroom grouping"],
  "pedagogical_strategy": "worked-example",
  "article_shape": ["problem", "concept", "worked example", "exam application", "practice"],
  "question_types": ["calculation", "application", "trap"],
  "sources": ["NCERT Maths Class 6, Ch. 3"],

  // Added by the publish workflow (pub-note.yml / pub-lpost.yml),
  // never by the model.
  "postId": "1234",
  "link": "https://examnotespdf.in/...",
  "published": "2026-09-13T12:00:00Z",

  // Present only on records produced by backfill-content-memory.mjs for
  // articles published before this system existed — derived from the HTML
  // itself (headings, citations) rather than model-reported, so treat these
  // fields as lower-confidence than a live record's.
  "derived": true
}
```

## How records get written

1. **New articles**: `notes-factory`, `long-post-factory`, and
   `update-factory` all append a Content Memory block to their output
   contract and parse it back out of the AI's reply (see each tool's
   `extractContentMemory()` / `parseResponse()`). If present, it rides along
   inside the pending JSON bundle as `.contentMemory`.
2. **Publish time**: `pub-note.yml` / `pub-lpost.yml` read
   `.contentMemory` off the bundle right after a successful WordPress publish,
   merge in `id`/`type`/`topic`/`subject`/`exam`/`postId`/`link`/`published`,
   and commit the result here. A bundle with no `.contentMemory` (older
   prompt reply, or the block failed to parse) simply gets no record — this
   never blocks or fails the publish itself.
3. **Backfill**: `Automation/core/src/backfill-content-memory.mjs` scans
   already-published articles that predate this system and writes a
   best-effort, lower-confidence record for each (`"derived": true`) so
   cross-article memory has history from day one. Run once; re-run any time
   with `--force` to regenerate derived records (it never overwrites a
   live/model-reported record).

## Using it

This is now consumed by the **Editorial Flavour Engine**
(`Automation/core/src/flavour-engine.mjs`, mirrored to `shared/flavour-engine.js`
for the browser tools — see that file's header for the full architecture).
Each of `notes-factory`, `long-post-factory`, and `update-factory` fetches
the last ~30 records from this directory (best-effort, via the public GitHub
API — a network failure or missing script just means no repetition-avoidance
data that run, not a broken prompt) and passes them into
`selectFlavour()`/`buildFlavourPromptBlock()`, which scores every flavour on
topic/subject fit and subtracts a penalty for flavours used recently on the
same `exam`+`subject`. The result fills the Master Prompt's
`{{FLAVOUR_ENGINE_BLOCK}}` placeholder as a recommendation, not a mandate —
the model states its actual final choice in this record's `flavour` field.

Separately, `Automation/core/src/similarity-check.mjs` runs inside
`pub-note.yml`/`pub-lpost.yml` right after a successful publish —
a local 5-gram Jaccard-overlap check against the last 30 published articles,
appended to the article's own `publisherNotes` field as a warning-only,
informational note (never a rejection gate; not a claim about how any search
engine would treat the content). That check reads the actual published HTML,
not this directory, since Content Memory intentionally never stores article
bodies.
