# Content Factory

Two free, mobile-first tools for producing exam-prep content, hosted entirely on GitHub Pages. No servers, no build step — every tool is a single HTML file.

**Live hub:** `https://bugignore.github.io/question-factory/`

| Tool | What it does | Docs |
|---|---|---|
| 📝 [Question Factory](question-factory/) | Build a bilingual MCQ-generation prompt for a free DeepSeek chat, validate/fix/shuffle the returned CSV, verify answers with a second pass, export website-ready CSV. Runs 100% in the browser. | [question-factory/](question-factory/) |
| 📚 [Notes Factory](notes-factory/) | Configure the `MASTER-PROMPT-ExamNotesPDF v6.md` master prompt for a topic, paste it into any free chat AI, parse the reply (SEO fields + HTML notes), and hand it to a GitHub Actions workflow that drafts it on WordPress — zero credentials in the browser. | [notes-factory/README.md](notes-factory/README.md) |

## Repo layout

```
index.html                        hub page linking to both tools
MASTER-PROMPT-ExamNotesPDF v6.md  the notes master prompt (single source of truth — never edited by tools)
question-factory/                 MCQ tool (self-contained)
notes-factory/                    notes tool (self-contained)
pending-notes/                    drop zone: <slug>.json files awaiting WordPress publish
published-notes/                  processed notes, stamped with their WordPress post id + link
.github/workflows/pub-note.yml   the WordPress publishing automation
```

## Security model

- The site is static (GitHub Pages) — **no secret may ever be put in any HTML/JS file**, because everything served is world-readable.
- WordPress credentials live **only** in GitHub Actions encrypted secrets (`WP_SITE_URL`, `WP_USERNAME`, `WP_APP_PASSWORD`) — see [notes-factory/README.md](notes-factory/README.md) for setup.
- The browser tools store only non-secret convenience settings (your GitHub username/repo) in `localStorage`.

## Updating a tool

Open the repo → navigate to the tool's `index.html` → pencil icon (Edit) → paste the new version → Commit. GitHub Pages updates within a minute. Works from a phone.
