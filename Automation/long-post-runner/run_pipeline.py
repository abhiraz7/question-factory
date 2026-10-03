"""End-to-end automation: CSV topic list -> DeepSeek (browser) -> validated
pending-long-posts/<slug>.json -> git push -> existing publish-long-post.yml
GitHub Action drafts it to WordPress.

Everything runs from the terminal except the DeepSeek exchange itself,
which needs a real logged-in browser session (DeepSeek has no API key
issued here). Chrome is launched ONCE for the whole run; each topic opens
exactly one new tab to chat.deepseek.com and closes it before the next
topic opens its own - never more than one DeepSeek tab open at a time.
The browser runs headed (headless=False), so this is watchable, not a
black box - if topics are flying past faster than you can follow, that's
the per-topic cooldown (15-40s) plus DeepSeek's own reply time, not a
bug where several tabs are open at once.

Prompt-building, reply-parsing, and hard-fail validation all run in Node
(Automation/core/src/build-automation-prompt.mjs, Automation/core/src/validate-bundle.mjs) -
this script only orchestrates: CSV -> prompt -> browser -> reply -> Node
validator -> file -> git. See Automation/core/src/prompt-builder-automation.mjs for
the actual prompt content (same quality bar as the manual long-post-factory
tool, with the self-report/checklist scaffolding stripped out - this
script's Node validator does those checks in code instead, and only a
HARD FAIL blocks a topic; anything softer still publishes with a note).

A --manual mode also exists (build the prompt, you paste it into
DeepSeek/ChatGPT yourself and copy the reply back) for when you don't have
the DeepSeek Chrome profile handy - it is NOT the default; the default is
the automated browser flow above.

Usage:
    python run_pipeline.py --sanity-test         # no browser, no DeepSeek, no git
    python run_pipeline.py --dry-run --limit 3   # build prompts only
    python run_pipeline.py --start 0 --limit 5   # the real thing (automated)
    python run_pipeline.py --manual --limit 5    # you paste into DeepSeek/ChatGPT yourself
"""

import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
from getpass import getpass
from pathlib import Path

# Topics and prompts are Hindi text; a console stuck on a legacy codepage
# (cp1252 etc., which some terminals still default to on Windows) would
# otherwise crash on the very first print() rather than just showing the
# text a little wrong. UTF-8 output degrades gracefully everywhere it isn't
# already the default.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from patchright.sync_api import sync_playwright, Page

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
AUTOMATION_DIR = REPO_ROOT / "Automation" / "core"
AUTOMATION_SRC_DIR = AUTOMATION_DIR / "src"
PENDING_DIR = REPO_ROOT / "pending-long-posts"
PUBLISHED_INDEX = REPO_ROOT / "published-long-posts" / "index.json"

CSV_PATH = REPO_ROOT / "Automation" / "input sylabuss" / "BPSC-TRE-4-Primary-Teacher-SEO-Topics-Hindi-v2.csv"
DEBUG_REPLIES_DIR = Path(__file__).parent / "debug-replies"

SOURCE_USER_DATA_ROOT = Path.home() / "AppData" / "Local" / "Google" / "Chrome" / "User Data"
CLONE_ROOT = Path.home() / "AppData" / "Local" / "NotesAutomateChromeProfile"
PROFILE_DIR = os.environ.get("CHROME_PROFILE_DIR", "Profile 14")  # missku35@gmail.com
DEEPSEEK_ACCOUNT_EMAIL = os.environ.get("DEEPSEEK_ACCOUNT_EMAIL", "missku35@gmail.com")
FORCE_RECLONE = os.environ.get("FORCE_RECLONE") == "1"
IGNORE_PATTERNS = shutil.ignore_patterns("Singleton*", "lockfile", "*.lock", "LOCK")

DEEPSEEK_URL = "https://chat.deepseek.com/"
TEXTAREA_PLACEHOLDER = "Message DeepSeek"
SEND_BUTTON_SVG_D_PREFIX = "M8.3125 0.981587C8.66767 1.0545"

YEAR = 2026
SUBJECT_MAP = {
    "हिंदी": ("Hindi", 100),
    "अंग्रेजी": ("English", 80),
    "गणित": ("Maths", 80),
    "विज्ञान": ("Science", 80),
    "इतिहास": ("History", 80),
    "भूगोल": ("Geography", 80),
}
DEFAULT_SUBJECT = ("Auto-detect", 80)

_session_git_token = None  # prompted once per run, held in memory only


# ---------------------------------------------------------------- topics --

def load_topics(start: int, limit):
    rows = []
    with open(CSV_PATH, encoding="utf-8-sig", newline="") as f:
        import csv
        reader = csv.reader(f)
        next(reader)  # header is S.No.,Subject,Topic — read by position instead
        for row in reader:
            # CSV_PATH's "v2" regeneration dropped a 4th Exam column this
            # loop used to read (row[3]) — every row is 3 columns now, so
            # `len(row) < 4` skipped every single row and this pipeline has
            # been silently processing zero topics on every run since. This
            # script only ever points at the BPSC CSV, so the exam is a
            # fixed constant, not a per-row column, now.
            if len(row) < 3 or not row[0].strip():
                continue
            subject_raw = row[1].strip()
            topic = row[2].strip()
            exam = "BPSC TRE"
            subject, hindi_pct = SUBJECT_MAP.get(subject_raw, DEFAULT_SUBJECT)
            rows.append({
                "no": row[0].strip(), "subject_raw": subject_raw, "subject": subject,
                "hindi_pct": hindi_pct, "topic": topic, "exam": exam,
            })
    rows = rows[start:]
    if limit:
        rows = rows[:limit]
    return rows


def slugify(s: str) -> str:
    import re
    s = (s or "").lower().strip()
    s = re.sub(r"^/+|/+$", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def candidate_slug(topic: str, exam: str) -> str:
    return slugify(f"{topic} {exam} notes {YEAR}")


def load_existing_topics():
    """Returns (published_slugs: set[str], pending_pairs: set[(topic, exam)])."""
    published_slugs = set()
    if PUBLISHED_INDEX.exists():
        try:
            published_slugs = set(json.loads(PUBLISHED_INDEX.read_text(encoding="utf-8")))
        except Exception:
            pass

    pending_pairs = set()
    if PENDING_DIR.exists():
        for f in PENDING_DIR.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                t = (data.get("topic") or "").strip().lower()
                e = (data.get("examType") or "").strip().lower()
                if t and e:
                    pending_pairs.add((t, e))
                slug = (data.get("seo") or {}).get("slug")
                if slug:
                    published_slugs.add(slug)
            except Exception:
                continue
    return published_slugs, pending_pairs


def is_duplicate(topic, exam, published_slugs, pending_pairs) -> bool:
    if (topic.strip().lower(), exam.strip().lower()) in pending_pairs:
        return True
    if candidate_slug(topic, exam) in published_slugs:
        return True
    return False


# ------------------------------------------------------------ node calls --

def run_node(script: str, args: list, stdin_text: str = None) -> str:
    result = subprocess.run(
        ["node", str(AUTOMATION_SRC_DIR / script), *args],
        input=stdin_text, capture_output=True, text=True, encoding="utf-8",
        cwd=str(AUTOMATION_DIR),
    )
    if result.returncode != 0:
        raise RuntimeError(f"node {script} failed: {result.stderr}")
    return result.stdout


def build_prompt(topic, exam, subject, hindi_pct) -> str:
    return run_node("build-automation-prompt.mjs", [
        "--topic", topic, "--exam", exam, "--subject", subject,
        "--hindi", str(hindi_pct), "--year", str(YEAR),
    ])


def validate_and_bundle(raw_reply, topic, exam, subject, hindi_pct) -> dict:
    out = run_node("validate-bundle.mjs", [
        "--topic", topic, "--exam", exam, "--subject", subject,
        "--hindi", str(hindi_pct), "--year", str(YEAR),
    ], stdin_text=raw_reply)
    return json.loads(out)


# ---------------------------------------------------------------- chrome --

def ensure_clone(force: bool = False) -> Path:
    clone_profile_dir = CLONE_ROOT / PROFILE_DIR
    if clone_profile_dir.exists() and not FORCE_RECLONE and not force:
        print(f"Using existing profile clone: {clone_profile_dir}")
        return CLONE_ROOT
    print(f"Cloning profile '{PROFILE_DIR}' into {CLONE_ROOT} ...")
    CLONE_ROOT.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SOURCE_USER_DATA_ROOT / "Local State", CLONE_ROOT / "Local State")
    shutil.copytree(SOURCE_USER_DATA_ROOT / PROFILE_DIR, clone_profile_dir,
                     ignore=IGNORE_PATTERNS, dirs_exist_ok=True)
    print("Clone ready.")
    return CLONE_ROOT


def detect_profile_email(user_data_root: Path) -> str:
    """Reads the Chrome profile's own account metadata (Local State ->
    profile.info_cache[<profile dir>].user_name) - no browser needed."""
    local_state_path = user_data_root / "Local State"
    try:
        data = json.loads(local_state_path.read_text(encoding="utf-8"))
    except Exception:
        return ""
    entry = data.get("profile", {}).get("info_cache", {}).get(PROFILE_DIR, {})
    return (entry.get("user_name") or "").strip()


def ensure_correct_chrome_profile(user_data_root: Path) -> bool:
    found_email = detect_profile_email(user_data_root)
    if found_email.lower() == DEEPSEEK_ACCOUNT_EMAIL.lower():
        print(f"Chrome profile confirmed: {PROFILE_DIR} = {found_email}")
        return True
    print(f"  Expected Chrome profile '{PROFILE_DIR}' signed in as "
          f"'{DEEPSEEK_ACCOUNT_EMAIL}', found '{found_email or '(no account info found)'}'.")
    return False


def jitter(a, b):
    return random.uniform(a, b)


# ------------------------------------------------------------ clipboard --
# Manual mode's whole interface to the outside world is the OS clipboard --
# no browser, no API. Both directions go through a staging file rather than
# piping text straight into/out of powershell.exe's stdin/stdout, because
# that pipe uses the console's legacy codepage and mangles Hindi; a UTF-8
# file read with an explicit -Encoding does not.
CLIPBOARD_STAGE_DIR = Path(os.environ.get("TEMP", ".")) / "enp-notes-automate"


def copy_to_clipboard(text: str):
    CLIPBOARD_STAGE_DIR.mkdir(parents=True, exist_ok=True)
    stage = CLIPBOARD_STAGE_DIR / "to-clipboard.txt"
    stage.write_text(text, encoding="utf-8-sig")  # BOM so PowerShell autodetects UTF-8
    subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"Get-Content -Raw -Encoding UTF8 -LiteralPath '{stage}' | Set-Clipboard"],
        check=True,
    )


def read_clipboard() -> str:
    CLIPBOARD_STAGE_DIR.mkdir(parents=True, exist_ok=True)
    stage = CLIPBOARD_STAGE_DIR / "from-clipboard.txt"
    subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"Get-Clipboard -Raw | Out-File -LiteralPath '{stage}' -Encoding utf8"],
        check=True,
    )
    return stage.read_text(encoding="utf-8-sig")


END_SENTINEL = "<<<END_PUBLISHER_NOTES>>>"

# Excludes the trailing CSS-module hash (e.g. "db183363") that changes on
# every DeepSeek deploy — these utility classes are the stable part of the
# button's signature.
COPY_BUTTON_CLASS_SELECTOR = (
    'div[role="button"].ds-button--iconLabelTertiary'
    '.ds-button--icon.ds-button--capsule.ds-button--xs'
)


def find_copy_button(ds_page: Page):
    """DeepSeek only renders the per-message action toolbar (Copy /
    Regenerate / etc.) once that message has finished streaming — so
    locating this button doubles as the "reply is complete" signal, which
    is far more reliable than polling whole-page text length (that can
    plateau during a mid-stream pause and trigger a premature capture).
    Since each topic runs in its own fresh tab (one exchange per tab, see
    run_topic_through_deepseek), there is exactly one Copy button on the
    page once the reply is done — no scoping to "the last message" needed.
    Tries the accessible name first (most stable across UI rebuilds/CSS
    hash changes); falls back to the class signature if that fails."""
    by_name = ds_page.get_by_role("button", name=re.compile("copy", re.I))
    if by_name.count() > 0:
        return by_name.last
    return ds_page.locator(COPY_BUTTON_CLASS_SELECTOR).last


def copy_via_button(ds_page: Page, copy_btn) -> str:
    """Clicks DeepSeek's own Copy button (copies just the assistant's
    message — none of the sidebar/prompt-echo noise inner_text("body")
    picks up), waits for the clipboard write to actually land, then reads
    it back. Requires clipboard-read/write permission granted on the
    browser context (see main())."""
    copy_btn.click()
    ds_page.wait_for_timeout(int(jitter(2000, 3500)))  # let the clipboard write land
    return ds_page.evaluate("navigator.clipboard.readText()")


def run_topic_through_deepseek(context, prompt_text: str) -> str:
    """Opens one new tab, sends the prompt, waits for the reply, returns the
    raw text, then closes that tab. Never more than one DeepSeek tab open."""
    ds_page = context.new_page()
    try:
        ds_page.goto(DEEPSEEK_URL, wait_until="domcontentloaded")
        ds_page.wait_for_timeout(int(jitter(4000, 9000)))  # extra random wait

        textarea = ds_page.get_by_placeholder(TEXTAREA_PLACEHOLDER)
        textarea.wait_for(state="visible", timeout=60000)
        textarea.click()

        # put the prompt on the OS clipboard from inside this tab, then paste
        # (a real trusted paste, not a JS-injected value)
        ds_page.evaluate("(t) => navigator.clipboard.writeText(t)", prompt_text)
        ds_page.wait_for_timeout(int(jitter(300, 700)))
        ds_page.keyboard.press("Control+V")
        ds_page.wait_for_timeout(int(jitter(500, 1200)))

        pasted = textarea.input_value()
        if len(pasted.strip()) < len(prompt_text.strip()) * 0.5:
            textarea.fill(prompt_text)  # fallback if clipboard paste didn't take

        ds_page.wait_for_timeout(int(jitter(800, 2200)))

        send_btn = ds_page.locator(f'path[d^="{SEND_BUTTON_SVG_D_PREFIX[:40]}"]').locator("xpath=ancestor::button[1]")
        try:
            send_btn.click(timeout=5000)
        except Exception:
            textarea.press("Enter")

        # Primary path: wait for DeepSeek's own Copy button to appear (the
        # reply is genuinely done), click it, read the clean copy back from
        # the clipboard — no sidebar/prompt-echo pollution to parse around.
        try:
            copy_btn = find_copy_button(ds_page)
            copy_btn.wait_for(state="visible", timeout=600000)  # up to 10 min for a long article
            raw_reply = copy_via_button(ds_page, copy_btn)
            if raw_reply and END_SENTINEL in raw_reply:
                return raw_reply
            print(f"  [warn] Copy-button capture missing the {END_SENTINEL} sentinel — "
                  f"falling back to full-page text capture.")
        except Exception as e:
            print(f"  [warn] Copy-button capture failed ({e}) — falling back to full-page text capture.")

        # Fallback: the old whole-page-text approach, so a run never comes
        # back completely empty-handed even if DeepSeek's UI changed shape.
        # Poll for text stability first in case streaming is still running.
        stable_reads, last_len = 0, -1
        deadline = time.time() + 600
        while time.time() < deadline:
            ds_page.wait_for_timeout(2000)
            cur_len = len(ds_page.inner_text("body"))
            stable_reads = stable_reads + 1 if cur_len == last_len else 0
            last_len = cur_len
            if stable_reads >= 4:
                break
        return ds_page.inner_text("body")
    finally:
        ds_page.close()  # destroy this tab before the next topic opens a new one


# ------------------------------------------------------------------ git --

def get_git_token():
    global _session_git_token
    if _session_git_token is None:
        _session_git_token = getpass(
            "GitHub App Password / Personal Access Token (used only for this terminal session, never written to disk): "
        )
    return _session_git_token


def git_commit_and_push(file_path: Path, message: str):
    subprocess.run(["git", "add", str(file_path)], cwd=str(REPO_ROOT), check=True)
    result = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=str(REPO_ROOT))
    if result.returncode == 0:
        print("  Nothing to commit (file unchanged?).")
        return
    subprocess.run(["git", "commit", "-m", message], cwd=str(REPO_ROOT), check=True)

    remote_url = subprocess.run(
        ["git", "config", "--get", "remote.origin.url"], cwd=str(REPO_ROOT),
        capture_output=True, text=True, check=True,
    ).stdout.strip()

    push_target = remote_url
    if remote_url.startswith("https://") and "@" not in remote_url:
        token = get_git_token()
        push_target = remote_url.replace("https://", f"https://x-access-token:{token}@", 1)

    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=str(REPO_ROOT),
        capture_output=True, text=True, check=True,
    ).stdout.strip()

    subprocess.run(["git", "push", push_target, f"HEAD:{branch}"], cwd=str(REPO_ROOT), check=True)
    print(f"  Pushed — publish-long-post.yml will pick this up and draft it to WordPress.")


# --------------------------------------------------------------- sanity --

def sanity_test():
    print("Sanity test: parse -> validate -> bundle, no browser, no DeepSeek, no git.\n")

    seo = {
        "focusKeyword": "Sanity Test BPSC Notes 2026", "seoTitle": "Sanity Test BPSC Notes 2026: Complete Guide",
        "slug": "sanity-test-bpsc-notes-2026", "metaDescription": "A sanity-check fixture, not real content.",
        "h1": "Sanity Test", "imageAltText": "Sanity Test BPSC Notes 2026 diagram", "imagePrompt": "n/a",
    }
    filler = "यह एक सैनिटी-टेस्ट वाक्य है जो केवल शब्द-गणना जाँचने के लिए दोहराया गया है। "
    body = "{* h2: Section One *}\n" + ("<p>" + filler * 25 + "</p>\n") * 12 + "{* END *}\n"
    raw = (
        "<<<SEO_JSON>>>\n```json\n" + json.dumps(seo) + "\n```\n<<<END_SEO_JSON>>>\n\n"
        "<<<NOTES_BODY_HTML>>>\n```\n" + body + "```\n<<<END_NOTES_BODY_HTML>>>\n\n"
        "<<<PUBLISHER_NOTES>>>\n```\n- Seed: 1 (sanity fixture)\n```\n<<<END_PUBLISHER_NOTES>>>\n"
    )

    result = validate_and_bundle(raw, "Sanity Test", "BPSC TRE 4", "Hindi", 100)
    print(json.dumps({k: v for k, v in result.items() if k != "bundle"}, indent=2, ensure_ascii=False))

    if not result["pass"]:
        print("\nSANITY TEST FAILED — the fixture itself should always pass. Check validate-bundle.mjs.")
        sys.exit(1)

    out_path = PENDING_DIR / "__sanity_test__.json"
    out_path.write_text(json.dumps(result["bundle"], ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nWrote {out_path} (delete this — it's a fixture, not a real post).")
    print("Sanity test PASSED: parse, hard-fail validation, and bundle-writing all work without any LLM.")


# ---------------------------------------------------------------- main --

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--dry-run", action="store_true", help="Build + validate prompts only, no AI reply/git")
    ap.add_argument("--sanity-test", action="store_true", help="No LLM, no browser, no git — proves the code path")
    ap.add_argument("--manual", action="store_true",
                     help="Paste into DeepSeek/ChatGPT yourself instead of the automated Chrome/DeepSeek flow (default is automated)")
    args = ap.parse_args()

    if args.sanity_test:
        sanity_test()
        return

    topics = load_topics(args.start, args.limit)
    published_slugs, pending_pairs = load_existing_topics()
    print(f"Loaded {len(topics)} topics. {len(published_slugs)} already published, {len(pending_pairs)} pending.")

    if args.dry_run:
        run_topics(topics, published_slugs, pending_pairs, context=None, dry_run=True)
        return

    if args.manual:
        run_topics_manual(topics, published_slugs, pending_pairs)
        return

    user_data_root = ensure_clone()
    if not ensure_correct_chrome_profile(user_data_root):
        print("  Re-cloning Chrome profile from the source and rechecking...")
        user_data_root = ensure_clone(force=True)
        if not ensure_correct_chrome_profile(user_data_root):
            raise SystemExit(
                f"Chrome profile '{PROFILE_DIR}' is not signed into the Google account "
                f"{DEEPSEEK_ACCOUNT_EMAIL}, even after re-cloning. Open the REAL Chrome "
                f"profile '{PROFILE_DIR}' (not the clone under {CLONE_ROOT}), sign into "
                f"that Google account (and make sure DeepSeek is logged in there too), "
                f"then re-run."
            )

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(user_data_root), channel="chrome", headless=False,
            args=[f"--profile-directory={PROFILE_DIR}"], viewport=None,
        )
        # Needed to read back what DeepSeek's own Copy button puts on the
        # clipboard (see copy_via_button()) — without this, navigator.
        # clipboard.readText() silently returns "" instead of erroring.
        context.grant_permissions(["clipboard-read", "clipboard-write"], origin=DEEPSEEK_URL.rstrip("/"))
        run_topics(topics, published_slugs, pending_pairs, context=context, dry_run=False)
        context.close()


def run_topics_manual(topics, published_slugs, pending_pairs):
    """One topic fully processed - build, paste, copy, validate, push -
    before the next topic's prompt is even built. No browser, no automated
    tab-opening: you're in the loop for the actual AI exchange, so you see
    every reply as it happens instead of a batch racing ahead unattended."""
    done, skipped, failed = 0, 0, 0
    i = 0
    while i < len(topics):
        row = topics[i]
        i += 1
        topic, exam, subject, hindi_pct = row["topic"], row["exam"], row["subject"], row["hindi_pct"]
        print(f"\n{'=' * 70}\n[{i}/{len(topics)}] #{row['no']} {row['subject_raw']} -> {subject} ({hindi_pct}% Hindi)")
        print(f"Topic: {topic}\nExam:  {exam}")

        if is_duplicate(topic, exam, published_slugs, pending_pairs):
            print("  Skipping — already published or pending.")
            skipped += 1
            continue

        prompt_text = build_prompt(topic, exam, subject, hindi_pct)

        while True:  # retry loop for this one topic — 'r' below re-enters it
            copy_to_clipboard(prompt_text)
            print(f"\n  Prompt built ({len(prompt_text.split())} words) and copied to your clipboard.")
            print("  -> Paste it into DeepSeek or ChatGPT now, wait for the full reply, then copy that reply.")
            input("  Press Enter once the AI's reply is on your clipboard... ")

            raw_reply = read_clipboard()
            print(f"  Read {len(raw_reply)} chars from clipboard.")
            if END_SENTINEL not in raw_reply:
                choice = input(f"  [warn] Clipboard is missing {END_SENTINEL} — doesn't look like the full reply. "
                                f"Re-copy and press Enter to read again, or type 's' to skip this topic: ").strip().lower()
                if choice == "s":
                    failed += 1
                    break
                continue  # re-read the clipboard, same topic

            result = validate_and_bundle(raw_reply, topic, exam, subject, hindi_pct)
            if not result["pass"]:
                print("  HARD FAIL:")
                for f in result["hardFails"]:
                    print(f"    - {f}")
                debug_path = DEBUG_REPLIES_DIR / f"{i:03d}-{slugify(topic)[:60]}.txt"
                DEBUG_REPLIES_DIR.mkdir(parents=True, exist_ok=True)
                debug_path.write_text(raw_reply, encoding="utf-8")
                print(f"  Raw reply saved for debugging: {debug_path}")
                choice = input("  Fix it in the chat and retry this topic? [y/N]: ").strip().lower()
                if choice == "y":
                    continue  # re-paste for the same topic
                failed += 1
                break

            if result["warnings"]:
                print(f"  Passed with {len(result['warnings'])} warning(s) (non-blocking):")
                for w in result["warnings"]:
                    print(f"    - {w}")

            slug = result["bundle"]["seo"]["slug"]
            out_path = PENDING_DIR / f"{slug}.json"
            out_path.write_text(json.dumps(result["bundle"], ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"  Wrote {out_path.name} ({result['wordCount']} words)")

            push_choice = input("  Push to GitHub now? (triggers publish-long-post.yml) [Y/n]: ").strip().lower()
            if push_choice in ("", "y", "yes"):
                git_commit_and_push(out_path, f"Add long post: {slug} [automation]")
            else:
                print("  Left as a local pending file — push it yourself later when ready.")

            pending_pairs.add((topic.strip().lower(), exam.strip().lower()))
            done += 1
            break

        if i < len(topics):
            cont = input("\n  Continue to next topic? [Y/n]: ").strip().lower()
            if cont in ("n", "no"):
                print("  Stopping early at your request.")
                break

    print(f"\nBatch done: {done} published, {skipped} skipped (duplicate), {failed} failed/skipped.")


def run_topics(topics, published_slugs, pending_pairs, context, dry_run: bool):
    done, skipped, failed = 0, 0, 0
    for i, row in enumerate(topics, 1):
        topic, exam, subject, hindi_pct = row["topic"], row["exam"], row["subject"], row["hindi_pct"]
        print(f"\n[{i}/{len(topics)}] #{row['no']} {row['subject_raw']} -> {subject} "
              f"({hindi_pct}% Hindi) | {topic[:60]}...")

        if is_duplicate(topic, exam, published_slugs, pending_pairs):
            print("  Skipping — already published or pending.")
            skipped += 1
            continue

        prompt_text = build_prompt(topic, exam, subject, hindi_pct)
        print(f"  Prompt built: {len(prompt_text.split())} words")

        if dry_run:
            continue

        raw_reply = run_topic_through_deepseek(context, prompt_text)
        print(f"  DeepSeek reply captured: {len(raw_reply)} chars")

        result = validate_and_bundle(raw_reply, topic, exam, subject, hindi_pct)
        if not result["pass"]:
            print(f"  HARD FAIL — skipping this topic:")
            for f in result["hardFails"]:
                print(f"    - {f}")
            debug_path = DEBUG_REPLIES_DIR / f"{i:03d}-{slugify(topic)[:60]}.txt"
            DEBUG_REPLIES_DIR.mkdir(parents=True, exist_ok=True)
            debug_path.write_text(raw_reply, encoding="utf-8")
            print(f"  Raw reply saved for debugging: {debug_path}")
            failed += 1
            continue

        if result["warnings"]:
            print(f"  Passed with {len(result['warnings'])} warning(s) (non-blocking):")
            for w in result["warnings"]:
                print(f"    - {w}")

        slug = result["bundle"]["seo"]["slug"]
        out_path = PENDING_DIR / f"{slug}.json"
        out_path.write_text(json.dumps(result["bundle"], ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  Wrote {out_path.name} ({result['wordCount']} words)")

        git_commit_and_push(out_path, f"Add long post: {slug} [automation]")

        pending_pairs.add((topic.strip().lower(), exam.strip().lower()))
        done += 1

        cooldown = jitter(15, 40)
        print(f"  Cooling down {cooldown:.1f}s before next topic...")
        time.sleep(cooldown)

    print(f"\nBatch done: {done} published, {skipped} skipped (duplicate), {failed} hard-failed.")


if __name__ == "__main__":
    main()
