# hyperpower — Claude + Codex, one live table

[![ci](https://github.com/MisTraleuh/hyperpower/actions/workflows/ci.yml/badge.svg)](https://github.com/MisTraleuh/hyperpower/actions/workflows/ci.yml)

A Claude Code **plugin**. You type one thing; Claude and Codex divide the work,
**debate the plan**, implement, and cross-review — surfaced two ways: the native
`/workflows` table (with distinct `(claude)` and `(codex)` nodes), **and**
hyperpower's own full-screen live dashboard, `bin/hyperpower-progress`, which adds
a real **per-agent activity bar**, real token/tool counts, real durations, and the
Codex model parsed from each node's prompt. (The native `/workflows` row is drawn
by Claude Code's own binary and can't be extended by a plugin — so the dashboard is
a separate pane we fully control. See ["Live per-agent dashboard"](#live-per-agent-dashboard-our-own-view) and "Known limitations".)

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
> in the *native* `/workflows` row are drawn by Claude Code's own binary — a plugin
> can't add a per-agent bar *in that row* (the only per-node text a plugin controls
> there is the label, which is fixed once the agent spawns and never updates to show
> live or "done" state). Inside `/workflows` the one bar a plugin can draw is the
> **overall** `[████░░] %` line, emitted via `log()`. For a genuine **per-agent**
> bar, hyperpower ships its own separate-pane dashboard — see
> ["Live per-agent dashboard"](#live-per-agent-dashboard-our-own-view) and "Known limitations".

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

## Native `/workflows` progress bar (binary patch)

Want the bar **inside Claude Code's own `/workflows` table** (not a separate pane)?
hyperpower can inject it directly into the native binary:

- a real **animated per-agent bar** in the row gap — `[▱▱▱▱▱▱▱▱▱▱]` queued →
  `[▰▰▰▰▱▱▱▱▱▱]` marching while running → `[▰▰▰▰▰▰▰▰▰▰]` done — placed exactly
  between the model badge and the `9.2k tok · …` metadata;
- a **Codex-aware model badge**: `(codex)` rows show **"Codex gpt-5.5"** instead of
  the misleading proxy **"Sonnet 4.6"**.
- **Full activity** in an agent's drill-in view (the cap of 3 tool calls → 99), so you
  see everything an agent did, not just the last 3;
- **Pretty-printed JSON** in the drill-in *Outcome* — a raw `{"agree":false,…}` result is
  reformatted with indentation so it's actually readable.

Claude Code ships as a Bun-compiled native binary (no plugin hook for that row), so
this patches the binary's embedded JS. It is done safely: a **fresh-inode swap**
(busts the macOS AMFI signature cache), a pristine **`<binary>.orig` backup**, the
patched binary is **launch-verified** (backup restored if it won't run), and the
patcher **auto-degrades** — if a future Claude build doesn't match, it aborts and
leaves Claude untouched.

### Install (one command)

```bash
git clone https://github.com/MisTraleuh/hyperpower && cd hyperpower
bash tools/claude-bar/install.sh --auto
```

This patches the current Claude binary, creates a **`claude-auto`** launcher
(`claude --dangerously-skip-permissions` — autonomous mode), and installs a
**LaunchAgent** that re-applies the patch after each (~daily) Claude auto-update.
Restart Claude Code, run `/hyperpower <task> --codex`, open `/workflows` → bar.

| Action | Command |
| --- | --- |
| Patch / re-patch now | `bash tools/claude-bar/install.sh` |
| Patch + auto-reapply on updates | `bash tools/claude-bar/install.sh --auto` |
| Autonomous Claude (bypass perms) | `claude-auto` |
| Revert the patch | `cp <binary>.orig <binary> && codesign -f -s - <binary>` |
| Stop auto-reapply | `launchctl unload ~/Library/LaunchAgents/com.hyperpower.claudebar.plist` |

> ⚠️ `claude-auto` bypasses **all** permission prompts — use it only for unattended
> runs. Your normal `claude` stays permission-guarded. The patch is cosmetic +
> reversible; it never changes how Claude executes.

## How it works

| Piece | Role |
| --- | --- |
| `commands/hyperpower.md` | entry point — manages the allow-codex flag, proposes Codex on big tasks, launches the workflow |
| `workflows/hyperpower-debate.workflow.js` | skill-driven cycle: **Plan → Todo → Dev → Verify → Ship** (debate at every gate) |
| `agents/codex.md` | the `(codex)` persona — a thin proxy that drives `codex exec` |

The `(codex)` nodes shell out to the **Codex CLI** (`codex exec`). If `codex`
isn't on the PATH, the workflow degrades to Claude-only automatically.

## Orchestration (vs AgentMesh)

[AgentMesh](https://github.com/KuciaGuillaume/AgentMesh) is an MCP server that
coordinates Claude Code + Codex. hyperpower now does **both**: a debated workflow
**and** its own MCP server, matching AgentMesh's primitives — including **async
background delegation**:

| Primitive | hyperpower | how |
| --- | :---: | --- |
| Claude+Codex debate / cross-review | ✅ | the cycle (Plan→Todo→Dev→Verify→Ship), Codex debates at every gate; `cross_review` MCP tool |
| **Async background delegation** | ✅ | the MCP server's `delegate_to_codex` spawns `codex exec` **detached**, returns a `taskId` immediately, Claude keeps working, then `get_task_result`/`wait_for_tasks` collect it — true fire-and-forget |
| **Parallel delegation** | ✅ | in **Dev**, Claude implements *while* Codex preps tests/risks **concurrently** via the runtime's `parallel()` |
| **File claims (anti-clobber)** | ✅ | `bin/hpw-claims.js` atomic lock registry, exposed as MCP tools; conflicts return exit 3 (race-tested: 12 concurrent claimers → exactly 1 winner) |
| **Enforced file claims (hook)** | ✅ | a PreToolUse hook (`bin/hpw-claim-hook.js`) BLOCKS an Edit/Write to a file claimed by another owner — opt-in via `HYPERPOWER_RUN`, never breaks normal editing |
| **Strategy advice** | ✅ | `advise_strategy({task})` recommends who drives vs implements + whether to parallelize |
| **Persistent run/task state** | ✅ | structured records under `~/.hyperpower/<run>/` (tasks + run log) |
| **Auto-registered MCP server** | ✅ | `.mcp.json` ships with the plugin — tools load on install, usable from any Claude session (not only the workflow) |
| Live per-agent progress bar in the native table | ✅ **unique** | the binary patch above — AgentMesh has nothing like it |

### MCP server (async coordination)

`mcp/hyperpower-mcp.js` is a **dependency-free** Node stdio MCP server (hand-rolled
JSON-RPC 2.0), auto-registered via `.mcp.json`. Once the plugin is installed its
tools are available in any session:

| Tool | What |
| --- | --- |
| `delegate_to_codex({prompt, model?})` | start Codex in the background → `{taskId, status:"running"}` |
| `get_task_result({taskId})` / `wait_for_tasks({taskIds})` | collect async results |
| `cross_review({work, against})` | Codex reviews work (async) |
| `claim_files` / `release_files` / `list_claims` | atomic file locks |
| `record_task` / `read_run` | persistent run state |

So Claude can say *"delegate the implementation to Codex"* and keep going while
Codex runs — exactly AgentMesh's flagship move, with no external server to install.

### Bidirectional (drive from Claude **or** Codex)

The same server registers with **both** CLIs, so either agent can be the driver and
delegate to the other:

```bash
bash tools/install-mcp.sh   # registers the server with Codex + adds an AGENTS.md block
```

- In **Claude**: *"delegate the implementation to Codex"* → `delegate_to_codex`.
- In **Codex**: *"get Claude to review this"* → `delegate_to_claude` (runs `claude -p`
  read-only in the background, returns a `taskId`).

`delegate_to_claude` is advisory/read-only by design (no `--dangerously-skip-permissions`).
Claude-side registration is automatic via the plugin's `.mcp.json`; the script only
wires the Codex side (`~/.codex/config.toml` + `~/.codex/AGENTS.md`).

The file-claim CLI is also callable directly from Bash (the workflow script is
sandboxed):

```bash
node bin/hpw-claims.js claim <run> <owner> <file...>   # exit 3 on conflict
```

State lives under `~/.hyperpower/` (override with `HYPERPOWER_HOME`). Pure Node, no
deps, everything on your machine.

## Live per-agent dashboard (our own view)

Claude Code's `/workflows` table can't show a per-agent bar (its native binary draws
that row and a plugin can't touch it — see "Known limitations"). So hyperpower ships
its **own** full-screen live view that we fully control: `bin/hyperpower-progress`.
It reads the workflow's real-time state files and renders, per agent, an animated
activity bar plus the real measurements pulled from the transcript:

```
hyperpower · live dashboard  wf_2cfb98e7-ff9
────────────────────────────────────────────────────────────────────────
Plan
    ✔ (claude) draft-plan          [██████████████████████]  done     2k tok · 2 tools · StructuredOutput(do stuff) · 40s
Debate · round 2 (inferred)
    ✔ (codex · gpt-5.5) critique   [██████████████████████]  done     590 tok · 2 tools · StructuredOutput(false) · 22s
    ✔ (claude) revise              [██████████████████████]  done     2k tok · 0 tools · 20s
    ✔ (codex) critique             [██████████████████████]  error    120 tok · 1 tool · Bash(command -v codex) · 1s
    ⏺ (claude) build               [   ████▒ moving ▒     ]  running  6k tok · 1 tool · Edit(/a) · 18s
Review
    … review pending
────────────────────────────────────────────────────────────────────────
 [███████████████████░░░]  4/5 (≈5) agents · Build · 2m41
```

Reading it:

- **Engine + role.** `(claude)` nodes are **cyan**; `(codex)` nodes are **magenta**.
  The Codex model — `(codex · gpt-5.5)` — is parsed from that node's prompt blob
  (`codex exec … -m <model>`). A codex node with no extractable `-m` shows `(codex)`
  with **no** model rather than a guess.
- **The bar is an ACTIVITY animation, not a percentage.** Empty `░` = queued, a
  marching pulse window = running, full **green** = done. There is no honest "%
  complete" signal on disk, so we never fake one.
- **tok / tools are real measurements** summed from the transcript — including
  `0 tools` (shown, not hidden) when a node genuinely used none. They're omitted
  only while a transcript can't be parsed yet.
- **Durations are real transcript spans:** done = `lastTs − firstTs`, running =
  `now − firstTs`. File mtime is used only to detect "recently active", never shown
  as a duration.
- **The round and the `(≈N)` expected total are inferred from observed state.**
  Round = `max(1, critiqueCount)`. The expected total is a lower bound that grows as
  healthy codex critiques appear (each adds its revise, plus one codex review) and
  does not over-claim when a critique errors out — always kept `≥` the number of
  agents actually started.
- **Base phases that haven't started yet** (Plan / Build / Review always run) show a
  dim `… <phase> pending` placeholder — never a fabricated agent with fake tokens.

Run it in a **separate pane** (e.g. a tmux split) next to your Claude session:

```
hyperpower-progress           # auto-attach to the most recent active run
hyperpower-progress <wf_dir>  # attach to a specific run dir
```

It watches `~/.claude/projects/<proj>/<session>/subagents/workflows/wf_*/` —
`journal.jsonl` (started/result per agent) and the live `agent-<id>.jsonl` files.
Pure Node, no dependencies; non-TTY prints a single snapshot. Nothing to patch,
nothing the auto-updater can wipe.

## Known limitations / honesty

- **The `(codex)` model badge shows the Claude proxy model (e.g. Sonnet), not
  gpt-5.5.** A `(codex)` node is a Claude subagent that drives the Codex CLI, so
  the harness badge reflects the Claude model running the node. This is not
  fixable from a plugin. The `(codex · gpt-5.5)` text in the node **label** is the
  source of truth for which engine actually thought.
- **No per-agent bar *inside the native `/workflows` row*.** That row
  (`(claude) build  Opus 4.8  12k tok · 5 tools · 40s`) and the `X/Y agents · time`
  header are rendered by Claude Code's own **native binary** (a Bun-compiled
  executable under `~/.local/share/claude/versions/`). The only per-node text a
  plugin controls *there* is the **label**, fixed once the agent spawns and never
  updated — so it can't show an empty→running→full bar in that row, and the single
  **overall** `log()` bar is the only progress bar a plugin can draw *into
  `/workflows`*. A per-agent bar in the native row remains a feature request for
  Claude Code itself. **But a genuine per-agent bar does exist** — in hyperpower's
  separate-pane dashboard (`bin/hyperpower-progress`, see
  ["Live per-agent dashboard"](#live-per-agent-dashboard-our-own-view)), which reads
  the same real-time state files and renders an animated activity bar per agent.

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
/plugin marketplace add /Users/nathan/Desktop/Perso/hyperpower
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

<!-- hyperpower: dummy no-op marker (cosmetic; safe to remove) -->

