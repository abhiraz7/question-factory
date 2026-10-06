# Agent Log

A running, git-tracked daily log of work done on this repo by any AI coding
agent (Claude, Cursor, Copilot, etc.) or human. Its purpose: whoever/whatever
opens this project next — a new session, a different tool, a different
person — can read this folder first and pick up full context without
re-deriving it from scratch or asking the user to repeat themselves.

This is scoped to **this repo only** (`Notes-factory`). It is not a replacement
for `AgentLog.md` at the project root, which covers the broader
project (server deploys, WordPress theme/plugin work, credentials reference)
outside this repo's boundary — link to it, don't duplicate it.

## Convention

- **One file per day**: `agent-log/YYYY-MM-DD.md`. Create a new one the first
  time you touch this repo on a given date; append to today's file for
  everything after that, don't create a second file for the same day.
- **Append, don't rewrite.** Add new entries under a `## HH:MM — short title`
  heading at the bottom of the day's file. Never edit or delete a past day's
  file to "clean it up" — this is a log, not a living doc; if something
  turns out wrong, add a correction entry rather than silently editing history.
- **Every entry should answer, briefly:**
  - What was asked / what problem came up
  - What was actually found or changed (file paths, not vague summaries)
  - What's still open / what the next agent should know before touching this
    area again
- **Link don't repeat.** If `PROJECT-KNOWLEDGE.md` or a pipeline's own
  `README.md` already explains *how* something works, link to it
  (`[long-post-factory/README.md](../long-post-factory/README.md)`) instead
  of re-explaining the architecture inline — this log is for *what happened
  and when*, the other docs are for *how the system works*.
- **Commit it like any other change** — this folder is meant to be part of
  normal commits, not a side-channel. A session that changes code should
  commit its log entry in the same or a companion commit, so `git log` and
  the daily log stay in sync.

## For an agent starting a new session here

Read, in order:
1. `agent-log/` — the last 2-3 daily files, newest first, for recent context
2. `PROJECT-KNOWLEDGE.md` — architecture/how-it-works reference
3. Whichever pipeline's own `README.md` you're about to touch
   (`notes-factory/`, `long-post-factory/`, `automation/`, `question-factory/`)

Then start work, and add today's entry here before you finish.
