'use strict'
/*
 * hpw-claims.js — atomic file-claim registry + structured run state for hyperpower.
 *
 * This is what lets parallel agents edit the repo WITHOUT clobbering each other
 * (the "claim_files" capability AgentMesh has and we lacked). An agent declares
 * the files it intends to write BEFORE writing; overlaps are detected atomically
 * and the loser is told to back off. Pure Node, no deps.
 *
 * State lives in ~/.hyperpower/<run-id>/ :
 *   claims.json   — { path: {owner, ts} }   the live lock table
 *   run.json      — structured run record (who/what/when/result), appended-to
 *
 * Atomicity: we don't trust read-modify-write on claims.json directly. We take a
 * coarse lock via fs.mkdirSync(lockdir) (mkdir is atomic on POSIX) with a small
 * spin, mutate, then release. Good enough for the handful of agents a workflow
 * spawns; honest about its scope (single machine, cooperative agents).
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

function root(runId) {
  const base = process.env.HYPERPOWER_HOME || path.join(os.homedir(), '.hyperpower')
  return path.join(base, String(runId || 'default'))
}
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }) }

// --- coarse atomic lock via mkdir (atomic on POSIX) -------------------------
function withLock(dir, fn) {
  const lockdir = path.join(dir, '.lock')
  const deadline = Date.now() + 2000
  for (;;) {
    try { fs.mkdirSync(lockdir); break }
    catch (e) {
      if (e.code !== 'EEXIST') throw e
      // stale lock guard: if older than 5s, steal it
      try { if (Date.now() - fs.statSync(lockdir).mtimeMs > 5000) { fs.rmdirSync(lockdir); continue } } catch {}
      if (Date.now() > deadline) { try { fs.rmdirSync(lockdir) } catch {} ; continue }
      // tiny busy-wait (sync, bounded) — workflows have few agents
      const until = Date.now() + 15; while (Date.now() < until) {}
    }
  }
  try { return fn() } finally { try { fs.rmdirSync(lockdir) } catch {} }
}

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return dflt }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, file) // atomic replace
}

/**
 * Try to claim a set of files for `owner`. Returns
 *   { granted: [...], conflicts: [{path, owner}] }
 * Granted paths are now locked to owner. Conflicting paths keep their owner.
 * Re-claiming a path you already own is a no-op success.
 */
function claimFiles(runId, owner, files, opts = {}) {
  const dir = root(runId); ensureDir(dir)
  const claimsFile = path.join(dir, 'claims.json')
  return withLock(dir, () => {
    const claims = readJson(claimsFile, {})
    const granted = [], conflicts = []
    for (const raw of files) {
      const p = path.resolve(raw)
      const cur = claims[p]
      if (!cur || cur.owner === owner) {
        claims[p] = { owner, ts: opts.now || nowStamp() }
        granted.push(p)
      } else {
        conflicts.push({ path: p, owner: cur.owner })
      }
    }
    writeJson(claimsFile, claims)
    return { granted, conflicts }
  })
}

/** Release some/all of an owner's claims (call when an agent is done editing). */
function releaseFiles(runId, owner, files) {
  const dir = root(runId)
  const claimsFile = path.join(dir, 'claims.json')
  return withLock(dir, () => {
    const claims = readJson(claimsFile, {})
    const set = files && files.length ? new Set(files.map((f) => path.resolve(f))) : null
    let released = 0
    for (const p of Object.keys(claims)) {
      if (claims[p].owner === owner && (!set || set.has(p))) { delete claims[p]; released++ }
    }
    writeJson(claimsFile, claims)
    return { released }
  })
}

function listClaims(runId) { return readJson(path.join(root(runId), 'claims.json'), {}) }

// --- structured persistent run state ---------------------------------------
function nowStamp() {
  // ISO-ish without Date.now() restrictions in workflow scripts: callers pass now.
  try { return new Date().toISOString() } catch { return null }
}

/** Append a structured task record to the run log (who/what/when/result). */
function recordTask(runId, rec) {
  const dir = root(runId); ensureDir(dir)
  const file = path.join(dir, 'run.json')
  return withLock(dir, () => {
    const run = readJson(file, { runId: String(runId), tasks: [] })
    run.tasks.push(rec)
    run.updatedAt = rec.ts || null
    writeJson(file, run)
    return run.tasks.length
  })
}
function readRun(runId) { return readJson(path.join(root(runId), 'run.json'), null) }

// Read the plugin version straight from .claude-plugin/plugin.json.
// INLINE parse on purpose — NOT readJson() (lines 47-49), which swallows errors and
// returns a default; here a missing/malformed plugin.json MUST surface (the CLI
// try/catch renders it as `error: <msg>` exit 1). Anchored on __dirname (the only
// stable anchor for subagents): bin/ -> .. -> repo root -> .claude-plugin/plugin.json.
function pluginVersion() {
  const file = path.join(__dirname, '..', '.claude-plugin', 'plugin.json')
  const obj = JSON.parse(fs.readFileSync(file, 'utf8')) // throws on missing/malformed -> caught by CLI try/catch
  if (!obj || typeof obj !== 'object' || typeof obj.version !== 'string' || obj.version.length === 0) {
    throw new Error('plugin.json: version must be a non-empty string')
  }
  return obj.version
}

module.exports = {
  root, claimFiles, releaseFiles, listClaims, recordTask, readRun, nowStamp,
}

// --- CLI: workflow agents (which have Bash, not require) drive claims via this --
// Usage:
//   node hpw-claims.js claim   <runId> <owner> <file...>   -> JSON {granted,conflicts}; exit 3 if any conflict
//   node hpw-claims.js release <runId> <owner> [file...]   -> JSON {released}
//   node hpw-claims.js list    <runId>                     -> JSON claim table
//   node hpw-claims.js record  <runId> <agent> <role> <result>
//   node hpw-claims.js version                              -> plugin version (plain text, no runId)
if (require.main === module) {
  const [cmd, runId, a, b, ...rest] = process.argv.slice(2)
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
  try {
    if (cmd === 'claim') {
      const r = claimFiles(runId, a, [b, ...rest].filter(Boolean), { now: nowStamp() })
      out(r); process.exit(r.conflicts.length ? 3 : 0)
    } else if (cmd === 'release') {
      out(releaseFiles(runId, a, [b, ...rest].filter(Boolean)))
    } else if (cmd === 'list') {
      out(listClaims(runId))
    } else if (cmd === 'record') {
      const n = recordTask(runId, { agent: a, role: b, result: rest.join(' '), ts: nowStamp() })
      out({ recorded: n })
    } else if (cmd === 'version') {
      // CLI policy: version takes no operands; any trailing args are ignored
      // (consistent with claim/release/list/record, which also ignore surplus
      // positional args). Intentional — not incidental. See 1.4 for the lock.
      // Plain text (NOT out(), which JSON.stringifies): stdout must be exactly `<version>\n`.
      process.stdout.write(pluginVersion() + '\n')
    } else {
      process.stderr.write(
        'usage: claim|release|list|record <runId> ...\n' +
        '       version                       (no args; prints plugin version)\n'
      ); process.exit(2)
    }
  } catch (e) { process.stderr.write('error: ' + e.message + '\n'); process.exit(1) }
}
