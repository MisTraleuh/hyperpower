#!/usr/bin/env bash
#
# Force the INSTALLED hyperpower plugin cache to the latest version.
#
# Why: `/reload-plugins` loads the plugin from the marketplace CACHE
# (~/.claude/plugins/cache/...), not from your working git clone. If the cache is
# stale (e.g. predates the bundled MCP server), reload shows "0 plugin MCP servers".
# This refreshes the marketplace clone and rebuilds the cache to the newest version,
# then you just run /reload-plugins.
#
# Safe: backs up installed_plugins.json, validates JSON, never touches your repo.
# Usage:  bash tools/update-plugin-cache.sh   (run on the machine where Claude runs)
set -uo pipefail

PLUGINS="$HOME/.claude/plugins"
MP="$PLUGINS/marketplaces/hyperpower"
CACHE="$PLUGINS/cache/hyperpower/hyperpower"
IP="$PLUGINS/installed_plugins.json"
log(){ printf '%s\n' "$*"; }

[ -d "$MP" ] || { log "❌ marketplace clone not found at $MP"; log "   Install the plugin first: in Claude, add the marketplace https://github.com/MisTraleuh/hyperpower then /plugin install hyperpower."; exit 1; }
command -v node >/dev/null || { log "❌ node not on PATH"; exit 1; }

log "→ refreshing marketplace clone…"
git -C "$MP" fetch --quiet origin 2>/dev/null
git -C "$MP" reset --hard origin/main --quiet 2>/dev/null || git -C "$MP" pull --ff-only 2>&1 | tail -1
VER="$(node -e "process.stdout.write(require('$MP/.claude-plugin/plugin.json').version)")"
SHA="$(git -C "$MP" rev-parse HEAD)"
log "   marketplace now at version $VER ($SHA)"

log "→ rebuilding cache $CACHE/$VER …"
rm -rf "$CACHE/$VER"; mkdir -p "$CACHE/$VER"
( cd "$MP" && git archive HEAD | tar -x -C "$CACHE/$VER" )
[ -f "$CACHE/$VER/.mcp.json" ] && log "   ✅ .mcp.json present" || log "   ⚠️ no .mcp.json in this version"

log "→ pointing installed_plugins.json at $VER …"
[ -f "$IP" ] || { log "❌ $IP not found — is the plugin installed?"; exit 1; }
cp "$IP" "$IP.bak"
node -e '
const fs=require("fs"), ip=process.argv[1], p=process.argv[2], v=process.argv[3], sha=process.argv[4];
const d=JSON.parse(fs.readFileSync(ip,"utf8"));
const key=Object.keys(d.plugins||{}).find(k=>k.startsWith("hyperpower"));
if(!key){console.error("hyperpower not in installed_plugins.json");process.exit(1);}
const e=Array.isArray(d.plugins[key])?d.plugins[key][0]:d.plugins[key];
e.installPath=p; e.version=v; e.gitCommitSha=sha;
fs.writeFileSync(ip, JSON.stringify(d,null,2));
console.log("   ✅ installed -> "+v);
' "$IP" "$CACHE/$VER" "$VER" "$SHA" || { log "restoring backup"; cp "$IP.bak" "$IP"; exit 1; }

log ""
log "Done. Now in Claude Code run:  /reload-plugins"
log "You should see '1 plugin MCP server'. Approve it on first use."
