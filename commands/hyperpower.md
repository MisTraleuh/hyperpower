---
description: Run a Claude+Codex debate-and-build workflow on a task (live table)
argument-hint: [task] [--codex|--no-codex] [--quick]
---

The user invoked `/hyperpower`. The task is:

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

## 2. Run the workflow — it IS the deliverable

Call the **Workflow** tool with:

- `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/hyperpower-debate.workflow.js`
- `args`: a real JSON **object** (NOT a stringified JSON):
  `{ "task": "<the cleaned task text, flags stripped>", "allowCodex": <true|false>, "quick": <true|false> }`

**Cycle depth — the workflow decides on its own.**
By default DON'T set `quick`/`full` — the workflow's first agent self-assesses the
task complexity and picks **quick** (short Plan→Debate→Build→Review) or **full**
(Plan→Todo→Dev→Verify→Ship). You don't have to guess.

Only set a flag to OVERRIDE that decision:
- `--quick` / `--lite` in the args → pass `"quick": true` (force the short cycle).
- `--full` / `--deep` in the args → pass `"full": true` (force the full cycle).
Strip the flag from the task text. With no flag, pass neither — let it auto-decide.

> ⚠️ Pass `args` as an actual object. If you pass a JSON *string*
> (`"{\"task\":...}"`), the script sees `args.task` as undefined and runs with
> "No task provided". This is the #1 failure mode — get it right.

This renders the live table in `/workflows` — a skill-driven cycle **Plan → Todo →
Dev → Verify → Ship** with `(claude)` and `(codex·<model>)` nodes that **debate at
every gate** (plan, todo, audit, final review), apply the user's skills (todo, dev,
verify-dev, build, test), and **loop back to Dev if Verify is KO**. Tell the user to
watch it live with `/workflows`.

**Do NOT run your own parallel investigation in the main thread.** The workflow is
the show — launch it, let the `(claude)`/`(codex)` nodes do the work, then report
*its* result. Only step in manually if the workflow returns an error.

> Codex safety: the `(codex)` nodes run `codex exec` HEADLESSLY with stdin fed from
> a file (never the terminal) and `--sandbox read-only`. They must never launch
> interactive `codex`. If `codex` isn't on PATH, the workflow degrades to
> Claude-only on its own — surface that, don't fail.

## 3. Report — concise, NO wall of text

The user hates giant paragraphs. Give a TIGHT summary, one line per point:
- **Verdict** — one line.
- **Plan** — the agreed plan in ≤3 bullets.
- **Debate** — one line per round: which Codex objections were accepted vs rejected.
- **Build** — what was found/changed, with `file:line`, in a few bullets.

Point to `/workflows` for the full detail (incl. each Codex node's transcript);
don't paste that detail into the report.
