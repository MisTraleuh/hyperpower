# hyperpower — Claude + Codex, one live table

A Claude Code **plugin**. You type one thing; Claude and Codex split the work,
**debate the plan**, implement, and cross-review — all surfaced as a single live
progress table (the `/workflows` view) with distinct `(claude)` and `(codex)`
nodes.

```
▌ hyperpower: refacto auth middleware                      ⠋ running   /workflows
  Plan
    ✔ (claude) draft-plan        Opus 4.8 (1M context)   9.4k tok · 1 tool · 39s
  Debate · round 1
    ✔ (codex · gpt-5.5) critique r1   Sonnet 4.6   8.1k tok · 2 tools · 22s
    ✔ (claude) revise r1         Opus 4.8 (1M context)   6.4k tok · 0 tools · 31s
  Debate · round 2
    ✔ (codex · gpt-5.5) critique r2   Sonnet 4.6   4.2k tok · 2 tools · 18s
  Build
    ⠙ (claude) build             Opus 4.8 (1M context)   running…
  Review
    ○ (codex · gpt-5.5) review        queued
    ○ (claude) reconcile         queued
  [████████░░] 83%  5/6 agents · just finished: (codex) review
```

> The **only** bar is the **overall** one on the last line — emitted by the plugin
> via `log()` after each agent finishes. It is honest: it advances monotonically
> and tracks real completed/total agent counts.
>
> There is **no per-node bar**, on purpose. The only per-node text a plugin can set
> is the node's **label**; a label is fixed at agent-creation and never updated, so
> a bar there would freeze at 0% (a lie) and truncate the collapsed view. The model
> badge, the `9.4k tok · 1 tool · 39s` zone, and everything to the right of the
> label are drawn by the Claude Code Workflow harness and are not injectable from a
> plugin. See the note in `workflows/hyperpower-debate.workflow.js`.

## Use

```
/hyperpower refacto the auth middleware to the new session API, then add tests
```

- **Small task** → runs **Claude-only**.
- **Big task** (multi-file, refactor, tests, multi-module) → hyperpower **asks** whether
  to bring Codex into the loop, then runs the **debate** workflow.
- Force it either way: `/hyperpower <task> --codex` or `/hyperpower <task> --no-codex`.

The "allow codex" decision is remembered for the rest of the session.

## How it works

| Piece | Role |
| --- | --- |
| `commands/hyperpower.md` | entry point — manages the allow-codex flag, proposes Codex on big tasks, launches the workflow |
| `workflows/hyperpower-debate.workflow.js` | the live table: **Plan → Debate → Implement → Review** |
| `agents/codex.md` | the `(codex)` persona — a thin proxy that drives `codex exec` |

The `(codex)` nodes shell out to the **Codex CLI** (`codex exec`). If `codex`
isn't on the PATH, the workflow degrades to Claude-only automatically.

## Known limitations / honesty

- **The `(codex)` model badge shows the Claude proxy model (e.g. Sonnet), not
  gpt-5.5.** A `(codex)` node is a Claude subagent that drives the Codex CLI, so
  the harness badge reflects the Claude model running the node. This is not
  fixable from a plugin. The `(codex · gpt-5.5)` text in the node **label** is the
  source of truth for which engine actually thought.
- **No per-node progress bar.** The only per-node text a plugin can set is the
  label, which is fixed at creation and never updated — a bar there would freeze
  at 0% and truncate the collapsed view. The single **overall** bar (via `log()`)
  is the only honest one. The token/tool/duration zone and model badge are
  harness-drawn and cannot be modified by the plugin.

## Requirements

- Claude Code (with the Workflow tool available).
- **Optional:** the [Codex CLI](https://github.com/openai/codex) on your PATH for
  the Claude ↔ Codex debate. Without it, everything still works, Claude-only.

## Install

This repo is **both** a plugin and its own marketplace (`.claude-plugin/marketplace.json`).
From a Claude Code session:

```bash
# 1. add the marketplace (GitHub repo URL — relative paths resolve over git)
/plugin marketplace add https://github.com/MisTraleuh/hyperpower
# 2. install the plugin from it
/plugin install hyperpower@hyperpower
```

If you already added it before this file existed, refresh first:

```bash
/plugin marketplace update hyperpower
```

Local clone alternative:

```bash
/plugin marketplace add /Users/nathancatalan/Desktop/Perso/hyperpower
/plugin install hyperpower@hyperpower
```

(Exact commands can vary by Claude Code version — see `/plugin`.)

## Roadmap / upgrade path

- **Parallel-edit safety.** For agents editing files at the same time, wire in
  [AgentMesh](https://github.com/KuciaGuillaume/AgentMesh)'s MCP server
  (`claim_files`, cross-process locking) via the plugin's MCP config. hyperpower keeps
  the UX (table, debate, flag); AgentMesh provides the coordination primitives.
- `--rounds N` to cap/extend the debate.
- An arbiter node when Claude and Codex can't converge.
