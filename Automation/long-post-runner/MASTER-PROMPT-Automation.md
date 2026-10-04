> **Source of truth:** `Automation/core/src/prompt-builder-automation.mjs` (`buildAutomationPrompt()`). This file documents the design — if the two ever disagree, the `.mjs` file is what actually runs.

# MASTER PROMPT — Automation Variant (DeepSeek-via-browser pipeline)

## Where this comes from
Same quality bar as `long-post-factory/index.html`'s live prompt (`buildLongPostPrompt()`, also documented historically in `MASTER-PROMPT-LongPost_v1.md`): same persona system (`Automation/core/src/prompt-builder.mjs`'s `EXAM_PROFILES`), same block-tag system, same 6,000–8,000-word depth target, same SEO rigor, same HARD BANS on fabrication/stuffing/locked content.

## What's different, and why
The manual/API prompt asks the model to grade its own homework in-band:
- a `[[WC: N]]` running word-count checkpoint printed mid-article
- a **COUNT-BEFORE-PRINT** gate — literally re-counting itself and refusing to print until its own tally clears 6,000
- a **FINAL CHECKS** table — 18+ YES/NO self-audit lines

That scaffolding exists because a human reading a chat reply needs the model's self-report to sanity-check it live. A pipeline doesn't — it can read the actual returned HTML and count for real. So the automation prompt drops all three, and `Automation/core/src/validate-bundle.mjs` does the checking afterward, in code, against the literal output:

| Self-report removed | Code-side replacement |
|---|---|
| `[[WC: N]]` checkpoints | `validate-bundle.mjs` counts prose words directly from the parsed HTML |
| COUNT-BEFORE-PRINT gate | Hard-fail gate: word count, required SEO fields, no `<script>`, no unexpanded block markers |
| FINAL CHECKS YES/NO table | Everything softer than a hard fail becomes a **warning**, attached to Publisher Notes for human review — never blocks the pipeline |

This also shortens the prompt itself — roughly a third fewer tokens sent to DeepSeek per topic, since it's not spending output budget re-deriving and printing its own audit trail.

## Hard fail vs. warning — the actual gate
A topic is only rejected (skipped, not written to `pending-long-posts/`) if:
1. The notes body is empty/near-empty, or still contains raw `{* type *}` markers (block parsing failed)
2. A `<script>` tag is present (non-negotiable — HARD BAN 1)
3. Focus Keyword / SEO Title / URL Slug is missing (can't publish without these)
4. Prose word count is below **2,500** (an absolute floor — not the 6,000 target, just "is this a real article at all")

Everything else — missing meta description, thin keyphrase density, fewer SVGs than ideal, word count between 2,500–6,000 — passes through as a **warning** appended to Publisher Notes, so a human reviewing the draft in WordPress sees exactly what to check, but the pipeline doesn't stall waiting for AI-side perfection.

## Output contract (unchanged from the manual tool — this is the parseable part, not a "check")
```
<<<SEO_JSON>>>
```json
{"focusKeyword":"...","seoTitle":"...","slug":"...","metaDescription":"...","h1":"...","imageAltText":"...","imagePrompt":"..."}
```
<<<END_SEO_JSON>>>

<<<NOTES_BODY_HTML>>>
```
(block-tagged body: {* type: title *} ... {* END *}, [[AD]] placeholders)
```
<<<END_NOTES_BODY_HTML>>>

<<<PUBLISHER_NOTES>>>
```
- Seed, sources, softened claims, question label mix, visuals, unverified URLs
```
<<<END_PUBLISHER_NOTES>>>
```
`Automation/core/src/parse-reply.mjs` (`parseResponse()`) reads these sentinels and expands every `{* type: title *}` block into the same styled HTML the manual tool produces — same `BLOCK_RENDERERS` table, same output shape as a `pending-long-posts/<slug>.json` bundle.

## Pipeline this feeds
```
CSV topic row
  -> Automation/core/src/build-automation-prompt.mjs   (prompt text, no browser)
  -> DeepSeek (chat.deepseek.com, one browser tab per topic)
  -> Automation/core/src/validate-bundle.mjs           (parse + hard-fail gate + bundle)
  -> pending-long-posts/<slug>.json           (if hard fails are empty)
  -> git commit + push
  -> .github/workflows/pub-lpost.yml  (existing, unchanged)
  -> WordPress draft
```
See `Automation/long-post-runner/run_pipeline.py` for the orchestrator, and its `--sanity-test` mode for exercising the parse/validate/bundle path with zero LLM calls and zero browser.
