---
description: Run a Claude+Codex debate-and-build workflow on a task (live table)
argument-hint: [task] [--codex|--no-codex]
---

The user invoked `/mesh`. The task is:

$ARGUMENTS

Think hard (ultrathink) and follow this procedure exactly.

## 1. Decide Codex involvement (the "allow codex" flag)

- If the arguments contain `--codex`, set `allowCodex = true`. If they contain
  `--no-codex`, set `allowCodex = false`. Either way, remember it for the rest of
  this session and skip to step 2.
- If the user already allowed/denied Codex earlier this session, reuse that
  decision silently.
- Otherwise, judge the task size. Treat it as **BIG** if it: spans multiple
  files, is a refactor or migration, adds/changes tests, or touches more than one
  module/subsystem.
- If **BIG** and Codex isn't decided yet, ask with the `AskUserQuestion` tool
  whether to bring Codex into the loop:
    - "Oui — débat Claude ↔ Codex" → `allowCodex = true`
    - "Non — Claude seul" → `allowCodex = false`
  Remember the answer for the rest of the session.
- If the task is small, default to `allowCodex = false`.

## 2. Run the workflow

Call the **Workflow** tool with:

- `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/mesh-debate.workflow.js`
- `args`: `{ "task": "<the cleaned task text, flags stripped>", "allowCodex": <true|false> }`

This renders the live table — phases **Plan → Debate → Implement → Review** with
`(claude)` and `(codex)` nodes. Tell the user they can watch it live with
`/workflows`.

> Note: the `(codex)` nodes drive the Codex CLI (`codex exec`). If `codex` is not
> on the PATH, the workflow degrades to Claude-only automatically — surface that
> to the user rather than failing.

## 3. Report

Summarize the final agreed plan, what changed (files / tests), and the
cross-review verdict. If a debate happened, mention which Codex objections were
accepted vs rejected.
