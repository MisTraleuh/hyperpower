# hyperpower — Claude + Codex, one live table

A Claude Code **plugin**. You type one thing; Claude and Codex split the work,
**debate the plan**, implement, and cross-review — all surfaced as a single live
progress table (the `/workflows` view) with distinct `(claude)` and `(codex)`
nodes.

```
▌ hyperpower: refacto auth middleware                      ⠋ running   /workflows
  Plan
    ✓ (claude) draft-plan  [██████████] 100%      12.3k tok
  Debate · round 1
    ✓ (codex)  critique r1 [██████████] 100%       8.1k tok   → 3 objections
    ✓ (claude) revise r1   [██████████] 100%       6.4k tok   → 2 acceptées, 1 rejetée
  Debate · round 2
    ✓ (codex)  re-critique [██████████] 100%       4.2k tok   → accord ✓
  Build
    ⠙ (claude) build       [░░░░░░░░░░] 0%         running…
  Review
    ○ (codex)  review      [░░░░░░░░░░] 0%         queued
    ○ (claude) reconcile   [░░░░░░░░░░] 0%         queued
  [████████░░] 83%  5/6 agents · just finished: (codex) review
```

> The `[██████░░░░] %` bar is rendered **by the plugin**, not the harness. Each
> node carries a bar in its **label** (the only per-node text the script controls),
> and an **overall** workflow bar is emitted via `log()` after each agent finishes.
> The `12.3k tok` count to the right is drawn by the Claude Code Workflow harness
> and is out of the plugin's control — a bar on its own row beneath that harness
> line is not something a plugin can add. See the note in
> `workflows/hyperpower-debate.workflow.js`.

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
