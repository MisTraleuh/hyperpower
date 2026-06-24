# hyperpower — Claude + Codex, one live table

A Claude Code **plugin**. You type one thing; Claude and Codex split the work,
**debate the plan**, implement, and cross-review — all surfaced as a single live
progress table (the `/workflows` view) with distinct `(claude)` and `(codex)`
nodes.

```
▌ hyperpower: refacto auth middleware                      ⠋ running   /workflows
  Plan
    ✓ (claude) draft-plan              12.3k tok
  Debate · round 1
    ✓ (codex)  critique-plan            8.1k tok   → 3 objections
    ✓ (claude) revise-plan             6.4k tok   → 2 acceptées, 1 rejetée
  Debate · round 2
    ✓ (codex)  re-critique             4.2k tok   → accord ✓
  Implement
    ⠙ (codex)  implement+tests         running…
    ⠙ (claude) migration-notes         running…
  Review
    ○ (claude) cross-review            queued
```

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

## Install (local)

```bash
# from a Claude Code session, add this folder as a local plugin marketplace:
/plugin marketplace add /Users/nathancatalan/Desktop/Perso/hyperpower
/plugin install hyperpower
```

(Exact plugin-install commands depend on your Claude Code version — see
`/plugin` and the plugins docs.)

## Roadmap / upgrade path

- **Parallel-edit safety.** For agents editing files at the same time, wire in
  [AgentMesh](https://github.com/KuciaGuillaume/AgentMesh)'s MCP server
  (`claim_files`, cross-process locking) via the plugin's MCP config. hyperpower keeps
  the UX (table, debate, flag); AgentMesh provides the coordination primitives.
- `--rounds N` to cap/extend the debate.
- An arbiter node when Claude and Codex can't converge.
