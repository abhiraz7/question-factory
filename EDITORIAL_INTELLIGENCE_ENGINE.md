# Editorial Intelligence Engine — Architecture Specification

## 1. Purpose

Build an evidence-driven, statistically informed editorial intelligence system for ExamNotePDF.

This is **not an AI content generator**.

Its job is to decide what the next note should teach and what educational shape is appropriate.

The AI writer retains creative freedom.

---

## 2. Core architecture

```text
Search Console
Existing content
Content memory
NCERT/BM25
RAG
PYQs/question data
Source evidence
Historical outcomes
        ↓
STATISTICAL ENGINE
        ↓
TOPIC STATE
        ↓
EDITORIAL DECISION ENGINE
        ↓
EDITORIAL GENOME
        ↓
SMALL EDITORIAL BRIEF
        ↓
FREE AI WRITER
        ↓
VALIDATION
        ↓
PUBLISH
        ↓
POST-RUN
        ↺
```

Statistics is a first-class layer, not an optional decoration.

---

## 3. Separation of responsibilities

### Evidence layer

Determines:

- what sources exist
- what concepts are supported
- what evidence is available
- source confidence/provenance

### Statistical layer

Determines:

- distributions
- frequencies
- trends
- coverage
- repetition
- confidence
- similarity
- uncertainty
- exploration/exploitation

### Editorial decision layer

Determines:

- what concepts deserve emphasis
- what misconceptions deserve attention
- whether comparison is useful
- whether examples are useful
- whether a process/sequence is important
- how much revision should be included
- what has recently been overused

### Editorial genome

Represents the pedagogical shape of the note.

Example:

```json
{
  "opening": "problem",
  "concept_order": "cause_to_effect",
  "example_density": 0.34,
  "comparison_need": 0.82,
  "table_need": 0.71,
  "classroom_examples": 3,
  "misconception_depth": 0.61,
  "revision_density": 0.18,
  "question_integration": 0.43,
  "analogy_use": 0.27,
  "section_count": 7
}
```

These are educational decisions, not prose instructions.

---

## 4. Topic state

Each topic should eventually have a machine-readable state.

Conceptually:

```json
{
  "topic": "...",
  "subject": "...",
  "exam": "...",
  "coverage": {},
  "evidence": {},
  "learner_signals": {},
  "difficulty": {},
  "misconceptions": {},
  "recent_structures": {},
  "similarity": {},
  "confidence": {},
  "last_updated": "..."
}
```

The topic state is more important than having one universal article template.

---

## 5. Statistical engine

Use statistics only where it changes an editorial decision.

Useful signals include:

### Frequency distributions

What concepts, examples, structures, and question types have appeared?

### Recency-weighted frequency

Recent repetition should matter more than old repetition.

### EWMA

Use exponentially weighted moving averages for recent structural/content patterns.

### Similarity

Existing:

`Automation/core/src/similarity-check.mjs`

can become an input signal rather than only a post-publish warning.

### Entropy

Measure whether the recent editorial system is becoming structurally repetitive.

### Jensen-Shannon divergence

Compare recent editorial distributions with historical distributions without relying on raw asymmetric KL values.

### Bayesian updating

Start with a prior.

Update with evidence.

Maintain confidence.

Do not treat every observation as proof.

### Coverage probability

Estimate which important concepts have already been sufficiently covered.

### Exploration/exploitation

Do not always select the most obvious/high-frequency structure.

Reserve controlled room for useful alternatives.

---

## 6. Important rule: no fake randomness

Do not randomize the editorial shape simply to make posts look different.

Variation must be pedagogically justified.

Bad:

```text
randomly choose table
randomly choose analogy
randomly choose five sections
```

Good:

```text
comparison_need = high
because concepts are commonly confused
→ comparison structure becomes appropriate
```

---

## 7. Existing content memory

Reuse:

`Automation/content-memory/*.json`

This already records useful historical information such as:

- concepts taught
- misconceptions
- examples
- flavour
- article shape
- question types

Do not create a parallel historical database unless the existing schema genuinely cannot support the required state.

---

## 8. Existing flavour engine

Reuse:

`Automation/core/src/flavour-engine.mjs`

and:

`shared/flavour-engine.js`

The existing flavour scorer is a useful narrow editorial decision system.

Do not replace it.

Editorial Intelligence should eventually provide broader decisions and allow the flavour engine to remain responsible for flavour selection.

---

## 9. First implementation module

Create:

```text
Automation/core/src/editorial-intelligence.mjs
```

Initial API:

```js
buildEditorialSignature(ctx, recentMemory)
```

It should be:

- pure
- deterministic
- unit-testable
- dependency-light
- independent of prompt text

Initial output can be:

```json
{
  "avoidConcepts": [],
  "avoidExamples": [],
  "underusedMisconceptions": [],
  "coverageGaps": [],
  "recommendedStructures": [],
  "confidence": 0
}
```

Do not immediately build the complete statistical system.

Grow it incrementally.

---

## 10. Editorial brief

The Editorial Intelligence engine should eventually produce a compact brief.

Example:

```json
{
  "teach": [],
  "emphasize": [],
  "clarify": [],
  "useEvidence": [],
  "avoidRepeating": [],
  "pedagogicalShape": {},
  "confidence": 0
}
```

Then convert that into a small prompt block.

The AI writer remains free to choose:

- wording
- examples
- explanation style
- sentence structure
- transitions
- tone

The brief should not prescribe prose.

---

## 11. Search Console

Search Console should be treated as a learner-intent signal.

It should help answer:

```text
What are learners actually searching for?
Which questions are emerging?
Which topics have weak coverage?
Which queries are repeatedly associated with a topic?
```

Do NOT convert Search Console directly into keyword stuffing instructions.

---

## 12. RAG relationship

RAG supplies evidence.

Editorial Intelligence decides how that evidence should influence teaching.

Example:

```text
RAG:
Photosynthesis contains evidence about light reactions,
Calvin cycle, chlorophyll and glucose formation.

Statistics:
Calvin-cycle misconceptions are under-covered.

Editorial decision:
increase misconception treatment.

Writer:
freely explains the topic.
```

---

## 13. NEXT_POST_READY

After every successful publishing cycle, generate:

```text
generated/editorial/next-post-ready.json
```

Conceptually:

```json
{
  "topic": "...",
  "subject": "...",
  "exam": "...",
  "topicState": {},
  "evidence": {},
  "statistics": {},
  "editorialDecision": {},
  "editorialGenome": {},
  "editorialBrief": {},
  "confidence": 0,
  "generatedAt": "..."
}
```

The next post must begin from this state rather than recomputing everything from zero.

---

## 14. Post-run

Every successful deployment should trigger:

```text
POST DEPLOY
    ↓
update content memory
    ↓
update concept coverage
    ↓
update similarity
    ↓
update structural distributions
    ↓
update topic state
    ↓
update statistical state
    ↓
refresh editorial decisions
    ↓
select/evaluate next candidate
    ↓
generate next-post-ready
```

This creates the learning loop:

```text
observe
→ measure
→ decide
→ write
→ publish
→ observe again
```

---

## 15. GitHub Actions architecture

Use independent jobs wherever possible.

```text
             ┌─ RAG refresh
             ├─ Search Console refresh
POST-RUN ────┼─ Content memory analysis
             ├─ Similarity analysis
             ├─ Topic coverage
             └─ Statistical analysis
                     ↓
              MERGE STATE
                     ↓
             EDITORIAL DECISION
                     ↓
              NEXT POST READY
```

Avoid circular workflow triggers.

Use explicit workflow boundaries and artifacts.

---

## 16. Runtime architecture

Expensive work:

```text
GitHub Actions
```

Fast work:

```text
mobile browser
```

The browser should read a compact static artifact.

The browser should NOT:

- build indexes
- run BM25 over the entire corpus
- calculate site-wide statistics
- analyze all historical articles
- call expensive external services

---

## 17. Universal copy/paste limit

Do not depend on a device-specific clipboard limit.

Create one application-level constant:

```js
const MAX_COPY_CHARS = 18000;
```

This is the strict maximum for any general copy operation generated by Notes Factory.

### Rule

Every copy operation must pass:

```js
text.length <= MAX_COPY_CHARS
```

If it exceeds the limit:

1. Do NOT silently truncate.
2. Do NOT copy a partial prompt.
3. Automatically split into labeled chunks.
4. Every chunk must be `<= MAX_COPY_CHARS`.
5. Show the user the chunk count.
6. Allow copying one chunk at a time.
7. Preserve exact text order.

Example:

```text
COPY 1 / 3
COPY 2 / 3
COPY 3 / 3
```

Each chunk should have an explicit boundary marker.

### Why 18,000?

It deliberately leaves headroom below commonly encountered mobile clipboard limits.

The application must treat 18,000 as its own contract regardless of whether a particular keyboard, browser, Android version, or iOS version supports more.

Do not claim that 18,000 is a universal OS limit.

It is the application's universal copy contract.

---

## 18. One copy utility

Do not implement separate character-limit logic throughout the UI.

Create one shared utility, conceptually:

```js
copyWithLimit(text, options)
```

All copy buttons must eventually use it.

It should:

- count characters
- enforce the limit
- split oversized content
- preserve content exactly
- expose chunk metadata
- handle clipboard failure
- avoid silent truncation

This prevents future UI features from bypassing the limit.

---

## 19. Important distinction

The character limit applies to:

```text
COPY OPERATION
```

It does not necessarily limit:

- stored files
- GitHub files
- RAG packages
- internal JSON
- generated indexes
- WordPress content
- AI output

Only the user-facing general copy/paste operation needs the strict limit.

---

## 20. Non-goals

Do not:

- redesign mobile UI
- add desktop UI
- constrain AI prose
- create one universal article template
- use randomness to simulate diversity
- use statistics to manipulate AI detectors
- create unnecessary paid infrastructure
- replace existing content-memory
- replace the flavour engine
- replace existing publishing

---

## 21. Implementation sequence

### Phase 1

Create pure Editorial Intelligence scorer.

### Phase 2

Create tests against real content-memory.

### Phase 3

Create RAG ingestion validator.

### Phase 4

Connect RAG retrieval.

### Phase 5

Build statistical state.

### Phase 6

Build topic state.

### Phase 7

Generate editorial genome.

### Phase 8

Generate compact editorial brief.

### Phase 9

Add GitHub parallel workflows.

### Phase 10

Add post-deployment next-post preparation.

### Phase 11

Connect Notes Factory.

### Phase 12

Centralize the 18,000-character copy contract.

Each phase should be independently deployable.
