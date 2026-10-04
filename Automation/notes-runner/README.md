# Automation/notes-runner — browser-driven Notes batch pipeline

Automates the same flow `notes-factory/index.html` does by hand — build
prompt → get an AI reply → parse/validate → save → publish — but for a whole
CSV of topics in one run, with no API key. Mirrors
`Automation/long-post-runner/` exactly, retargeted at Notes Factory's v13
prompt/schema instead of Long Post's.

```
CSV topic list (Automation/input sylabuss/*.csv)
        │
        ▼
Automation/core/src/build-automation-prompt-notes.mjs  ← Node, builds the
        │                                    EXACT prompt notes-factory's
        │                                    buildPrompt() builds (same
        │                                    v13.md text, same
        │                                    {{TEACHING_LEVEL}}/
        │                                    {{REFERENCE_SOURCES_BLOCK}}
        │                                    substitution, same appended
        │                                    PIPELINE OUTPUT CONTRACT)
        ▼
Chrome (real signed-in profile) → chat.deepseek.com
        │  patchright: paste prompt, wait, scrape the reply
        ▼
Automation/core/src/validate-bundle-notes.mjs      ← Node, parses the reply
        │                                    with parse-reply.mjs (the
        │                                    <<<SEO_JSON>>>/
        │                                    <<<NOTES_BODY_HTML>>>/
        │                                    <<<PUBLISHER_NOTES>>> sentinel
        │                                    contract), then runs the SAME
        │                                    hard-fail checks the manual
        │                                    tool's "Run validation" button
        │                                    runs (validators-notes.mjs,
        │                                    generated from
        │                                    notes-factory/index.html —
        │                                    see gen-validators-notes.mjs)
        ▼
pending-notes/<slug>.json  →  git commit + push
        │
        ▼
.github/workflows/pub-note.yml  (unchanged — picks this up
                                      exactly like a manual save)
```

## Keeping this in sync with the manual tool

`prompt-builder-notes.mjs` and `validators-notes.mjs` are **generated**, not
hand-written — see `gen-prompt-builder-notes.mjs` and
`gen-validators-notes.mjs` in `Automation/core/src/`. If `notes-factory/
index.html`'s `buildPrompt()`/`outputContract()`/reference-source logic or
its `vCheck*`/`vRunChecks` validators ever change, re-run both generators
(`node gen-prompt-builder-notes.mjs && node gen-validators-notes.mjs` from
`Automation/core/src/`) rather than hand-editing the generated files — that
guarantees the automated pipeline can never quietly drift from what the
manual browser tool actually does.

## Usage

```
python run_pipeline.py --sanity-test         # no browser, no DeepSeek, no git
python run_pipeline.py --dry-run --limit 3   # build prompts only
python run_pipeline.py --start 0 --limit 5   # the real thing (automated DeepSeek)
python run_pipeline.py --manual --limit 5    # paste into DeepSeek/ChatGPT/Claude yourself
```

Needs the same Python environment as `long-post-runner` (`patchright`) —
either share its `.venv` or set one up the same way; see that folder's own
README for the Chrome-profile-cloning setup this shares.

## ChatGPT support

`--manual` mode works with ChatGPT (or any chat UI) today — it only uses the
OS clipboard, never touches the page's DOM, so there's nothing engine-specific
to build. The automated browser flow (`run_topic_through_deepseek`) is
DeepSeek-only: its selectors (textarea placeholder, send-button SVG
signature, per-message Copy-button class) were reverse-engineered against
DeepSeek's actual UI. Driving ChatGPT the same unattended way would need the
equivalent selectors reverse-engineered against chatgpt.com's UI first —
not done here, since guessing at unverified selectors would silently hang
or misbehave rather than fail loudly.
