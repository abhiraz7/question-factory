# Question Factory

A single-page tool for generating verified, bilingual exam MCQs (CTET / KVS / DSSSB / REET style) as website-ready CSV, using only the free DeepSeek chat. Runs entirely in the browser — no server, no data leaves the phone.

**Live app:** after enabling GitHub Pages this will be
`https://YOUR-USERNAME.github.io/question-factory/`

## What it does

1. **Build prompt** — pick a subject preset (Pedagogy, Mathematics, Reasoning, GS, English-only, Hindi-only). It generates a strict prompt for DeepSeek: topic column locked, formulas in plain Unicode, data-interpretation questions self-contained in text, correct language rules per subject.
2. **Check, fix & shuffle** — paste DeepSeek's CSV. The tool validates all 15 columns, fixes the topic column, normalizes `exam_type_year`, enforces the language rules, removes duplicates, and **shuffles answer positions locally** so correct answers are evenly spread across options 1–4.
3. **Verify** — a checker prompt (questions only, answers stripped) goes into a *new* DeepSeek chat. The tool compares both passes; mismatches can be fixed via a third "resolver" pass that also rewrites the explanation, or discarded.
4. **Export** — copy the final verified CSV to clipboard (mobile-friendly), download it as a file, or unlock with the app password (once per browser) and tap **"Auto-save to GitHub"** to push it straight into `pending-questions/` in this repo — no GitHub login or token needed by whoever's using the tool.

## Auto-import into WordPress (owner setup, one time)

Once a CSV lands in `pending-questions/`, the `.github/workflows/pub-quiz.yml` workflow (already in this repo) picks it up automatically:

```
Auto-save to GitHub (above) → pending-questions/<name>.csv committed to main
                             ↓
GitHub Actions: pub-quiz.yml fires on the push
                             ↓
POSTs the CSV to https://yoursite.com/wp-json/quiz/v1/import
  (authenticated with a WordPress Application Password + a shared secret key,
   both required — see "Password protection" below)
                             ↓
Rows are validated and inserted as status=draft (never live automatically)
                             ↓
File moves to published-questions/<name>.csv + a .result.json with the
import counts; you still open Quiz App → Preview and publish manually.
```

If it fails (bad WordPress credentials, network issue, a malformed CSV), the file simply stays in `pending-questions/`, the error is visible in the repo's **Actions** tab, and you can re-run it once the cause is fixed — nothing is lost.

### One-time setup

1. **WordPress Application Password** — same as Notes Factory: log in as a user who can manage the quiz plugin (`manage_options`), go to **Users → Profile → Application Passwords**, name it e.g. `question-factory`, copy the generated password.
2. **Import secret key** — this is a *second*, independent password: a leaked Application Password alone is not enough to import questions, the caller must also send this exact key. It lives **only** in `wp-config.php` on the server (never in wp-admin, never in git) — added directly via SSH/file manager:
   ```php
   define( 'QUIZ_IMPORT_SECRET', 'a-long-random-string-here' );
   ```
   Keeping it out of wp-admin entirely means the Import CSV page looks identical to before — no UI change for anyone who opens it.
3. **GitHub Actions secrets** — in this repo: **Settings → Secrets and variables → Actions → New repository secret**. Add all four (reuse the same `WP_SITE_URL`/`WP_USERNAME`/`WP_APP_PASSWORD` already configured for notes-factory if this is the same site/user):

   | Secret name | Value |
   |---|---|
   | `WP_SITE_URL` | `https://examnotespdf.in` (no trailing slash needed) |
   | `WP_USERNAME` | the WordPress username the app password belongs to |
   | `WP_APP_PASSWORD` | the Application Password from step 1 |
   | `QUIZ_IMPORT_SECRET` | the exact string from the `wp-config.php` constant in step 2 |

   These are encrypted, never appear in any file, and are masked in logs.

### Password protection — what stops an unauthorised push

- The endpoint (`/wp-json/quiz/v1/import`) requires **two independent secrets** at once: a valid WordPress Application Password (proves the caller is an authorised WP user) **and** the `X-Quiz-Import-Secret` header matching the `wp-config.php` constant (proves the caller knows this specific integration's key). Neither alone is accepted, and if `QUIZ_IMPORT_SECRET` isn't defined at all the endpoint fails closed (rejects every request) rather than falling back to some guessable default.
- The endpoint only ever **appends** — bulk "replace/delete" mode is not reachable through the API at all, only through the manual admin upload page by a logged-in admin.
- Every imported row lands as **`status = draft`** — nothing an automated import writes can appear on the live site without a human opening Quiz App → Preview and publishing it.
- If the key ever leaks, edit the constant in `wp-config.php` to a new random value and update the `QUIZ_IMPORT_SECRET` GitHub secret to match — the old key stops working immediately, no plugin/database change needed.

## CSV format

```
topic,question_en,question_hi,option1_en,option1_hi,option2_en,option2_hi,
option3_en,option3_hi,option4_en,option4_hi,correct,explanation_en,
explanation_hi,exam_type_year
```

## Hosting setup (one time, ~3 minutes, works from a phone)

1. Create a free account at github.com.
2. Tap **+** → **New repository** → name it `question-factory` → keep it **Public** → Create.
3. On the repo page tap **uploading an existing file** → upload `index.html`, `manifest.json`, `icon.svg` → **Commit changes**.
4. Go to **Settings → Pages** → under *Branch* choose `main` and `/ (root)` → **Save**.
5. Wait ~1 minute. The link appears at the top of the Pages settings.

Share that link. On the phone, open it in Chrome → menu (⋮) → **Add to Home screen** → it now opens full-screen like an app.

## Enabling one-tap auto-save (owner-only, one time)

This uses the same encrypted-token setup as Notes Factory — see [`../notes-factory/README.md`](../notes-factory/README.md#0-github-token--app-password-enables-one-tap-auto-save-for-everyone-who-uses-the-tool) for the full steps. In short: generate a fine-grained GitHub token (Contents: Read & write, scoped to this repo), encrypt it with `../admin-encrypt-token.html` using an app password, paste the resulting blob into this file's `ENCRYPTED_GH_TOKEN` constant, and give the app password to whoever uses this tool. They never see or handle the GitHub token — just that one short password, typed once per browser.

## Updating the tool later

Open the repo → tap `index.html` → pencil icon (Edit) → paste the new version → Commit. The live link updates within a minute.

## Files

| File | Purpose |
|---|---|
| `index.html` | The entire app (HTML + CSS + JS, no dependencies) |
| `manifest.json` | Lets phones install it to the home screen |
| `icon.svg` | App icon |
