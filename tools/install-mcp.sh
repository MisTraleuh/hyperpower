#!/usr/bin/env bash
#
# hyperpower MCP installer — bidirectional Claude <-> Codex coordination.
#
# Claude side: the plugin auto-registers the server via .mcp.json on install, so
#   normally nothing to do here. (Run `/plugin marketplace update hyperpower` +
#   reinstall, then `/reload-plugins` in Claude Code to pick it up.)
# Codex side: this script registers the same server with the Codex CLI and adds a
#   coordination block to ~/.codex/AGENTS.md so Codex knows the tools exist.
#
# After this, you can start a session in EITHER cli and delegate to the other:
#   - in Claude:  "delegate the implementation to Codex"   (delegate_to_codex)
#   - in Codex:   "get Claude to review this"              (delegate_to_claude)
#
# Idempotent. Usage: bash tools/install-mcp.sh
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$DIR/mcp/hyperpower-mcp.js"
log(){ printf '%s\n' "$*"; }

[ -f "$SERVER" ] || { log "❌ server not found: $SERVER"; exit 1; }
command -v node >/dev/null || { log "❌ node not on PATH"; exit 1; }

# --- Codex side: register the MCP server ------------------------------------
if command -v codex >/dev/null; then
  codex mcp remove hyperpower >/dev/null 2>&1 || true
  if codex mcp add hyperpower -- node "$SERVER" >/dev/null 2>&1; then
    log "✅ registered MCP server with Codex (codex mcp list)"
  else
    log "⚠️  could not register with Codex (codex mcp add failed)"
  fi
  # --- AGENTS.md coordination block (idempotent) ----------------------------
  AG="$HOME/.codex/AGENTS.md"; mkdir -p "$HOME/.codex"
  MARK="## hyperpower — you can delegate to Claude (bidirectional coordination)"
  if [ -f "$AG" ] && grep -qF "$MARK" "$AG"; then
    log "✅ Codex AGENTS.md already has the hyperpower block"
  else
    cat >> "$AG" <<'EOF'

## hyperpower — you can delegate to Claude (bidirectional coordination)

You have the **hyperpower** MCP server connected. Use it proactively:
- `delegate_to_claude({prompt})` — get Claude to critique/review a plan or diff
  (async; returns a taskId; collect with get_task_result/wait_for_tasks).
- `cross_review({work, against})` — Claude reviews your work before you ship.
- `claim_files({owner:"codex", files:[...]})` before parallel edits (no clobber).
- `record_task({agent:"codex", role, result})` for a durable run log.
EOF
    log "✅ appended hyperpower block to $AG"
  fi
else
  log "⚠️  codex not on PATH — skipping Codex-side registration (Claude side still works)"
fi

log ""
log "Done. Claude side loads via the plugin's .mcp.json on install."
log "Restart Codex / Claude sessions to connect the server."
