#!/usr/bin/env bash
#
# hyperpower claude-bar installer
# ===============================
# Injects, INTO the Claude Code native binary, an animated per-agent progress bar
# (empty -> marching -> full, right in the /workflows row gap) and a Codex-aware
# model badge ("Codex gpt-5.5" instead of the proxy "Sonnet 4.6").
#
# It also:
#   - creates a `claude-auto` launcher = `claude --dangerously-skip-permissions`
#     (autonomous mode; your normal `claude` stays permission-guarded).
#   - with --auto: installs a LaunchAgent that re-applies the patch after Claude
#     Code's (≈daily) auto-update replaces the binary.
#
# SAFETY: works only on a fresh-inode COPY (busts the macOS AMFI signature cache),
# keeps a pristine backup at <binary>.orig, verifies the patched binary launches
# (and restores the backup if it doesn't). The patcher itself safe-degrades: if it
# can't find its edit sites on a future build, it aborts and leaves Claude untouched.
#
# Usage:
#   ./install.sh           # patch + launcher
#   ./install.sh --auto    # also install the auto-reapply LaunchAgent
#
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/.local/bin/claude"
LAUNCHER="$HOME/.local/bin/claude-auto"
MARK='Math.floor(Date.now()/250)%10'   # unique marker of our injected bar
log(){ printf '%s\n' "$*"; }

setup_agent(){
  local PL="$HOME/Library/LaunchAgents/com.hyperpower.claudebar.plist"
  mkdir -p "$HOME/Library/LaunchAgents"

  # Stage a COPY of the tool OUT of any TCC-protected path. macOS TCC forbids a
  # LaunchAgent from executing scripts located under ~/Desktop, ~/Documents or
  # ~/Downloads ("Operation not permitted" — the exact failure we hit when $DIR was
  # under ~/Desktop). ~/.local/share is not protected. Refresh the copy on every run
  # so the agent always tracks the repo's current tool.
  local STAGE="$HOME/.local/share/hyperpower/claude-bar"
  mkdir -p "$STAGE"
  if [ "$(cd "$DIR" && pwd)" != "$(cd "$STAGE" && pwd)" ]; then
    if ! cp "$DIR/install.sh" "$DIR/bun_reapply.py" "$STAGE/"; then
      log "⚠️  could not stage tool into $STAGE — LaunchAgent NOT installed"; return 1
    fi
  fi
  chmod +x "$STAGE/install.sh"

  # Build a PATH that resolves node / python3 / codesign inside the LaunchAgent's
  # minimal environment (its default PATH is only /usr/bin:/bin:/usr/sbin:/sbin, so
  # a Homebrew/nvm `node` is invisible and bun_reapply.py's `node --check` would
  # safe-degrade). Derive the real tool dirs at install time.
  local EXTRA="" tool d
  for tool in node python3 codesign; do
    d="$(command -v "$tool" 2>/dev/null)" && d="$(dirname "$d")" || d=""
    [ -n "$d" ] || continue
    # dedup against the standard tail AND anything already collected
    case ":/usr/bin:/bin:/usr/sbin:/sbin:$EXTRA:" in *":$d:"*) : ;; *) EXTRA="${EXTRA:+$EXTRA:}$d";; esac
  done
  local AGENT_PATH="${EXTRA:+$EXTRA:}/usr/bin:/bin:/usr/sbin:/sbin"

  cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.hyperpower.claudebar</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$STAGE/install.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$AGENT_PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>14400</integer>
  <key>StandardOutPath</key><string>/tmp/hyperpower-claudebar.log</string>
  <key>StandardErrorPath</key><string>/tmp/hyperpower-claudebar.log</string>
</dict></plist>
EOF
  launchctl unload "$PL" 2>/dev/null || true
  launchctl load "$PL"  2>/dev/null || true
  log "✅ auto-reapply LaunchAgent installed (staged at $STAGE; PATH=$AGENT_PATH; re-checks at login + every 4h)"
}

# 0. claude-auto launcher (always; idempotent) -------------------------------
mkdir -p "$HOME/.local/bin"
cat > "$LAUNCHER" <<'EOF'
#!/bin/bash
# Claude Code in autonomous mode (permissions bypassed). Same patched binary, so
# you still get the hyperpower bar + codex badge. Your normal `claude` stays safe.
exec claude --dangerously-skip-permissions "$@"
EOF
chmod +x "$LAUNCHER"
log "✅ launcher: claude-auto  (claude --dangerously-skip-permissions)"

# 1. resolve the real versioned binary ---------------------------------------
[ -e "$BIN" ] || { log "❌ ~/.local/bin/claude not found — is Claude Code installed natively?"; exit 1; }
LIVE="$(python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$BIN")"
log "claude binary: $LIVE"

# 2. already patched? --------------------------------------------------------
if grep -q "$MARK" "$LIVE" 2>/dev/null; then
  log "✅ already patched (bar + badge present) — nothing to do."
  [ "${1:-}" = "--auto" ] && setup_agent
  exit 0
fi

# 3. patch -> verified copy (safe-degrades on its own) -----------------------
TMPD="$(mktemp -d)"; TMP="$TMPD/patched"
log "→ patching (bar + codex badge)…"
if ! python3 "$DIR/bun_reapply.py" --binary "$LIVE" --out "$TMP" >"$TMPD/log" 2>&1; then
  log "❌ patch failed — Claude left untouched. Tail:"; tail -6 "$TMPD/log" | sed 's/^/   /'; rm -rf "$TMPD"; exit 1
fi

# 4. backup + swap with a FRESH INODE (busts the AMFI signature cache) --------
[ -f "$LIVE.orig" ] || cp "$LIVE" "$LIVE.orig"
rm "$LIVE"; cp "$TMP" "$LIVE"; chmod +x "$LIVE"; codesign -f -s - "$LIVE" >/dev/null 2>&1
rm -rf "$TMPD"

# 5. verify; restore on failure ----------------------------------------------
if "$LIVE" --version >/dev/null 2>&1; then
  log "✅ patched live binary: $LIVE   (backup: $LIVE.orig)"
else
  log "❌ patched binary won't launch — restoring backup"
  rm "$LIVE"; cp "$LIVE.orig" "$LIVE"; chmod +x "$LIVE"; codesign -f -s - "$LIVE" >/dev/null 2>&1
  exit 1
fi

[ "${1:-}" = "--auto" ] && setup_agent
log "Done. Restart Claude Code — the bar appears in /workflows."
