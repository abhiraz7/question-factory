# RAG package schema (schema_version "1")

This is the contract a human uploads to `rag/incoming/` after asking ChatGPT
(or any other tool) to turn a PDF/textbook/syllabus into a RAG package for
ExamNotePDF. It is deliberately minimal — see
`../../RAG_INGESTION_ENGINE.md` section 4: "Do not require metadata that
ChatGPT cannot reliably produce."

This doc is the human-readable version of the contract. The structural shape
is also encoded in `schema/rag-package.schema.json` (JSON Schema draft-07),
which `rag-package-validator.mjs` uses for the first validation tier.

## File format

One JSON file per package (`.json`). JSON Lines (`.jsonl`, one chunk object
per line, no wrapper) is accepted too for very large packages — see
"JSONL variant" below — but plain `.json` is the expected common case and is
what the sample packages in `rag/incoming/` use.

## Shape

```json
{
  "schema_version": "1",
  "source": {
    "title": "NCERT Class 5 EVS — Chapter 4: Our Environment",
    "type": "textbook",
    "subject": "EVS",
    "language": "en",
    "origin": "NCERT Class 5 EVS textbook, Chapter 4 (user-uploaded PDF, ChatGPT-packaged)"
  },
  "chunks": [
    {
      "id": "evs-ch4-001",
      "text": "Soil is formed by the slow breaking down of rocks...",
      "page": 34,
      "section": "How soil is formed",
      "topics": ["soil formation", "weathering"],
      "concepts": ["soil", "weathering", "rock cycle"]
    }
  ]
}
```

### Top level

| Field            | Required | Type   | Notes                                             |
|------------------|----------|--------|----------------------------------------------------|
| `schema_version` | yes      | string | Must be `"1"` (the only supported value right now). |
| `source`         | yes      | object | See below.                                         |
| `chunks`         | yes      | array  | Non-empty. See below.                              |

### `source`

| Field     | Required | Type   | Notes                                                                 |
|-----------|----------|--------|------------------------------------------------------------------------|
| `title`   | yes      | string | Non-empty. The only field the validator treats as "source identified". |
| `type`    | no       | string | Free text, e.g. `"textbook"`, `"syllabus"`, `"question-bank"`.         |
| `subject` | no       | string | Free text, e.g. `"EVS"`, `"CDP"`, `"Hindi Grammar"`. Used as the retrieval filter field (mirrors `retrieve.mjs`'s `{subject}` filter). |
| `language`| no       | string | Free text, e.g. `"en"`, `"hi"`.                                        |
| `origin`  | no       | string | Free text provenance note (which PDF/book/page range this came from). |

Only `title` is required. Everything else is optional because ChatGPT cannot
reliably infer it, and the validator must not punish a package for omitting
metadata nobody could have produced deterministically.

### `chunks[]`

| Field      | Required | Type            | Notes                                                                 |
|------------|----------|-----------------|--------------------------------------------------------------------- |
| `id`       | yes      | string          | Non-empty, unique within the package.                                 |
| `text`     | yes      | string          | Non-empty, trimmed length between 10 and 8000 characters (see validator bounds below). |
| `page`     | no       | number or null  | Source page number, if known.                                         |
| `section`  | no       | string          | Section/heading title, if known.                                      |
| `topics`   | no       | array of string | Each entry non-empty, <= 100 chars. Array length <= 50.                |
| `concepts` | no       | array of string | Same constraints as `topics`.                                         |

### JSONL variant

For very large packages, the same `chunks[]` entries may instead be written
one-per-line as a `.jsonl` file, **without** the `schema_version`/`source`
wrapper repeated per line. Instead, line 1 must be a header object:

```json
{"schema_version": "1", "source": {...}}
```

followed by one chunk object per subsequent line. The validator detects this
by file extension (`.jsonl`) and parses accordingly. This repo's sample
packages are plain `.json` — the JSONL path exists for scale, not because
either sample needs it.

## Why these bounds (chunk length 10–8000 chars)

- **Lower bound (10 chars):** below this, a "chunk" is reliably noise — a
  stray heading fragment, a page number, an OCR artifact — never a usable
  BM25 document. This mirrors `verify_corpus.py`'s existing judgment call
  that very short extracted text is a sign of a bad extraction, not real
  content, just recalibrated for per-chunk size instead of per-chapter size.
- **Upper bound (8000 chars):** BM25 (see `build-index.mjs` / `retrieve.mjs`)
  scores whole documents, not spans within them. A single 8000+ char chunk
  mixing several concepts would always out-score more precise, smaller
  chunks for any query that happens to share vocabulary with any part of it,
  degrading retrieval precision. 8000 chars is roughly a full NCERT chapter
  sub-section — generous enough that no reasonable human-curated "topic
  chunk" should legitimately exceed it, but tight enough to keep chunks
  BM25-precise. Chunks over this are a **warning** (not an error) below
  4000 chars isn't a hard problem either way — only genuinely oversized
  chunks (>8000 chars) are warned about, and the index builder still
  indexes them; this is a quality signal for the human reviewer, not a
  rejection reason, since an oversized-but-real chunk is still better than
  no evidence at all.

## Non-goals (per `RAG_INGESTION_ENGINE.md` section 14)

This schema does not define: embeddings, a vector format, PDF attachments,
or any binary payload. Packages are pure JSON/JSONL text — no executable
content, no file attachments, nothing beyond what's in the table above. The
validator's safety tier (see `rag-package-validator.mjs`) explicitly checks
for and rejects anything that strays from this.
