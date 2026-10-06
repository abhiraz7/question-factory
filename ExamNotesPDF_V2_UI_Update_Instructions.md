# Practical V2 UI/Workflow Update Instructions

> **Status (2026-09-11): appears done.** `update-factory/index.html` exists
> (3,000+ lines) and implements the core asks: `state.isUpdate`/`oldSeo`/
> `oldBodyHtml`, slug preserved from the old post
> (`state.seo.slug = state.oldSeo.slug`), a before/after word-count
> comparison, and hard-fail checks for placeholder images/unresolved
> `[bracket]` text. Kept here as a design-decision record rather than
> deleted (this file isn't tracked by git, so deleting it would lose it for
> good) — worth a quick pass against §25–28's acceptance-test checklist
> before fully retiring it, but not treated as an open task list anymore.

## Purpose

We are simplifying the next development step.

We already have two working browser tools:

- `index(1).html` = current **Notes Factory** for normal notes.
- `index(2).html` = current **Long Post Factory** for 6,000–8,000 word long posts.

We now need:

1. A **new third page** for updating existing published notes.
2. A focused improvement of `index(2).html` so its UI/workflow feels like the better `index(1).html`.
3. Fix the concrete quality/pipeline problems already identified.
4. **Do not add API-key costs or build a new backend.**
5. **Do not redesign the whole system.**
6. **Do not rewrite the master content prompt yet.** Prompt changes are a separate next step.

The admin is busy and realistically handles a maximum of about **5 content items/day**. The interface therefore must stay extremely simple.

---

# 1. Non-negotiable principle

Keep the current architecture:

```text
Browser HTML tool
        ↓
Copy prompt
        ↓
Gemini Pro (manual)
        ↓
Paste response
        ↓
Parse
        ↓
Review + Preview + Validation
        ↓
Save to GitHub
        ↓
GitHub Actions
        ↓
WordPress
```

There is NO requirement in this task for:

- Gemini API
- OpenAI API
- Anthropic API
- embeddings service
- vector database
- Supabase
- Pinecone
- new backend
- automatic AI generation
- automatic publishing without review

The existing manual Gemini workflow remains the content-generation method.

---

# 2. Use `index(1).html` as the UI reference

`index(1).html` is the canonical UX.

It already has the useful 4-step pattern:

```text
1. Build & copy prompt
2. Paste AI reply
3. Review & edit
4. Save to GitHub
```

It also already has:

- mobile-first layout
- step progress rail
- preview iframe
- validation UI
- GitHub save
- pipeline tracking
- draft recovery
- batch queue
- update-mode logic
- WordPress post ID carry-forward

Do not create a completely different visual language.

The new update factory and the improved long-post factory should feel like siblings of `index(1).html`.

Relevant current structure:
- `index(1).html` uses the four-step rail and bottom navigation. fileciteturn1file0L135-L179
- `index(1).html` already contains preview + validation in Step 3 and GitHub save in Step 4. fileciteturn2file1L101-L104
- `index(2).html` has the same general four-step concept but its long-post-specific prompt/UI has become a more mixed/blended experience. fileciteturn5file4L44-L64

---

# 3. NEW FILE — create `index-update.html`

Create a separate page:

```text
index-update.html
```

Do NOT replace `index(1).html`.

Do NOT add update complexity into the normal create workflow.

The purpose of this page is:

> Select an already-published note → build a revision prompt → paste Gemini's improved response → review → update the SAME WordPress post.

---

# 4. Update Factory must keep the same four steps

## Step 1 — Select existing note + build prompt

The current `index(1).html` already contains an old-note file selector and revision logic. Reuse that proven behavior instead of inventing another mechanism. It reads the JSON, loads old SEO/body, and carries the WordPress metadata forward. fileciteturn3file3L206-L220

For the new dedicated page, make Step 1 clearer:

```text
1 · Select note & build update prompt

Published note
[ Choose published-notes/*.json ]

Loaded:
Food and Nutrition CTET Notes 2026

WordPress Post:
#123

Current words:
2,136

Update goal:
[ Improve this note ]

Optional focus:
[ ] Improve NCERT grounding
[ ] Fix weak/unsupported claims
[ ] Improve exam usefulness
[ ] Improve explanations/examples
[ ] Improve PYQ section
[ ] Add missing topic coverage

[ Build update prompt ]
```

Do not require the admin to understand slugs, GitHub paths, or JSON.

The existing JSON remains the source identifier for now. We can build title/post-ID lookup later.

---

# 5. The update prompt should include the current note

The generated prompt must pass to Gemini:

```text
CURRENT TOPIC
CURRENT EXAM
CURRENT SUBJECT
CURRENT SEO
CURRENT BODY
CURRENT PUBLISHER NOTES
```

and clearly state:

```text
This is an UPDATE of an already-published note.

Keep the same URL slug.
Keep correct/useful content.
Improve weak content.
Do not rewrite good material merely to make it different.
Do not invent facts, PYQs, statistics, citations, exam predictions, or sources.
Remove unsupported claims when evidence is not available.
```

The existing code already forces the old slug during update and carries the old WordPress object into the bundle. Preserve that behavior. fileciteturn3file2L97-L112 fileciteturn4file2L289-L300

### Important

Do not implement the new prompt strategy in this coding task.

Only make the page capable of constructing an update prompt cleanly.

We will replace/refine the actual content-generation prompt afterward.

---

# 6. RAG support: prepare only the prompt slot

Do NOT build an RAG engine in this task.

Add a small optional source section in the update prompt builder:

```text
Reference corpus URL:
https://.../ncert_corpus.csv

Optional source URLs:
[textarea]
```

The generated Gemini prompt can say:

```text
Use the supplied reference corpus and source URLs as supporting material.
Use only relevant information.
Do not copy source text.
Do not invent unsupported claims.
```

That is enough for now.

No API.

No embeddings.

No database.

---

# 7. Step 2 — keep exactly the same

Use the current Notes Factory Step 2 pattern:

```text
2 · Paste the AI's reply
```

Keep:

- normal paste
- continuation mode
- parser
- parser errors
- retry/continue support

Do not redesign the parser unless required for update compatibility.

---

# 8. Step 3 — review must be update-aware

Keep the same fields and preview from `index(1).html`.

Show a small badge:

```text
🔄 UPDATE MODE
This will update WordPress post #123.
The URL will remain unchanged.
```

Then add ONE small panel:

```text
Update summary

Previous: 2,136 words
New:      2,584 words

Sections changed: 6
Sections retained: 5
```

If technically easy, show a basic before/after summary based on the old and new body.

Do not build a complicated diff editor.

The admin needs confidence, not another application.

---

# 9. Validation must remain part of the workflow

The current Notes Factory already runs validation against the actual HTML rather than trusting AI-reported numbers. Preserve this. fileciteturn2file1L13-L21

Strengthen the hard checks with the known failures found in the audit:

## Hard fail

Reject the save when content contains:

```text
[exact keyphrase]
[insert]
[write here]
[entire notes body HTML]
Lorem ipsum
undefined
null
via.placeholder.com
```

Also catch:

```text
```html
html
```

when these are pipeline artifacts rather than intentional content.

Also reject:

- empty body
- broken HTML
- missing slug
- missing required SEO values
- missing WordPress post ID in update mode

Do not remove the existing override mechanism, but the UI should make it obvious that override is an exceptional action.

---

# 10. Important quality findings to address now

These findings came from the content-pipeline audit and should influence the validators/UI.

## Finding A — prompt scaffolding reached production

A published note contained literal placeholders such as:

```text
[exact keyphrase]
[entire notes body HTML]
```

This happened because the production workflow only checked a few fields for non-empty values. fileciteturn0file0L81-L102 fileciteturn0file0L163-L169

The browser validator should catch these before GitHub save.

## Finding B — placeholder image

15 published notes contained `via.placeholder.com` images. fileciteturn0file0L104-L135

Do not allow a generated note to enter the queue with a placeholder image.

For a note that intentionally has no image, absence is acceptable.

A placeholder is not acceptable.

## Finding C — repeated template

The audit found the same Memory Trick / Common Mistake / Practice Question rhythm repeated across most notes. fileciteturn0file0L137-L143

Do not try to solve this in the UI.

The prompt will be redesigned later.

The current code task should only ensure it is possible to generate/update notes without forcing additional UI template blocks.

## Finding D — leaked `html` artifact

One published article exposed a literal `html` prefix from a markdown code fence. fileciteturn0file0L145-L161

The parser/validator should strip or flag this reliably before save.

---

# 11. Update Factory Step 4

Keep exactly the same GitHub publishing architecture.

For update mode:

```text
pending-notes/<same-slug>.json
        ↓
bundle.wordpress.postId = original postId
        ↓
GitHub Actions
        ↓
PUT existing WordPress post
```

The existing bundle logic already supports carrying the WordPress object forward for updates. fileciteturn4file2L289-L300

Do not create a duplicate post.

Do not change the slug.

Do not change publish status accidentally.

Do not build a second WordPress publishing mechanism.

---

# 12. Improve `index(2).html` — Long Post Factory

The long-post tool should remain a separate tool.

But visually and operationally it should look like `index(1).html`.

## Keep:

- long-post-specific prompt
- long-post block-tag system
- 6,000–8,000 target
- long-post parser
- long-post validation
- featured image workflow
- GitHub publishing
- long-post directory

## Change:

Make the UI feel like a cleaner sibling of Notes Factory.

Current long-post content generation has become very instruction-heavy and the page combines generic factory behavior with long-post-specific mechanics. For example, the current prompt requires 6,000–8,000 prose words and many fixed block/SEO constraints. fileciteturn4file1L142-L174

Do not remove those requirements yet.

We will change the prompt later.

The immediate job is to make the **application UI cleaner**.

---

# 13. `index(2).html` should use the same visual structure as `index(1).html`

Target:

```text
Header
Progress rail

STEP 1
Build & copy prompt

STEP 2
Paste AI reply

STEP 3
Review & edit
Preview
Validation

STEP 4
Save to GitHub

Bottom:
Back | Next
```

The long-post factory already has this concept, but it should not feel like a separate “blended” application.

Use the same:

- typography
- spacing
- buttons
- cards
- rail
- bottom navigation
- messages
- preview
- validation layout
- pipeline mini-widget

The user should immediately understand:

> “This is the same factory, but for a different content type.”

---

# 14. Fix the Long Post image workflow without redesigning it

`index(2).html` already has a proper featured-image flow where the image can be pasted/selected, metadata is stripped, the image is resized, and the image is uploaded during save. fileciteturn4file3L363-L442

Keep that.

But improve the wording so the admin understands:

```text
Featured image
Optional but recommended

Generate in Gemini/ChatGPT → paste or upload here.
The tool will process it and attach it during save.
```

Do not make image generation another factory step.

---

# 15. Fix the Long Post “blend” problem

The long-post page should not feel like:

```text
generic article writer
+
notes factory
+
SEO factory
+
image factory
```

It should simply feel like:

```text
LONG POST FACTORY
```

The UI should expose only what matters to the administrator:

### Step 1

Topic / Exam / Subject / Language

### Step 2

Paste Gemini response

### Step 3

Review + image + preview + validation

### Step 4

Save

Everything else stays collapsed or secondary.

---

# 16. Do not increase the number of UI steps

Both tools must remain four steps.

Do not introduce:

```text
Research
Evidence
Blueprint
AI QA
Editorial QA
SEO QA
Design QA
Publish QA
```

Those are backend/prompt concepts, not user-facing workflow steps.

The busy admin needs the existing simple sequence.

---

# 17. Queue: keep it simple

The existing factories already have a batch queue.

Keep it.

But do not turn it into a production management system.

Maximum practical daily workflow:

```text
Create/update note
→ review
→ queue
→ repeat
→ save batch
```

The admin should be able to handle around five items without navigating away from the tool.

---

# 18. Draft recovery and progress tracking must remain

Do not remove:

- browser draft recovery
- GitHub save
- pipeline mini-widget
- GitHub Actions status

These are useful operational features already present in the existing tools. The current save flow tracks GitHub → Actions → WordPress. fileciteturn2file4L217-L244

---

# 19. Important: do not expose secrets unnecessarily

The current tools use an unlock flow and session storage for GitHub saving.

Do not introduce any new API credential requirement.

Do not add Gemini API credentials.

Do not add OpenAI API credentials.

Do not hard-code new provider keys into either HTML file.

Reuse the current GitHub save mechanism.

---

# 20. Update-mode safety

When `index-update.html` loads a published note:

```text
state.isUpdate = true
state.oldSeo = old.seo
state.oldBodyHtml = old.bodyHtml
state.wordpress = old.wordpress
```

At parse time:

```text
new slug = old slug
```

At bundle time:

```text
bundle.wordpress = old.wordpress
```

This behavior already exists in the current Notes Factory and must remain intact. fileciteturn3file2L97-L112 fileciteturn3file1L172-L180

---

# 21. Do not implement automatic title/post-ID search yet

The dedicated update page may initially use:

```text
Choose published-notes/*.json
```

This is acceptable for V2.

Later we can add:

```text
Search by title
Search by post ID
```

Do not delay this implementation because of search.

The priority is a reliable update pipeline.

---

# 22. Preserve compatibility with existing JSON

Do not change the published-note JSON structure unless necessary.

Existing fields such as:

```text
topic
examType
subject
targetYear
hindiPercent
seo
bodyHtml
publisherNotes
createdAt
wordpress
```

must continue working.

The update tool should produce the same basic bundle shape, adding/updating only what is necessary for revision metadata.

---

# 23. Add lightweight revision metadata

For update bundles, add only if convenient:

```json
{
  "revision": {
    "isUpdate": true,
    "previousPostId": 123,
    "updatedAt": "..."
  }
}
```

Do not build a full version-management database yet.

Git already gives us history.

---

# 24. Do not break the current production flow

After changes:

## `index(1).html`

Must continue to create normal notes exactly as before.

## `index(2).html`

Must continue to create long posts exactly as before.

## `index-update.html`

Must update an existing note instead of creating a new post.

Test all three separately.

---

# 25. Acceptance test — `index(1).html`

Verify:

```text
Create note
→ prompt copied
→ Gemini response pasted
→ parsed
→ preview works
→ validation works
→ GitHub save works
→ pending-notes file created
→ Actions runs
→ WordPress post created/updated correctly
```

Do not change content semantics yet.

---

# 26. Acceptance test — `index(2).html`

Verify:

```text
Create long post
→ prompt copied
→ Gemini response pasted
→ long-post markers parsed
→ preview works
→ featured image works
→ validation works
→ GitHub save works
→ pending-long-posts file created
→ WordPress draft/publish workflow works
```

The UI must now visually match the Notes Factory.

---

# 27. Acceptance test — `index-update.html`

Use an existing published note.

Example:

```text
Food & Nutrition
```

Run:

```text
load published JSON
→ old title/body appears
→ update mode visible
→ prompt contains old content
→ Gemini returns revised content
→ parser works
→ old slug preserved
→ old postId preserved
→ validation passes
→ GitHub pending file uses same slug
→ publish workflow updates existing WordPress post
```

Critical test:

> It must NOT create a second WordPress post.

---

# 28. Validation regression tests

The UI must reject these:

```html
[exact keyphrase]
```

```html
[entire notes body HTML]
```

```text
via.placeholder.com
```

```text
html
<h1>...
```

```html
<script>...</script>
```

broken/unclosed HTML

missing body

missing slug

missing post ID in update mode

---

# 29. What NOT to do in this coding pass

Do not:

- rewrite the master prompt
- add Gemini API
- add RAG infrastructure
- add embeddings
- add a database
- redesign WordPress
- replace the existing GitHub workflow
- create a new backend
- create a new CMS
- create multi-agent orchestration
- add 10 user-facing workflow steps
- automatically publish AI output without the existing review/validation stage

Those come later only when justified.

---

# 30. Next phase after this implementation

Once these three pages are stable:

```text
index(1).html       → Create Note
index(2).html       → Create Long Post
index-update.html   → Update Note
```

THEN we change the content prompts.

The next prompt version should incorporate:

- NCERT corpus
- source URLs
- stronger factual discipline
- no unsupported exam statistics
- no invented PYQs
- better topic-specific structure
- less templated writing
- natural SEO
- better human usefulness

But do not mix that prompt rewrite into this implementation task.

---

# Final implementation priority

### Priority 1
Create `index-update.html` by reusing the proven Notes Factory architecture.

### Priority 2
Make `index(2).html` visually and operationally consistent with `index(1).html`.

### Priority 3
Strengthen the existing validation against the real failures already found.

### Priority 4
Verify create + update + long-post publishing end-to-end.

### Priority 5
Only after the tools are stable, redesign the content-generation prompts around the RAG corpus.

The objective is a **small, reliable upgrade**, not a platform rewrite.
