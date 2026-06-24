# hyperpower — Claude + Codex, one live table

A Claude Code **plugin**. You type one thing; Claude and Codex split the work,
**debate the plan**, implement, and cross-review — all surfaced as a single live
progress table (the `/workflows` view) with distinct `(claude)` and `(codex)`
nodes.

```
▌ hyperpower: refacto auth middleware                  1/6 agents · 1m15s   /workflows
  Plan
    ✔ (claude) draft-plan          Opus 4.8 (1M context)   9.4k tok · 1 tool · 39s
  Debate · round 1
    ✔ (codex · gpt-5.5) critique r1   Sonnet 4.6   8.1k tok · 2 tools · 22s
    ✔ (claude) revise r1           Opus 4.8 (1M context)   6.4k tok · 0 tools · 31s
  Build
    ⠙ (claude) build               Opus 4.8 (1M context)   running…
  Review
    ○ (codex · gpt-5.5) review          queued
    ○ (claude) reconcile           queued
  [████████░░] 83%  5/6 agents · just finished: (codex) review
```

> **Progress.** The `1/6 agents · 1m15s` header and each node's `tok · tools · time`
> are drawn by Claude Code's own native binary — a plugin cannot add a per-agent
> progress bar in that row (the only per-node text a plugin controls is the label,
> which is fixed once the agent spawns and can never update to show live or "done"
> state). The one bar a plugin *can* draw is the **overall** `[████░░] %` line,
> emitted via `log()` after each agent. See "Known limitations" below.

## Use

```
/hyperpower refacto the auth middleware to the new session API, then add tests
```

- **Small task** → runs **Claude-only**.
- **Big task** (multi-file, refactor, tests, multi-module) → hyperpower **asks** whether
  to bring Codex into the loop, then runs the **debate** workflow.
- Force it either way: `/hyperpower <task> --codex` or `/hyperpower <task> --no-codex`.

When Codex is in the loop the debate is **real**: Codex must surface concrete
objections on the first pass (no rubber-stamping), and the plan goes through at
least one full critique→revise cycle before any agreement is accepted.

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
- **No per-agent progress bar — and it cannot be added by a plugin.** The node row
  (`(claude) build  Opus 4.8  12k tok · 5 tools · 40s`) and the `X/Y agents · time`
  header are rendered by Claude Code's own **native binary** (a Bun-compiled
  executable under `~/.local/share/claude/versions/`). The only per-node text a
  plugin controls is the **label**, which is fixed once the agent spawns and never
  updates — so it can't show a bar that's empty→running→full per agent. A genuine
  per-agent bar is a feature request for Claude Code itself. The single **overall**
  bar (via `log()`) is the only honest progress bar a plugin can draw.

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
