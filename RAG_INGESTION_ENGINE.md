# RAG Ingestion Engine — Architecture Specification

## 1. Purpose

Build a GitHub-native RAG ingestion system for ExamNotePDF.

The user does **not** upload PDFs through the website.

The workflow is:

PDF → ChatGPT creates RAG package → user downloads package → GitHub manual file upload → validation gate → index build → editorial/statistical refresh → next-post-ready state.

The RAG system is an evidence provider. It must never become the writing engine.

---

## 2. Core principle

Separate:

```text
SOURCE MATERIAL
    ↓
RAG INGESTION
    ↓
VALIDATED EVIDENCE
    ↓
RETRIEVAL
    ↓
EDITORIAL INTELLIGENCE
    ↓
EDITORIAL BRIEF
    ↓
FREE AI WRITER
```

RAG answers:

> What reliable material is available?

Editorial Intelligence answers:

> What should this particular note teach, emphasize, compare, demonstrate, or avoid?

The writer answers:

> How should it actually be explained?

---

## 3. GitHub ingestion model

Use GitHub as the manual ingestion gate.

Recommended lifecycle:

```text
rag/incoming/
      ↓
validation
      ↓
rag/approved/
      ↓
index build
      ↓
rag/index/
      ↓
editorial/statistical refresh
      ↓
generated/editorial/
```

Rejected material should never enter the live index.

Recommended rejected state:

```text
rag/rejected/
```

Keep rejected files or validation reports when useful for debugging.

---

## 4. RAG package contract

The exact schema should be defined once and versioned.

Conceptual structure:

```json
{
  "schema_version": "1",
  "source": {
    "title": "...",
    "type": "textbook",
    "subject": "...",
    "language": "hi",
    "origin": "..."
  },
  "chunks": [
    {
      "id": "source-001",
      "text": "...",
      "page": 12,
      "section": "...",
      "topics": [],
      "concepts": []
    }
  ]
}
```

Do not require metadata that ChatGPT cannot reliably produce.

Required fields should be minimal and deterministic.

---

## 5. Validation gate

Every uploaded package must pass:

### Structural validation

- valid JSON/JSONL
- supported schema version
- required fields
- non-empty chunks
- unique chunk IDs
- valid text
- valid metadata types

### Knowledge validation

- source is identified
- chunks contain meaningful text
- no accidental empty corpus
- no obviously duplicated chunk IDs
- reasonable chunk lengths
- topic/concept metadata is syntactically valid

### Safety checks

- no executable content
- no unexpected files
- no secrets
- no repository workflow modifications inside the RAG package

Output:

```json
{
  "status": "approved",
  "source": "...",
  "chunks": 1200,
  "warnings": [],
  "errors": [],
  "content_hash": "...",
  "validated_at": "..."
}
```

A failed validation must stop downstream jobs.

---

## 6. Atomic indexing

Never modify the live index halfway through a build.

Use:

```text
incoming
  ↓
validate
  ↓
build temporary index
  ↓
validate temporary index
  ↓
atomic publish
```

If indexing fails, keep the previous valid index.

This prevents one bad upload from breaking all future notes.

---

## 7. Parallel GitHub Actions design

The workflow should be decomposed into jobs.

```text
RAG UPLOAD
    │
    ▼
VALIDATE
    │
    ├───────────────┐
    ▼               ▼
RAG INDEX       METADATA/PROVENANCE
    │               │
    └───────┬───────┘
            ▼
     EDITORIAL REFRESH
            │
    ┌───────┼─────────┬───────────┐
    ▼       ▼         ▼           ▼
 TOPIC    STATS     MEMORY     SIMILARITY
 STATE    ENGINE    UPDATE     ANALYSIS
    └───────┴─────────┴───────────┘
                    │
                    ▼
          NEXT_POST_READY.json
```

Only jobs with real dependencies should wait.

Independent calculations should run in parallel.

---

## 8. RAG retrieval

Reuse:

`Automation/ncert-knowledge-base/retrieve.mjs`

and the existing indexing architecture where possible.

Do not create an incompatible second retrieval engine.

The retrieval layer should eventually support:

- source retrieval
- topic retrieval
- subject retrieval
- concept retrieval
- evidence retrieval

Every result must retain provenance.

---

## 9. Provenance

Every retrieved evidence item should be traceable to:

```text
RAG source
→ chunk ID
→ page/section when available
→ source metadata
```

Editorial Intelligence may consume the evidence, but must not erase provenance.

---

## 10. RAG versioning

Every index should have:

- schema version
- source version/hash
- build timestamp
- number of sources
- number of chunks
- index version/hash

Example:

```json
{
  "index_version": "...",
  "schema_version": "1",
  "sources": 12,
  "chunks": 18342,
  "built_at": "..."
}
```

---

## 11. Failure isolation

RAG failure must not corrupt the existing system.

Rules:

- invalid upload → reject
- failed index build → preserve previous index
- failed optional statistical analysis → preserve previous valid state
- failed editorial refresh → do not publish incomplete next-post state

Prefer immutable build artifacts followed by atomic replacement.

---

## 12. Post-deployment relationship

Publishing a note must trigger a post-run.

The post-run should:

```text
published note
    ↓
content memory update
    ↓
statistics update
    ↓
topic state update
    ↓
similarity/diversity update
    ↓
editorial intelligence refresh
    ↓
next-post-ready
```

RAG ingestion and post-deployment refresh should converge on the same editorial-state pipeline.

---

## 13. Runtime rule

Do not run expensive RAG indexing or statistical computation in the mobile browser.

GitHub Actions performs the expensive work.

The mobile UI reads static generated state.

Target:

```text
mobile request
→ static JSON lookup
→ compact editorial result
```

No backend is required for the runtime decision layer.

---

## 14. Non-goals

This system does NOT:

- upload PDFs through the website
- generate prose
- replace the existing Notes Factory
- replace the AI writer
- create a desktop UI
- create a new RAG SaaS
- require a paid vector database
- silently modify source material

---

## 15. Implementation order

1. Define RAG schema.
2. Build validator.
3. Add incoming/approved/rejected lifecycle.
4. Build index.
5. Add atomic index publication.
6. Add parallel GitHub jobs.
7. Connect RAG evidence to Editorial Intelligence.
8. Generate `NEXT_POST_READY.json`.
9. Add post-deployment refresh.
10. Connect Notes Factory to the precomputed state.
