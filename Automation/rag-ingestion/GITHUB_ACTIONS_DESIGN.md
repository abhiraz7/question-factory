# RAG ingestion — GitHub Actions design (DRAFT — NOT ACTIVE)

**This is a design document, not a workflow.** There is no `.yml` file for
any of this under `.github/workflows/` and none should be added from this
document without a human explicitly reviewing and committing it separately.

Per the task's hard boundary 5: a real `.yml` file under
`.github/workflows/` goes live for Actions the instant it's committed to a
branch that has Actions enabled, even before merging — a local commit here
is not a safety guarantee if this branch is ever pushed. Every script this
design calls out already exists and is directly runnable with plain `node`
(see "Scripts this maps to" below) — turning this into a real workflow is
pure wiring, no new logic, whenever a human decides to do it.

## Job graph (RAG_INGESTION_ENGINE.md section 7)

```text
RAG UPLOAD (push/PR touching rag/incoming/**)
    │
    ▼
VALIDATE  ───────────────────────────────────────────────
    │  node Automation/rag-ingestion/run-validate-incoming.mjs
    │  - moves each rag/incoming/* file to rag/approved/ or rag/rejected/
    │  - exit non-zero if anything is rejected (fails the job, so a bad
    │    upload shows up as a red check on the PR instead of silently
    │    merging)
    │
    ├────────────────────────┐
    ▼                        ▼
RAG INDEX                METADATA/PROVENANCE
  node .../build-rag-        (not yet built — would record, per source
  index.mjs                  package, which packages are now live in the
  - atomic publish to        index and when, e.g. appending to a small
    rag/index/index.json     manifest/log file. Deferred: no consumer
  - never touches NCERT's     needs this yet; see "What to do next" in the
    index.json                progress report.)
    │                        │
    └───────────┬────────────┘
                ▼
     EDITORIAL REFRESH   <-- OUT OF SCOPE for this task. This is the other
                             agent's Editorial Intelligence work
                             (editorial-intelligence.mjs, rag-evidence.mjs,
                             and whatever topic-state.mjs / statistical-
                             state.mjs / editorial-brief.mjs land as). This
                             design stops here deliberately — see this
                             task's boundary notes and the progress report's
                             "deferred" section.
```

### Why VALIDATE/RAG INDEX/METADATA are separate jobs (not one script)

- **VALIDATE must gate everything downstream.** If any package in a PR gets
  rejected, the job fails before indexing even starts — a GitHub branch
  protection rule could require this check to pass before merge, so a bad
  upload literally cannot reach `rag/approved/` on `main` without a human
  overriding a visibly-red check.
- **RAG INDEX and METADATA/PROVENANCE have no dependency on each other** —
  both only need the already-approved packages, not each other's output —
  so per section 7 ("Only jobs with real dependencies should wait")
  they're drawn as parallel jobs. (METADATA/PROVENANCE doesn't exist as
  code yet — see above — so today there is only one downstream job, RAG
  INDEX; the parallel slot is reserved, not invented busywork.)
- **RAG INDEX must not run on every push**, only on pushes/PRs that
  actually touch `rag/approved/**` (or that VALIDATE job just populated) —
  otherwise every unrelated commit would rebuild an index that hasn't
  changed. A real workflow would scope this with `paths:` filters or a
  path-diff check before calling `build-rag-index.mjs`.

## Scripts this maps to (all already real, already runnable, already tested)

| Job            | Script                                                   |
|----------------|-----------------------------------------------------------|
| VALIDATE       | `node Automation/rag-ingestion/run-validate-incoming.mjs` |
| RAG INDEX      | `node Automation/rag-ingestion/build-rag-index.mjs`       |

Both exit non-zero on failure: `run-validate-incoming.mjs` sets
`process.exitCode = 1` when it rejects one or more packages in the run (it
still moves every file to `approved/` or `rejected/` either way — rejection
is a normal, expected outcome, not a crash — but the process exit code
reflects "did anything get rejected THIS run" so a real workflow step can
gate on a plain exit-code check, e.g. `if: failure()` on the next job). Re-
running the script when `rag/incoming/` is already empty exits 0 (nothing
to reject). `build-rag-index.mjs` exits non-zero via `atomicPublishJson`'s
`ok: false` branch on any build/validate/publish failure.

## What this design explicitly does NOT cover

Per the task boundary, this stops at RAG INDEX. EDITORIAL REFRESH, the
TOPIC/STATS/MEMORY/SIMILARITY fan-out, and `NEXT_POST_READY.json` (spec
sections 7's lower half, 8, 9) all belong to Editorial Intelligence's scope
and/or later implementation-order steps (spec section 15, items 7-10) —
see the progress report's "what to do next" section for the human-executed
plan.
