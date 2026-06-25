#!/usr/bin/env node
'use strict'
/*
 * hpw-claim-hook.js — PreToolUse hook that ENFORCES file claims (anti-clobber).
 *
 * Without this, claim_files is advisory (agents are merely told to claim). This
 * hook makes it a real guarantee: before an Edit/Write/NotebookEdit touches a file,
 * it checks the claim registry — if the file is claimed by ANOTHER owner in the
 * active run, the edit is BLOCKED.
 *
 * Opt-in by design (never breaks normal editing): it only enforces when the env
 * var HYPERPOWER_RUN is set (a coordinated run). Owner = HYPERPOWER_OWNER || "claude".
 * If HYPERPOWER_RUN is unset, or the tool isn't a file-writer, it allows silently.
 *
 * Wired as a PreToolUse hook. Reads the hook JSON on stdin:
 *   { tool_name, tool_input: { file_path | notebook_path, ... }, ... }
 * Decision via stdout JSON: {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *   "permissionDecision":"deny"|"allow","permissionDecisionReason":"..."}}
 * (also exits 0 always so a hook error never hard-blocks the user).
 */
const fs = require('fs')
const path = require('path')

function allow() { process.exit(0) } // no output = default allow
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function main(input) {
  const runId = process.env.HYPERPOWER_RUN
  if (!runId) allow() // not a coordinated run → never interfere
  const owner = process.env.HYPERPOWER_OWNER || 'claude'

  let data
  try { data = JSON.parse(input) } catch { allow() }
  const tool = data.tool_name || data.toolName
  if (!/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(tool || '')) allow()

  const ti = data.tool_input || data.toolInput || {}
  const target = ti.file_path || ti.notebook_path || ti.path
  if (!target) allow()

  let claims
  try { claims = require(path.join(__dirname, 'hpw-claims.js')) } catch { allow() }
  const table = claims.listClaims(runId)
  const abs = path.resolve(target)
  const cur = table[abs]
  if (cur && cur.owner !== owner) {
    deny('hyperpower: ' + path.basename(abs) + ' is claimed by "' + cur.owner +
      '" in this run — do not edit it (anti-clobber). Work around it, or wait for release. ' +
      'You ("' + owner + '") may claim your own files via bin/hpw-claims.js.')
  }
  // Not claimed (or claimed by us): allow, and auto-claim so a later parallel agent
  // sees it's taken.
  try { claims.claimFiles(runId, owner, [abs], { now: claims.nowStamp() }) } catch {}
  allow()
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { buf += d })
process.stdin.on('end', () => main(buf))
process.stdin.on('error', () => allow())
// Safety: if no stdin arrives, don't hang the tool call.
setTimeout(() => allow(), 2000)
