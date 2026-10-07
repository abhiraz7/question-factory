# Editorial Intelligence — GitHub Actions design (Phase 9/10, NOT ACTIVE)

> **This file is a design document only.** It contains no live automation.
> No `.yml` file has been created under `.github/workflows/` by this work —
> a real workflow file goes live and can trigger the instant it is
> committed/pushed, which this session's task explicitly forbids doing
> unattended. Everything below is for a human to review and implement
> deliberately, on their own schedule.

Spec reference: `../../EDITORIAL_INTELLIGENCE_ENGINE.md`, sections 13-15.

## What already exists and runs today (Phase 9/10's actual LOGIC)

`Automation/core/src/generate-next-post-ready.mjs` is a standalone,
directly-runnable Node script that already does the real work:

```
node Automation/core/src/generate-next-post-ready.mjs --topic "..." --subject "..." --exam "..."
```

It reads `Automation/content-memory/*.json` and the local NCERT BM25 index
(no network, no credentials), runs the full Phase 1/3/4/5/6/7/8 pipeline,
and writes `generated/editorial/next-post-ready.json` (spec section 13's
shape). Run with no `--topic`, it falls back to a recommend-only mode (see
that file's header for why — there is no existing "next topic" backlog in
this repo to draw from).

This script is the thing a GitHub Actions job would eventually just *call*.
The design below is purely about how/when to call it, in CI, safely.

## Proposed job graph (spec section 15)

```text
             ┌─ RAG refresh                (rebuild ncert-knowledge-base/index.json
             │                              if book-library/ changed — already exists
             │                              as Automation/core/src/rebuild-corpus.mjs)
             ├─ Search Console refresh      (NOT YET BUILT — no data source wired;
             │                              see "Open questions" below)
POST-RUN ────┼─ Content memory analysis     (buildEditorialSignature over the full
             │                              Automation/content-memory/ set)
             ├─ Similarity analysis         (already exists: similarity-check.mjs,
             │                              already wired into pub-note.yml /
             │                              pub-lpost.yml)
             ├─ Topic coverage              (buildTopicState's coverage layer)
             └─ Statistical analysis        (editorial-statistics.mjs signals)
                     ↓
              MERGE STATE                   (nothing to build — buildTopicState()
                                             already merges these into one object;
                                             a workflow step just needs to call it
                                             and pass the result along as an artifact)
                     ↓
             EDITORIAL DECISION             (buildEditorialGenome +
                                             buildEditorialBrief)
                     ↓
              NEXT POST READY               (generate-next-post-ready.mjs — already
                                             exists, already runnable)
```

The key realization from actually building Phases 5-8: almost none of this
needs to be separate GitHub Actions *jobs* running in parallel the way
section 15 first suggests, because the real cost (BM25 retrieval, content-
memory parsing, the statistics) is all **cheap, local, synchronous
JavaScript** — milliseconds, not minutes, over today's data sizes (39
content-memory records, 215-doc BM25 index). `generate-next-post-ready.mjs`
already runs all of it in a single process in well under a second.

**Recommendation**: do NOT over-build this into 6 parallel jobs + a merge
job yet. Start with the simplest thing that satisfies spec section 14
("every successful deployment should trigger..."):

```yaml
# .github/workflows/ed-refresh.yml.draft  (NOT ACTIVE — rename to
# .yml and review carefully before this ever becomes a real workflow file)
#
# name: ED.REFRESH
# on:
#   workflow_run:
#     workflows: ["Publish Note", "Publish Long Post"]   # whatever the real
#                                                          publish workflows
#                                                          are named today
#     types: [completed]
# jobs:
#   next-post-ready:
#     if: ${{ github.event.workflow_run.conclusion == 'success' }}
#     runs-on: ubuntu-latest
#     steps:
#       - uses: actions/checkout@v4
#       - uses: actions/setup-node@v4
#         with: { node-version: 20 }
#       - run: node Automation/core/src/generate-next-post-ready.mjs
#         # (no --topic yet -> recommend-only mode until a real topic
#         # backlog exists; see humanActionNeeded in its output)
#       - uses: actions/upload-artifact@v4
#         with:
#           name: next-post-ready
#           path: generated/editorial/next-post-ready.json
#       # Committing generated/editorial/next-post-ready.json back to the
#       # repo (vs. just uploading it as a build artifact) is an explicit
#       # open decision for the human — see below.
```

Only split into the full parallel-job graph from section 15 later, if/when
any one step (e.g. a much larger corpus, or a real Search Console API call)
actually becomes slow or rate-limited enough to need isolating. Building
that complexity now, against today's small/fast data, would be solving a
problem that does not exist yet.

## Open questions for the human (genuine judgment calls, not guessed at)

1. ~~**Topic backlog.**~~ **RESOLVED.** `generate-next-post-ready.mjs`'s
   recommend-only mode now reads `Automation/core/src/topic-bank-sources.mjs`
   (the same syllabus CSV registry — `Automation/input sylabuss/*.csv` — the
   notes-factory/question-factory/update-factory Topic Bank UIs already
   browse) as a real topic backlog, cross-checked against content-memory to
   exclude already-covered topics. Recommend-only mode's output now includes
   a concrete `nextTopicSuggestion` per exam+subject pair (still requires a
   human — or a `--topic` re-run — to commit to it; this script never
   auto-promotes a suggestion into a decision). This also fixed a real,
   confirmed bug the empty backlog was masking: `recommendExamSubjectPair()`
   always called `buildTopicState({topic:'', ...})`, so RAG evidence/
   coverage was always empty and `exploitScore` silently fell back to the
   same neutral 0.5 for every single candidate, every run — the explore/
   exploit ranking was never actually discriminating on real coverage data.
   Confirmed fixed live: exploitScore now varies genuinely (0.5/0.75/0.86
   seen across real candidates in one run) wherever a backlog topic AND real
   RAG/NCERT coverage both exist for that subject; it stays honestly neutral
   only where one or both are still missing (e.g. a subject with no NCERT
   corpus mapped to it), which is correct, not a residual defect.
2. ~~**Search Console.**~~ **RESOLVED** (Phase 11, commit `de1f53a`).
   `gsc.mjs` wires real OAuth2 + Search Console `searchAnalytics.query`
   credentials via `GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN` +
   `GSC_SITE_URL` env vars (added to the repo's secrets per that commit).
   `topic-state.mjs`'s `learner_signals` stays honestly `{dataAvailable:
   false}` only where credentials are absent or a call fails at runtime —
   that's the intended degrade path, not an unfinished integration.
3. ~~**Committing `generated/editorial/next-post-ready.json` to git.**~~
   **RESOLVED** — option (a) was chosen: `ed-refresh.yml` commits it to the
   repo after every publish. Still open, separately: nothing currently reads
   this file back into notes-factory or any other prompt-building step (see
   the learned-state work below, which closes part of that gap by having
   the same workflow also emit a smaller, per-exam+subject learned-state
   file the browser tool *does* fetch — `next-post-ready.json` itself
   remains a human-facing artifact, not yet machine-consumed).

## What NOT to do (carried over from this session's hard boundaries)

- Do not create a real `.yml` file under `.github/workflows/` without a
  human reviewing this design first — a workflow file is live the instant
  it's committed and can trigger against the real production site.
- Do not wire Search Console or any other network/paid API into this
  pipeline without new, explicit credentials and sign-off — nothing in
  Phases 1-8 calls out to the network, and that should stay true until a
  human deliberately changes it.
