# Automation/long-post-runner — browser-driven Long Post batch pipeline

Automates the same flow `long-post-factory/index.html` does by hand — build
prompt → get an AI reply → parse/validate → save → publish — but for a whole
CSV of topics in one run, with no API key. Instead of an API key, it drives
a real, already-signed-in Chrome profile through DeepSeek's free web chat
via [`patchright`](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python)
(a stealth-patched Playwright — needed because plain Playwright's browser
fingerprint gets flagged by DeepSeek's bot detection).

```
CSV topic list (Automation/input sylabuss/*.csv)
        │
        ▼
Automation/core/src/build-automation-prompt.mjs   ← Node, builds the exact same
        │                                   prompt long-post-factory's
        ▼                                   buildLongPostPrompt() builds
Chrome (real signed-in profile) → chat.deepseek.com
        │  patchright: paste prompt, wait, scrape the reply
        ▼
Automation/core/src/validate-bundle.mjs           ← Node, same parser +
        │                                   hard-fail validator as the
        ▼                                   browser tool's vRunChecks
pending-long-posts/<slug>.json  →  git commit + push
        │
        ▼
.github/workflows/pub-lpost.yml  (unchanged — picks this up
                                           exactly like a manual save)
```

**Why the Node round-trip instead of doing everything in Python?**
Prompt-building and reply-parsing have to stay byte-for-byte identical to
what the manual browser tools produce, or a script-generated post and a
human-generated one could silently drift apart in shape. Rather than
re-implementing that logic twice (once in each language, guaranteed to
diverge eventually), this script shells out to the *same* `.mjs` files the
browser tools' logic was ported from — see `Automation/core/README.md` for what
each one does. Python's job is everything else: CSV/state handling, Chrome
profile management, retries, dedup, and driving the actual browser.

## One-time setup

1. `cd Automation/core && npm install` (installs the Node side — see
   `Automation/core/README.md`).
2. `pip install patchright` (plus whatever else `Automation/core/requirements.txt`
   lists), then `patchright install chrome`.
3. Sign into the Google account tied to your DeepSeek login in **your real,
   normal Chrome** — the script clones that profile rather than launching it
   directly, so it never fights you for the same profile lock. Note which
   Chrome profile directory that is (e.g. `Profile 14`).
4. Set env vars if your setup differs from the defaults baked into the
   script:
   ```
   $env:CHROME_PROFILE_DIR = "Profile 14"        # which real Chrome profile to clone
   $env:DEEPSEEK_ACCOUNT_EMAIL = "you@gmail.com"  # verified against the clone before every run
   ```
   Before launching the browser, the script reads Chrome's own `Local
   State` file to confirm the cloned profile is actually signed into
   `DEEPSEEK_ACCOUNT_EMAIL` — if not, it re-clones once and checks again,
   then fails loudly with instructions rather than silently running against
   the wrong account.

## Running it

```
python run_pipeline.py --sanity-test         # no browser, no DeepSeek, no git — proves the code path
python run_pipeline.py --dry-run --limit 3   # build prompts only, nothing sent
python run_pipeline.py --start 0 --limit 5   # the real thing, 5 topics starting at row 0
```

- `--start N` / `--limit N` — slice into the CSV (`Automation/input sylabuss/*.csv`;
  columns: क्रमांक, subject, topic, exam, post/class, content type).
- Skips a topic outright if it's already in `published-long-posts/` or
  already sitting in `pending-long-posts/` (see `is_duplicate()`).
- On a **hard fail** (validator rejects the reply), the topic is skipped —
  the raw reply is saved to `debug-replies/<n>-<slug>.txt` (gitignored) so
  you can see exactly what DeepSeek actually said, rather than just a
  pass/fail log line.
- Chrome is launched once for the whole run; each topic opens one new tab
  to `chat.deepseek.com` and closes it before the next topic starts — never
  more than one DeepSeek tab open at a time.

## Prompt content

The actual prompt text comes from `Automation/core/src/prompt-builder-automation.mjs`
(same quality bar as the manual `long-post-factory` tool, with the
self-report/checklist scaffolding stripped out — this script's Node
validator does those checks in code instead of asking the AI to
self-report them). `MASTER-PROMPT-Automation.md` in this folder is a design
reference for that prompt, not something loaded at runtime — same
relationship as `MASTER-PROMPT-LongPost_v1.md` has to
`long-post-factory/index.html`'s in-page prompt builder: edit the `.mjs` to
change what actually runs, treat the `.md` as documentation to keep in sync
afterward.

## Gitignored locally

- `debug-replies/` — raw AI replies saved on a hard fail, for debugging only.
- `__pycache__/` — Python bytecode cache.
