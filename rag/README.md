# RAG ingestion lifecycle

Data-only folder — the lifecycle `RAG_INGESTION_ENGINE.md` section 3
describes, as literal top-level paths (matching how `pending-notes/` and
`published-notes/` already sit at the repo root rather than nested under
`Automation/`):

```text
rag/incoming/   -- drop an uploaded RAG package (.json/.jsonl) here
rag/approved/   -- packages that passed validation; eligible for indexing
rag/rejected/   -- packages that failed validation, + a *.rejection.json
                   report alongside each one for debugging
rag/index/      -- the built, searchable index (index.json) + retrieve.mjs
```

Every folder keeps a `.gitkeep` so the empty-state structure survives even
when a folder has nothing else in it (same convention as `pending-notes/`,
`published-notes/`).

## The actual logic lives in `../Automation/rag-ingestion/`

This folder holds data and the one piece of logic that has to live next to
its data for relative-path reasons (`index/retrieve.mjs`, a pure reader with
no side effects). Everything else — the schema docs, the validator, the
lifecycle runner, the index builder, the atomic-publish helper, and the
GitHub Actions design draft — lives in
[`../Automation/rag-ingestion/`](../Automation/rag-ingestion/), matching
where `Automation/core/src/` already hosts the NCERT corpus pipeline's
scripts while `Automation/ncert-knowledge-base/` holds that pipeline's data
+ `retrieve.mjs`. Start there (`../Automation/rag-ingestion/README.md`) for
how to actually run this pipeline end to end.

## Quick start

```sh
# 1. Drop a ChatGPT-generated RAG package (see
#    Automation/rag-ingestion/RAG_PACKAGE_SCHEMA.md for the exact shape)
#    into rag/incoming/, then:
node Automation/rag-ingestion/run-validate-incoming.mjs

# 2. Build/publish the index from whatever is now in rag/approved/:
node Automation/rag-ingestion/build-rag-index.mjs

# 3. Query it from any other script:
#    import { retrieve, hasCorpus } from './rag/index/retrieve.mjs';
```
