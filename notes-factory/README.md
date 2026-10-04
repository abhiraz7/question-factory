# Notes Factory

Generates premium exam notes from the `MASTER-PROMPT-ExamNotesPDF v6.md` master prompt using any **free** chat AI (DeepSeek recommended — the prompt is large), then publishes them to WordPress as drafts. Saving to GitHub is one-click automatic — the person using the app day-to-day (e.g. a client) only ever needs a short **app password** you give them, never a GitHub token. You (the owner) set the real GitHub token up once, encrypted, using the separate `admin-encrypt-token.html` tool.

**Live app:** `https://bugignore.github.io/question-factory/notes-factory/`

## How a note flows through the pipeline

```
You, in the browser tool (phone or desktop):
1. Pick TOPIC / EXAM TYPE / SUBJECT → tool copies the full master prompt,
   configured, to your clipboard. The master prompt file itself is never edited.
2. Paste into a new DeepSeek/ChatGPT/Claude chat → copy the whole reply back.
   (If the AI stopped midway: "Copy continue prompt" → paste in the same chat →
   paste the new reply with the continuation checkbox ticked.)
3. Review the parsed SEO fields + HTML preview, fix anything.
4. First time on a given browser: type the app password (given by the
   owner) into "Unlock saving" once. Then tap "Auto-save to GitHub" →
   the tool pushes <slug>.json straight into pending-notes/. No download,
   no manual upload page, no GitHub knowledge needed. (Manual download +
   GitHub upload page fallback is still there if you ever prefer it.)

GitHub Actions (automatic, seconds later):
5. The workflow posts the note to your WordPress site as a DRAFT and
   moves the file to published-notes/ with the new post's id + link.

You, in WordPress:
6. Open the draft — title, slug, content, AND all Rank Math fields (Focus
   Keyword, SEO Title, Meta Description) already filled — review, hit Publish.
```

If step 5 fails, the file simply stays in `pending-notes/`, the failure is visible in the **Actions** tab, and you can re-run it from there once the cause is fixed. Nothing is ever lost — the JSON in the repo is the permanent backup of every note.

## One-time setup (you, the owner — do this before handing the tool to anyone else)

### 0. GitHub token + app password (enables one-tap auto-save for everyone who uses the tool)

1. Go to **[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)** (fine-grained tokens).
2. **Resource owner:** your account/org. **Repository access:** "Only select repositories" → pick this repo.
3. **Permissions → Repository permissions → Contents:** Read and write. Leave everything else as "No access."
4. Generate, **copy the token immediately** (starts `github_pat_…`) — GitHub only shows it once.
5. Open **`https://bugignore.github.io/question-factory/admin-encrypt-token.html`** (it needs to run over `https://` for the browser's encryption API to work — don't just double-click the file locally) — paste the raw token, choose an **app password** (this is what you'll give your client — pick something short and memorable, not the same as any real credential), click **Encrypt**.
6. Copy the output blob and paste it as the `ENCRYPTED_GH_TOKEN` constant near the top of the script in **both** `notes-factory/index.html` and `question-factory/index.html`, then commit.
7. Reload `admin-encrypt-token.html` (or just don't leave the raw token sitting in the input) — it never gets saved anywhere by that page.
8. Give the app password to your client via a private channel (chat, verbally) — never write it into any repo file. She types it once per browser in the app's "Unlock saving" box; it's remembered for that browser after that.
9. Tokens can be revoked any time from the same GitHub settings page — if you ever need to rotate it, generate a new token, re-encrypt with `admin-encrypt-token.html`, and repeat steps 5–6.

### 1. WordPress Application Password (no plugin needed)

1. Log in to WordPress as a user who can create posts. **For notes containing ad `<script>` tags this must be an Administrator** — see the caveat below.
2. Go to **Users → Profile → Application Passwords** (built into WordPress 5.6+).
3. Name it `notes-factory`, click **Add New Application Password**.
4. Copy the generated password (spaces are fine, keep them or strip them — both work).

### 2. GitHub Actions secrets

In this repo: **Settings → Secrets and variables → Actions → New repository secret**. Add all three:

| Secret name | Value |
|---|---|
| `WP_SITE_URL` | `https://examnotespdf.in` (your site, no trailing slash needed) |
| `WP_USERNAME` | the WordPress username the app password belongs to |
| `WP_APP_PASSWORD` | the application password from step 1 |

These are encrypted, never appear in any file, are masked in logs, and are safe even on a public repo. **Never** put them anywhere else — not in the tool, not in a committed file.

### 3. Rank Math REST snippet (one time, ~2 minutes — makes SEO fields fully automatic)

WordPress's REST API refuses to write post meta that isn't registered for REST, and Rank Math doesn't register its fields. Install the snippet in [`wp-snippet-rank-math-rest.php`](wp-snippet-rank-math-rest.php) once (easiest: the **Code Snippets** plugin → Add New → paste → Activate; the file's header lists two other install options). After that, every draft arrives with Focus Keyword, SEO Title, and Meta Description already set in Rank Math — true one-click publish.

**Without the snippet nothing breaks:** the workflow detects the rejection, retries without the SEO meta so the draft still lands, and prints a warning telling you to paste the Rank Math fields manually for that post (the tool's "Copy Rank Math fields" button covers that).

### 4. That's it

The workflow (`.github/workflows/pub-note.yml`) and folders (`pending-notes/`, `published-notes/`) are already in the repo.

## Caveats you should know

- **Ad scripts require `unfiltered_html`.** WordPress strips `<script>` tags (the AdSense slots) from post content unless the authenticated user has the `unfiltered_html` capability — on a normal single-site install that means an **Administrator**. If drafts arrive with the ad code missing, that's why.
- **Rank Math automation needs the snippet from setup step 3.** Without it, drafts still publish but SEO fields must be pasted manually (the workflow warns you when this happens); with it, everything is set automatically.
- **Duplicate protection:** re-uploading a `<slug>.json` that was already published is skipped automatically (the workflow sees `published-notes/<slug>.json` exists). To genuinely republish, delete that file first.
- **The upload page needs the folder to exist** — it does (`pending-notes/.gitkeep`), don't delete it.
- **Paste the notes body into a Custom HTML block** in WordPress if you ever paste manually — a Paragraph block will escape the HTML and show tags as text. (Via the pipeline this doesn't matter: REST inserts the raw HTML directly.)

## Privacy model (what lives where)

| Data | Where it lives | Secret? |
|---|---|---|
| Master prompt | repo file, public | no |
| Generated notes | `pending-notes/` → `published-notes/`, public repo | no (they're going on a public website anyway) |
| Encrypted GitHub token | `ENCRYPTED_GH_TOKEN` constant in the committed source, public | the ciphertext itself is safe to be public — it's useless without the app password, which is never written to any file |
| App password | given verbally/privately to whoever uses the tool; the decrypted token then lives only in that browser's `sessionStorage` (cleared when the tab/browser closes) | **yes — the only real secret in this whole flow; don't post it publicly or commit it anywhere** |
| Raw GitHub token | exists only briefly in your clipboard/the admin-encrypt-token.html input while you set this up — never committed | **yes — never paste it anywhere except that one-time encryption step** |
| WP credentials | GitHub Actions encrypted secrets only | **yes — never anywhere else** |
| AI chat account | your own DeepSeek/ChatGPT session | never touches this tool |
