#!/usr/bin/env node
'use strict'
/*
 * mcp.test.js — real JSON-RPC round-trip test for hyperpower-mcp.js.
 *
 * Spawns the server as a child, speaks Content-Length-framed JSON-RPC 2.0 over
 * its stdio, and asserts the contract. Pure Node, no deps.
 *
 * Uses an isolated HYPERPOWER_HOME + HYPERPOWER_RUN so it never touches real run state.
 */

const { spawn, spawnSync } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')

const SERVER = path.join(__dirname, '..', 'mcp', 'hyperpower-mcp.js')
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hpw-mcp-test-'))

let pass = 0, fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS: ' + label) }
  else { fail++; console.log('  FAIL: ' + label) }
}

// --- Newline-delimited JSON client over the child's stdio (MCP stdio standard) --
function makeClient(child) {
  let buf = ''
  const waiters = new Map() // id -> resolve
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id !== undefined && msg.id !== null && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg)
        waiters.delete(msg.id)
      }
    }
  })
  let nextId = 1
  function send(method, params, isNotification) {
    const obj = { jsonrpc: '2.0', method }
    if (params !== undefined) obj.params = params
    let id
    if (!isNotification) { id = nextId++; obj.id = id }
    child.stdin.write(JSON.stringify(obj) + '\n')
    if (isNotification) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for id ' + id + ' (' + method + ')')), 200000)
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    })
  }
  return { send }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function main() {
  const hasCodex = (() => {
    const r = spawnSync('which', ['codex'], { encoding: 'utf8' })
    return r.status === 0 && r.stdout.trim()
  })()
  const hasClaude = (() => {
    const r = spawnSync('which', ['claude'], { encoding: 'utf8' })
    return r.status === 0 && r.stdout.trim()
  })()

  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: Object.assign({}, process.env, {
      HYPERPOWER_HOME: TMP_HOME,
      HYPERPOWER_RUN: 'test-run',
    }),
  })
  const client = makeClient(child)

  console.log('== 1. initialize ==')
  const init = await client.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  ok(init.result && init.result.serverInfo && init.result.serverInfo.name === 'hyperpower', 'serverInfo.name === hyperpower')
  ok(init.result && init.result.protocolVersion === '2024-11-05', 'protocolVersion === 2024-11-05')
  ok(init.result && init.result.capabilities && init.result.capabilities.tools, 'capabilities.tools present')
  await client.send('notifications/initialized', {}, true)

  console.log('== 2. tools/list ==')
  const list = await client.send('tools/list', {})
  const tools = (list.result && list.result.tools) || []
  ok(tools.length >= 9, 'has >= 9 tools (got ' + tools.length + ')')
  const names = tools.map((t) => t.name)
  const expected = ['delegate_to_codex', 'delegate_to_claude', 'get_task_result', 'wait_for_tasks', 'list_tasks', 'cross_review', 'claim_files', 'release_files', 'list_claims', 'record_task', 'read_run']
  ok(expected.every((n) => names.includes(n)), 'all expected tool names present')
  ok(tools.every((t) => t.inputSchema && t.inputSchema.type === 'object' && typeof t.inputSchema.properties === 'object'), 'every tool has a valid object inputSchema')

  console.log('== 3. claim_files conflict ==')
  const cA = await client.send('tools/call', { name: 'claim_files', arguments: { owner: 'a', files: ['x.ts'] } })
  const rA = JSON.parse(cA.result.content[0].text)
  ok(rA.granted && rA.granted.length === 1 && rA.conflicts.length === 0, 'owner a granted x.ts')
  const cB = await client.send('tools/call', { name: 'claim_files', arguments: { owner: 'b', files: ['x.ts'] } })
  const rB = JSON.parse(cB.result.content[0].text)
  ok(rB.conflicts && rB.conflicts.length === 1 && rB.conflicts[0].owner === 'a', 'owner b reports conflict owned by a')

  console.log('== 4. delegate_to_codex (async) -> PONG ==')
  if (!hasCodex) {
    console.log('  SKIP: codex not installed in this environment')
  } else {
    const del = await client.send('tools/call', { name: 'delegate_to_codex', arguments: { prompt: 'reply with exactly: PONG' } })
    const dRec = JSON.parse(del.result.content[0].text)
    if (dRec.error === 'codex-not-installed') {
      console.log('  SKIP: server reports codex-not-installed')
    } else {
      ok(dRec.taskId && dRec.status === 'running', 'delegate returned taskId with status running')

      // Poll get_task_result until done/error or ~120s.
      let final = null
      const deadline = Date.now() + 120000
      while (Date.now() < deadline) {
        const g = await client.send('tools/call', { name: 'get_task_result', arguments: { taskId: dRec.taskId } })
        const rec = JSON.parse(g.result.content[0].text)
        if (rec.status !== 'running') { final = rec; break }
        await delay(1500)
      }
      ok(final !== null, 'task reached a terminal state within 120s')
      if (final) {
        console.log('  task status: ' + final.status)
        if (final.error) console.log('  task error: ' + String(final.error).slice(0, 300))
        if (final.result) console.log('  task result (trimmed): ' + String(final.result).slice(0, 200))
        ok(final.status === 'done', 'task status === done')
        ok(final.result && /PONG/.test(final.result), 'result contains PONG')
      }
    }
  }

  console.log('== 4b. delegate_to_claude (async, bidirectional) -> CLAUDEPONG ==')
  if (!hasClaude) {
    console.log('  SKIP: claude not installed in this environment')
  } else {
    const del = await client.send('tools/call', { name: 'delegate_to_claude', arguments: { prompt: 'Reply with exactly: CLAUDEPONG, nothing else.' } })
    const dRec = JSON.parse(del.result.content[0].text)
    if (dRec.error === 'claude-not-installed') {
      console.log('  SKIP: server reports claude-not-installed')
    } else {
      ok(dRec.taskId && dRec.status === 'running', 'delegate_to_claude returned taskId with status running')

      // Wait (up to 180s) for the task to finish, then read its final record.
      const w = await client.send('tools/call', { name: 'wait_for_tasks', arguments: { taskIds: [dRec.taskId], timeoutMs: 180000 } })
      JSON.parse(w.result.content[0].text) // ensure wait_for_tasks returns valid records
      const g = await client.send('tools/call', { name: 'get_task_result', arguments: { taskId: dRec.taskId } })
      const final = JSON.parse(g.result.content[0].text)
      console.log('  claude task status: ' + final.status)
      if (final.error) console.log('  claude task error: ' + String(final.error).slice(0, 300))
      if (final.result) console.log('  claude task result (trimmed): ' + String(final.result).slice(0, 200))
      ok(final.status === 'done', 'claude task status === done')
      ok(final.result && /CLAUDEPONG/.test(final.result), 'claude result contains CLAUDEPONG')
    }
  }

  console.log('== 5. clean shutdown ==')
  child.stdin.end()
  const closed = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000)
    child.on('close', () => { clearTimeout(t); resolve(true) })
  })
  ok(closed, 'server exited cleanly on stdin end')

  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch {}

  console.log('')
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('TEST HARNESS ERROR:', e); process.exit(2) })
