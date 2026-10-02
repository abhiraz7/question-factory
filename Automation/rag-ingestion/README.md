# RAG ingestion pipeline

Logic for turning a human-uploaded "RAG package" (ChatGPT-packaged chunks
from a PDF/textbook/syllabus) into a validated, atomically-published,
BM25-searchable index — without ever touching the live NCERT corpus
pipeline (`../ncert-knowledge-base/`, `../core/`). Spec:
`../../../RAG_INGESTION_ENGINE.md` (sections 1-6 are this module's scope;
7-10 are documented/deferred — see `GITHUB_ACTIONS_DESIGN.md` and the
top-level progress report).

Fully key-free: no API calls, no embeddings, no network, anywhere in this
pipeline — same principle as `../ncert-knowledge-base/README.md`.

## Files

| File                            | Purpose                                                             |
|----------------------------------|----------------------------------------------------------------------|
| `RAG_PACKAGE_SCHEMA.md`           | The package contract (schema_version "1"), human-readable + reasoning. |
| `schema/rag-package.schema.json`  | Same contract as a JSON Schema (draft-07), for structural reference. |
| `rag-package-validator.mjs`       | The three-tier validator (structural/knowledge/safety). Also a CLI.   |
| `run-validate-incoming.mjs`       | Scans `../../rag/incoming/`, validates, moves to `approved/`/`rejected/`. |
| `build-rag-index.mjs`             | Builds + atomically publishes `../../rag/index/index.json` from `approved/`. |
| `atomic-publish.mjs`              | Generic build-to-temp/validate/atomic-rename primitive used by the above. |
| `GITHUB_ACTIONS_DESIGN.md`        | Draft parallel-job design for a future real workflow. **Not a workflow file.** |

The actual index + its reader live one level up, at `../../rag/index/`
(`index.json`, `retrieve.mjs`) — see `../../rag/README.md` for why the data
and the logic are split this way.

## Pipeline, end to end

```text
rag/incoming/<package>.json
        │  node run-validate-incoming.mjs
        ▼
rag/approved/<package>.json   (or rag/rejected/<package>.json + .rejection.json)
        │  node build-rag-index.mjs
        ▼
rag/index/index.json   (atomically published; previous index untouched on any failure)
        │  import { retrieve } from '../../rag/index/retrieve.mjs'
        ▼
[{ id, source, page, section, topics, concepts, text, score }, ...]
```

## Why this is a sibling pipeline, not a modification of the NCERT one

Short version (full reasoning in `build-rag-index.mjs`'s header comment):
the NCERT pipeline (`../core/src/build-index.mjs` →
`../ncert-knowledge-base/index.json`) is whole-chapter-granularity, already
depended on by other code, and out of this task's edit boundary. RAG
packages are chunk-granularity, human/ChatGPT-curated, and need their own
versioning metadata (section 10). So this builds a **sibling** index at
`rag/index/index.json` using the **identical** `{docs, df, avgDocLen,
docCount}` shape `retrieve.mjs` already reads, plus extra top-level
versioning fields `retrieve.mjs` simply ignores. `rag/index/retrieve.mjs` is
a near-twin of `../ncert-knowledge-base/retrieve.mjs` — same BM25 constants,
same scoring function, same exports — extended with `source`/`topic`/
`concept` filters (RAG chunks carry that metadata; NCERT chapters don't).

One **intentional** behavioral difference from
`../ncert-knowledge-base/retrieve.mjs`, worth a human's attention: that
file's subject filter silently falls back to the *entire unfiltered pool*
if the requested subject matches zero docs (`if (filtered.length) pool =
filtered;`). This pipeline's `retrieve.mjs` does **not** do that — an
unmatched filter returns zero results. For an evidence-providing system
whose whole point is traceable provenance (section 9), a wrong/mistyped
subject filter silently returning off-subject evidence seemed like the
wrong default. If a human reviewer prefers parity with the NCERT behavior
instead, that's a one-line change in `rag/index/retrieve.mjs`'s
`matchesFilter`/pool-selection logic.

A real unification (one `retrieve()` searching both corpora) is possible
later with no math changes — just load both `index.json` files and
concatenate their `docs` arrays — but is not built here; it would start
to cross into how Editorial Intelligence consumes evidence, which is
explicitly out of this task's scope.

## Validation bounds, chosen and justified

See `RAG_PACKAGE_SCHEMA.md`'s "Why these bounds" section for the chunk-
length bounds (10-8000 chars warn, 20000 chars hard reject) and why they're
sized the way they are. Safety-tier patterns (secret-shaped strings,
workflow-tamper phrases, executable content) are listed explicitly in
`rag-package-validator.mjs` — nothing in the safety tier is a stub; every
check in `RAG_INGESTION_ENGINE.md` section 5 is implemented as a real regex/
structural check, verified against the deliberately-broken sample package
(see "Verification" below).

## Verification performed

Both fixtures live in `../../rag/incoming/` originally (now moved — see
their current location in `../../rag/approved/` and `../../rag/rejected/`
respectively after a real run of `run-validate-incoming.mjs`):

- `cdp-piaget-cognitive-development-sample.json` — a realistic 8-chunk
  CDP (Child Development & Pedagogy) package on Piaget's stage theory, a
  staple CTET/BPSC TRE topic. Validated **approved**, 0 errors, 0 warnings.
- `broken-sample-package.json` — deliberately broken five ways at once
  (empty chunk text, a duplicate chunk id, a non-string topics entry, and
  an embedded API-key-shaped string). Validated **rejected** with five
  distinct, correctly-coded errors (one per planted defect, with the API
  key string tripping two separate secret-pattern checks).

After that real run moved both into `approved/`/`rejected/`:
`build-rag-index.mjs` was run against `rag/approved/` and produced
`rag/index/index.json` (1 source, 8 chunks). A throwaway smoke-test script
(not committed) then queried it through `rag/index/retrieve.mjs` and
confirmed: a query on "object permanence infant sensorimotor" correctly
top-ranked the sensorimotor-stage chunk; a `subject: "CDP"` filter
correctly narrowed results; a `topic: "preoperational stage"` filter
correctly returned only the matching chunk; a `subject` filter for a
subject that doesn't exist in the corpus correctly returned zero hits
(confirming the intentional no-silent-fallback behavior above).

A second throwaway smoke test exercised `atomic-publish.mjs` directly: a
throwing `buildFn`, a rejecting `validateFn`, and a succeeding publish —
confirming the live `rag/index/index.json` was left byte-for-byte
untouched on both failure paths, and only changed on the success path
(then restored to its real built content afterward).

## Deliberately out of scope here

- Connecting this evidence to Editorial Intelligence (spec section 7) —
  the other concurrent agent's territory; see the top-level progress
  report for the handoff plan.
- `NEXT_POST_READY.json`, post-deployment refresh, Notes Factory UI wiring
  (spec sections 8-10 of the implementation order) — all deferred, all
  documented as a human-executed next-steps plan in the progress report.
- A real `.github/workflows/*.yml` — see `GITHUB_ACTIONS_DESIGN.md`.
