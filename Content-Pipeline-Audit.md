# Content Pipeline Audit

**Why AdSense flagged the site for low-value content**

- Site: this site
- AdSense status: *Needs attention — Low value content*
- Scope: `notes-factory` pipeline (37/37 published notes reviewed) and `long-post-factory` pipeline (1/1 published long post reviewed)
- Method: direct inspection of every file in `published-notes/`, `published-long-posts/`, both publish workflows, and `automation/`, cross-referenced against Google's own policy language (sources in §2)

> **Status check (2026-09-11), not a full re-audit:** F1/F2-shaped defects
> (unfilled prompt scaffolding, `via.placeholder.com` images) now have
> client-side hard-fail checks in `notes-factory/index.html` before a human
> saves to `pending-notes/` — spot-checked present in the current file.
> **F5's core finding likely still stands**: `.github/workflows/publish-note.yml`
> and `publish-long-post.yml` still only appear to do the same weak 3-field
> non-empty check this audit describes, and `Automation/core/src/validate-bundle.mjs`
> (the real hard-fail checker, formerly `automation/src/validate-bundle.mjs`)
> still isn't called by either production workflow — only by
> `Automation/long-post-runner/run_pipeline.py` before a file is even
> committed. That means content saved through the browser tools still
> reaches WordPress with only the client-side JS as a gate, not anything
> server-side. Verify against the current workflow YAML before treating F5
> as closed. Folder paths in the body below also predate the
> `Automation/{core,ncert-knowledge-base,long-post-runner}/` rename.

---

## 1. Problem statement

AdSense marked the site **"Needs attention — Low value content"** and is withholding ad serving pending a fix. This is not a ranking or traffic problem to write around — it's an eligibility gate, and the site's own content pipeline is the direct cause.

Both `notes-factory` and (to a lesser extent) `long-post-factory` generate pages through an unsupervised flow — AI prompt → JSON bundle → GitHub Actions → WordPress draft — with **no automated content-quality gate between generation and publish**. That gap has let at least one page ship as raw, unfilled prompt-template text, let a single visual card template repeat across the majority of notes, and let 15 notes go live carrying a literal broken placeholder image — the single clearest "site under construction" signal a manual reviewer can find.

Every finding in §3 is tied to a specific policy clause and a specific file, byte range, or workflow step, so each is independently fixable and independently verifiable — this report is written to be actioned, not just read.

## 2. What we are, and how publishing is automated today

Before the findings, it's worth being precise about what this system actually is — because the fix in §6 has to slot into it without breaking what already works.

**What we are:** this is a WordPress site publishing exam-prep content for Indian teaching-eligibility exams (CTET, TET, TGT/PGT, KVS/NVS, BPSC TRE, etc.) in two content types on the same underlying pattern:

- **Notes** (`free_notes` post type) — short-to-medium topic notes (Algebra, EVS, Pedagogy, etc.), authored in `notes-factory/`
- **Long Posts** — longer, exam-overview articles (e.g. "CTET Exam Date 2026"), authored in `long-post-factory/`

Both are AI-generated, both go through the same four-stage shape, and both end up as real WordPress posts with real URLs indexed by Google — which is exactly why AdSense treats them under one policy, not two.

### 2.1 The four-stage pipeline (both content types)

```
 1. GENERATE            2. STAGE                3. PUBLISH (CI)              4. RECORD
 ──────────────        ─────────────           ─────────────────           ─────────────
 A person opens        A JSON "bundle" is       GitHub Actions picks up     On success, the
 notes-factory/         written to               the file on push to        bundle is moved to
 index.html (or         pending-notes/<slug>     main, POSTs (or PUTs)      published-notes/
 long-post-factory/     .json — or               it to the WordPress        <slug>.json (or the
 index.html) in a       pending-long-posts/      REST API                   long-post equivalent
 browser, fills in       for long posts                                     index), stamped with
 topic/exam/subject,                             .github/workflows/         the real WP postId,
 pastes a hand-run                                publish-note.yml           link, and timestamp
 AI reply back in                                (or publish-long-
                                                   post.yml)
```

**Stage 1 — Generate.** For both notes and long posts, this is 100% manual today: a person opens `notes-factory/index.html` (or `long-post-factory/index.html`) in a browser, picks exam/subject/topic, the tool builds a prompt from `MASTER-PROMPT-ExamNotesPDF_v12.md` (the latest of three versions in the repo root) or the equivalent long-post master prompt, the person runs that prompt through an AI chat session by hand, and pastes the reply back into the tool, which parses it into the JSON bundle shape. `automation/src/run-batch.mjs` exists in the repo as an experimental/testing batch runner for long posts, but it is **not part of the live publishing pipeline** and isn't in production use — the manual browser-tool path above is the real Stage 1 for both content types today.

**Stage 2 — Stage.** Whichever path produced it, the output is one JSON file per note/post — `{ topic, examType, subject, seo: {...}, bodyHtml, publisherNotes, createdAt }` — written to `pending-notes/<slug>.json` or `pending-long-posts/<slug>.json` and committed to the repo.

**Stage 3 — Publish (CI).** A push to `main` touching `pending-notes/**.json` triggers `.github/workflows/publish-note.yml` (long posts: `publish-long-post.yml`, same shape). For each pending file it: resolves the exam/subject labels to WordPress taxonomy term IDs (creating the term if it doesn't exist yet), wraps `bodyHtml` in a Gutenberg Custom-HTML block, strips a leading `<h1>` and HTML comments, and calls the WordPress REST API (`/wp-json/wp/v2/free_notes`) with the site's app-password credentials (`WP_SITE_URL`, `WP_USERNAME`, `WP_APP_PASSWORD` — GitHub Actions secrets). New notes `POST` (create); notes that carry a `wordpress.postId` forward from a previous publish `PUT` instead (update in place — see §2.2 and §6).

**Stage 4 — Record.** On a successful WordPress response, the workflow writes the returned `postId`/`link`/`publishedAt` into the bundle and moves it from `pending-notes/` to `published-notes/<slug>.json`, then commits that move back to `main` (`git commit -m "... [skip ci]"`) so the loop doesn't retrigger itself. **There is no aggregate index of what's published** — `published-notes/` is 37 separate JSON files, one per note, with the slug as filename and `wordpress.postId` as the only durable link back to WordPress. Long posts have the same per-file bundle shape but *do* additionally maintain `published-long-posts/index.json`, a flat array of published slugs.

### 2.2 The update mechanism that already exists (and is underused)

This matters directly for §6. The publish workflow already supports updating a *live* post, not just creating new ones — it's just never been wired up to a repeatable, non-technical workflow:

- If a pending bundle's JSON carries `wordpress.postId` (copied from an already-published `published-notes/<slug>.json`), the workflow sends `PUT /wp-json/wp/v2/free_notes/<postId>` instead of `POST .../free_notes`.
- It also deliberately **drops `status` from the update payload** — so refreshing a note's content can never silently revert a live "publish" back to "draft." WordPress leaves any field you don't send unchanged.
- `notes-factory/index.html` already has a manual "revision" mode for this: pick a file from `published-notes/`, and the tool prefills topic/exam/subject and switches its prompt-builder into a revision prompt that feeds the AI the old SEO + body as context, so the rewrite keeps the same slug and quality bar instead of starting from a blank page.

In other words: **the WordPress-side machinery to update a post safely already works.** What's missing is everything around it — see §6.

## 3. The policy floor we're being held to

Four Google documents define "low value" for this review. Read together, they reduce to one test: **does a page contain enough original, substantive, finished material that a human reader — not a template — clearly made it?**

| Source | What it requires |
|---|---|
| [AdSense — Minimum content requirements](https://support.google.com/adsense/answer/10502938#minimum_content_requirements) | Sites need "enough unique content" for Google to determine what the site is about, with "substantial value and originality" versus other sites. Pages with little-to-no content, or content padded via automated/synonym-swapped rewriting, fail outright. |
| [AdSense — Valuable inventory](https://support.google.com/adsense/answer/10015918) | Ads are disallowed on screens that are "under construction," carry "low-value content," or where paid/promotional material outweighs actual publisher content on the page. |
| [Search spam policies — Thin content](https://support.google.com/webmasters/answer/9044175#thin-content) | Names three concrete failure shapes: scraped content, thin affiliate pages, and doorway pages — all defined by the absence of original analysis or material differentiation from what already exists. |
| [Publisher policies — Content standards](https://support.google.com/publisherpolicies/answer/11035931) | Prohibits keyword stuffing, "unnecessary, repeated use of keywords" that add no value, and claiming content or services a page doesn't actually deliver. |

## 4. Findings

Ordered by severity. F1 fails every policy above simultaneously on its own; F2–F5 are systemic patterns present across many pages.

### F1 — Critical — A live post whose entire body is unfilled prompt scaffolding

**Violates:** minimum content requirements · valuable inventory ("under construction") · thin content

**File:** `published-notes/every-keyphrase-word-in-order-lowercase-hyphenated-75-chars.json` — **1,517 bytes**, versus 18,700–24,500 bytes for a normal note in this repo.

**Live as:** WordPress post **#295** — `https://examnotespdf.in/?post_type=free_notes&p=295`

The AI never received real inputs for this generation run; it echoed the prompt's own instruction placeholders back as final content, and the pipeline published them verbatim:

```json
"seo": {
  "focusKeyword": "[exact keyphrase]",
  "seoTitle": "[per formula above; keyphrase FIRST; ≤60 chars]",
  "slug": "every-keyphrase-word-in-order-lowercase-hyphenated-75-chars",
  "metaDescription": "[150–155 chars, keyphrase once, honest]",
  "h1": "[keyphrase FIRST] — [Hindi sub-line after]"
},
"bodyHtml": "[entire notes body HTML]"
```

**Impact:** this is the single strongest "low value content" signal a manual reviewer could find on the site — a published page whose visible body is the seven words `[entire notes body HTML]`. One page like this in a spot-check is enough to trigger a site-wide policy review, not just a page-level one. It should be treated as the #1 priority fix, ahead of everything else in this report.

### F2 — High — 15 of 37 notes ship a literal placeholder image URL

**Violates:** valuable inventory ("under construction") · minimum content requirements

15 published notes embed `<img src="https://via.placeholder.com/700x350?text=...">` directly inside `bodyHtml`. There is no image-generation or upload step anywhere in `publish-note.yml` — the AI writer emits this placeholder tag and nothing downstream ever replaces it before the page goes live.

**Example** (`algebra-ctet-notes-2026.json`):
```html
<img src="https://via.placeholder.com/700x350?text=Algebra+CTET+Notes+2026+—+Concept+Overview"
     alt="Algebra CTET Notes 2026 — concept overview" style="width:100%;border-radius:12px;margin:14px 0;" />
```

**Affected files (15):**
```
shelter-evs-notes-2026.json
natural-resources-environment-ctet-notes-2026.json
learning-process-ctet-notes-2026.json
human-body-health-evs-notes-2026.json
human-body-health-ctet-notes-2026.json
food-and-nutrition-ctet-notes-2026.json
ctet-mathematics-pedagogy-notes-2026.json
ctet-cdp-assertion-reason-questions-2026-notes.json
agriculture-occupations-ctet-notes-2026.json
vyakaran-ki-bhumika-ctet-notes-2026.json
profit-loss-discount-interest-ctet-notes-2026.json
algebra-ctet-notes-2026.json
mathematics-pedagogy-ctet-notes-2026.json
constructivism-child-centred-learning-ctet-notes-2026.json
factors-affecting-development-and-individual-differences-ctet-notes-2026.json
```

**Impact:** a grey placeholder box reading "700×350" — or, on days `via.placeholder.com` is unreachable, a plain broken-image icon — is the textbook visual for "under construction," the exact phrase AdSense's valuable-inventory policy uses to disqualify a screen from ad serving.

### F3 — High — One dominant visual template repeats across the majority of notes

**Violates:** minimum content requirements ("substantial value and originality" — measured against the site's *own* other pages, not just the wider web) · thin content

31 of 37 notes reuse the same three-card rhythm — a "📌 Memory Trick" box, a "⚠️ Common Mistake" box, and a "❓ Practice Question" box — in the same colors, same emoji, same inline-style attributes, regardless of topic (confirmed by grepping all three phrases across `published-notes/`: 36 occurrences across 31 distinct files). This is a template being filled, not writing: it satisfies a naive word-count target without the "original analysis or perspective" the thin-content policy explicitly asks for.

**Impact:** individually each note clears a word-count bar; read side by side — exactly what a policy reviewer does when spot-checking a site — the site reads as one templated generator running the same skeleton 31 times. The thin-content policy tests differentiation *between a site's own pages*, not only against the wider web, and this pattern fails that test directly.

### F4 — Medium — Leaked pipeline artifacts render as literal on-page text

**Violates:** minimum content requirements (professionalism/finish) · publisher policies (accuracy of what's presented)

**File:** `published-notes/ctet-exam-date-2026-paper-1-2-schedule.json` — live as WordPress post **#370**.

The AI's reply began with a markdown code fence (`` ```html ``), and only the triple backticks were stripped on the way into the JSON — not the language word after them:

```json
"bodyHtml": "html\n<h1 style=\"font-size:28px;...\">CTET Exam Date 2026...
```

`publish-note.yml`'s content-cleaning step only strips a leading `<h1>` tag and HTML comments (see the workflow, lines ~178–188) — nothing catches a stray bare word sitting before the first real tag, so the literal word **"html"** renders at the very top of the live page, above the title.

The same file's `topic` field ("Constructivism & Child-Centred Learning") also doesn't match its actual SEO/body content (CTET exam dates) — a copy-paste artifact from batch generation. This mismatch doesn't reach the live page since only `seo.*`/`bodyHtml` are published, but it's a second, independent piece of evidence for the same root cause below.

**Impact:** lower severity than F1–F3 individually (one page, cosmetic), but it corroborates that nothing checks a generated bundle before it becomes a public page.

### F5 — Structural — No content-quality gate exists between AI output and WordPress

**Root cause for F1–F4.**

`.github/workflows/publish-note.yml` validates exactly three things before publishing (see the workflow's `jq -e` check): that `seo.seoTitle`, `seo.slug`, and `bodyHtml` are non-empty strings. It does **not** check word count, placeholder patterns (`via.placeholder.com`, unresolved `[...]` brackets), leaked scaffolding, or similarity to already-published notes.

`publish-long-post.yml` has the same gap — no stricter check. `automation/` (the experimental/testing batch runner, not part of the live pipeline — see §2.1) does contain a hard-fail checker, `src/validate-bundle.mjs`, but it is **not called by either production workflow**, so it currently protects nothing that actually reaches WordPress. `notes-factory/index.html` plus manual human review is the only real gate today, and F1 demonstrates that gate has already been missed at least once in production.

## 5. Notes vs. Long Post: why the exposure is uneven

The two pipelines share a shape — AI writer → JSON bundle → GitHub Actions → WordPress draft — but differ in exactly the ways that explain why every hard violation above sits in Notes Factory, not Long Post Factory.

| Signal | Notes Factory | Long Post Factory |
|---|---|---|
| Live volume | 37 published | 1 published |
| Pre-publish validator | **None** — 3-field non-empty check only | **None** — same 3-field non-empty check only |
| Placeholder images found | 15 of 37 | 0 of 1 |
| Unfilled prompt scaffolding found | 1 of 37 (F1) | 0 of 1 |
| Batch/automated generation path | None — manual only, via `notes-factory/index.html` | None in production — manual via `long-post-factory/index.html`; `automation/` exists only as an untested/experimental runner |
| Sourced/grounded facts | Free-text prose, uneven sourcing | Free-text prose, uneven sourcing (same manual process; the NCERT-grounded self-check only exists inside the unused `automation/` runner) |
| Update-existing-post path | `wordpress.postId` carried forward → `PUT` (exists, currently underused) | Not built yet |

Read plainly: neither pipeline has an automated quality gate — the gap is structural to both. Notes Factory is simply older and far higher-volume (37 published vs. 1), so it's had more chances to accumulate visible damage, and every concrete violation found in this audit does in fact sit there. That makes it the correct place to spend remediation effort first — but the fix in §7 (a real validator wired into the actual publish workflow) applies equally to `publish-long-post.yml`, and should be added there too before long-post volume grows.

## 6. Problem statement — a non-technical update pipeline for published notes

*This section is written to be handed to another AI (or engineer) as a self-contained brief. It restates the goal from scratch and does not assume the reader has followed §1–5, though the cross-references help.*

### 6.1 Who this is for and what they need

The person who will run this day-to-day is **not technical** — no git, no JSON, no GitHub Actions UI. She currently publishes brand-new notes through `notes-factory/index.html`: a browser page where she picks an exam/subject/topic, gets a prompt, runs it through an AI chat, pastes the reply back in, and clicks publish. That flow works for her today because it hides all the plumbing (JSON bundle shape, git commit, CI trigger, WordPress REST call) behind three visible actions: **fill in a few fields → get a prompt → paste a reply back**.

**The ask:** give her the exact same three-action shape, but for *updating a note that's already live*, identified by something she actually has in front of her — the **post title** or the **WordPress post ID** shown in the WP admin dashboard — not a git filename or a slug she has to go find.

### 6.2 Why this can't just reuse the "create new" flow as-is

It's tempting to say "she already has a revision mode in `notes-factory/index.html`, ship it" — and that mode does exist (see §2.2). But three things make a dedicated update flow necessary rather than optional:

1. **Selection is currently manual and unscoped.** Today, "pick a file from `published-notes/`" means browsing 37 raw JSON filenames on disk. A non-technical user needs to search/select by **title or postId**, the two things she can actually see in the WordPress dashboard she already uses.
2. **Quality must not regress.** §4's findings (placeholder images, templated content, leaked scaffolding) happened *without* anyone intending them — the generation pipeline simply had no floor under it. An update flow that's easy to run repeatedly makes this worse, not better, if it doesn't enforce the same (or a higher) quality bar than first publish. "Updated" must never mean "regenerated and possibly worse."
3. **The blast radius is different.** Creating a new note risks one bad page. Updating an existing note overwrites a page that may already be indexed, ranked, and linked — a bad update is strictly more costly than a bad create, because it destroys a working asset instead of adding a broken one.

### 6.3 Requirements for the solution

**Lookup, not browsing.**
Given a post title (fuzzy match — she won't type it exactly) or a numeric postId, resolve it to the corresponding `published-notes/<slug>.json` file. This requires the index described in §7 (a generated `published-notes/index.json` mapping `postId` ↔ `title` ↔ `slug` ↔ `examType`/`subject`/`publishedAt`) — it does not exist yet.

**Same prompt quality, revision-aware.**
The regenerated content must be built from a prompt that (a) is derived from the same master prompt used for first publish (`MASTER-PROMPT-ExamNotesPDF_v12.md`), so voice/structure/depth stays consistent site-wide, and (b) is explicitly told this is a *revision* — feed it the existing `bodyHtml` and `seo` block as ground truth to improve, not a blank slate to fill, exactly as the existing revision-mode prompt in `notes-factory/index.html` already does (§2.2). This is what keeps "updated" notes at the same quality as "new" ones instead of drifting.

**A quality gate before it ever reaches WordPress — not just an eyeball check.**
Whatever the AI comes back with should be run through the hard-fail validator recommended in §7 (unresolved `[...]` brackets, `via.placeholder.com` URLs, leaked code-fence text, a body shorter than the original) *before* she's shown a "looks good, publish?" screen. She's non-technical; she cannot be the last line of defense against F1-style failures.

**Never touches `status`, always keeps the postId.**
The regenerated bundle must carry `wordpress.postId` forward unchanged, exactly like the existing revision path — this is what makes the publish workflow `PUT` instead of `POST` and is what keeps `status` untouched (§2.2). No new code should reinvent this; it should be reused as-is.

**Same three-action shape as today's publish flow.**
Concretely: *(1) search a title or paste a postId → (2) get a revision prompt, run it, paste the reply back (or, longer-term, let the tool call the AI directly the way `automation/`'s batch runner does for long posts) → (3) review a before/after diff and click "update."* No git, no JSON editing, no knowledge that GitHub Actions exists.

### 6.4 What "success" looks like

She can take any of the 37 (soon: any published note, growing over time) and, without help, refresh one that's gone stale — wrong exam year, thin section, or one of the §4 defects — through an interface that looks and feels like the one she already trusts, and the result is *provably* not lower quality than what's live now, because the same gate that (should) protect first-publish also protects the update.

## 7. Remediation, in the order it should happen

Each step closes a specific finding above and is independently verifiable — none require a pipeline rewrite to start.

### Immediate — before requesting an AdSense review
**Unpublish or fully rewrite the F1 post; replace all 15 F2 placeholder images.**
Delete or draft-hide WordPress post #295, or replace its content entirely. Swap every `via.placeholder.com` reference for a real generated or stock image. These are the two findings a manual reviewer will hit first — both need to be at zero before checking "I have fixed the issues" on the AdSense review request.

### This week
**Add a hard-fail validator to `publish-note.yml`, ported from `validate-bundle.mjs`.**
Reject any pending note whose `bodyHtml` contains an unresolved `[...]` template bracket, a `via.placeholder.com` URL, a leaked code-fence word, or falls under roughly 70% of the site's median note length — before it ever reaches WordPress, not after.

### Next 2–3 weeks
**Revise the 31 templated notes for genuine differentiation.**
The harder, slower fix: vary structure per topic instead of filling the same three-card skeleton 31 times. The update mechanism already exists — a pending note carrying `wordpress.postId` forward triggers a `PUT` instead of a `POST`, so the same post is updated in place rather than duplicated. This is a content problem, not a pipeline problem, and the highest-value use of that existing mechanism.

### Ongoing
**Build the staleness index, then the non-technical update pipeline specified in §6.**
A generated `published-notes/index.json` (there is currently no aggregate index — one JSON file per note) is the prerequisite for title/postId lookup in §6.3. On top of it: a small batch runner mirroring `automation/`'s pattern, wired to the revision-mode prompt and the §7 validator, turns "find and fix thin notes" from a one-time audit into a repeatable, non-technical, monthly pass — the direct answer to §6's problem statement.

---

*Sources reviewed: `.github/workflows/publish-note.yml`, `.github/workflows/publish-long-post.yml`, `notes-factory/index.html`, `automation/README.md`, all 37 files in `published-notes/`, `published-long-posts/index.json`, and the four Google policy pages cited in §2.*
