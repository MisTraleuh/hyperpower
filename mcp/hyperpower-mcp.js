#!/usr/bin/env node
'use strict'
/*
 * hyperpower-mcp.js — dependency-free MCP (Model Context Protocol) stdio server.
 *
 * Gives hyperpower the ASYNC multi-agent coordination AgentMesh has: Claude
 * delegates work to Codex in the BACKGROUND, keeps working, and collects the
 * result later. Pure Node — JSON-RPC 2.0 implemented by hand over stdio using
 * LSP-style `Content-Length:` framing (the MCP stdio standard).
 *
 * Tools:
 *   delegate_to_codex   async — spawn a detached `codex exec`, return {taskId}
 *   get_task_result     read a task record from disk
 *   wait_for_tasks      async-poll until tasks done/error or timeout
 *   list_tasks          all task records for this run
 *   cross_review        async — codex reviews `work` vs `against`
 *   claim_files         atomic file-claim registry (via hpw-claims)
 *   release_files       release claims
 *   list_claims         dump the claim table
 *   record_task         append a structured task record to run.json
 *   read_run            read the structured run state
 *
 * Storage: ~/.hyperpower/<runId>/tasks/<taskId>.json  (root() from hpw-claims)
 *   each: {taskId, kind, status, prompt, model, result, error, startedAt, finishedAt, pid}
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const crypto = require('crypto')

const claims = require(path.join(__dirname, '..', 'bin', 'hpw-claims.js'))

// ---------------------------------------------------------------------------
// Run identity + storage
// ---------------------------------------------------------------------------
const RUN_ID = process.env.HYPERPOWER_RUN || ('mcp-' + process.pid)

function tasksDir() {
  const d = path.join(claims.root(RUN_ID), 'tasks')
  fs.mkdirSync(d, { recursive: true })
  return d
}
function taskFile(taskId) { return path.join(tasksDir(), taskId + '.json') }

function writeJsonAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, file)
}
function readTask(taskId) {
  try { return JSON.parse(fs.readFileSync(taskFile(taskId), 'utf8')) } catch { return null }
}
function listTaskRecords() {
  const out = []
  let names = []
  try { names = fs.readdirSync(tasksDir()) } catch { return out }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try { out.push(JSON.parse(fs.readFileSync(path.join(tasksDir(), n), 'utf8'))) } catch {}
  }
  return out
}

function newTaskId() {
  return 't_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex')
}
function nowIso() { try { return new Date().toISOString() } catch { return null } }

function codexPath() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8' })
  if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0]
  return null
}

// ---------------------------------------------------------------------------
// Background codex runner.
//
// We can't keep a child handle around (the server may answer many requests and
// the parent shouldn't block), so we spawn a tiny detached Node wrapper that:
//   1. runs `codex exec ... -o <outfile>` with the prompt on stdin (a temp file),
//   2. on exit, atomically writes status:done+result (or status:error) into the
//      task json.
// The wrapper is generated to a temp file and executed with `node`.
// ---------------------------------------------------------------------------
const RUNNER_SRC = `
'use strict'
const fs = require('fs')
const { spawn } = require('child_process')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
// cfg: { taskFile, outFile, inFile, codex, model, kind }

function readTask() { try { return JSON.parse(fs.readFileSync(cfg.taskFile, 'utf8')) } catch { return {} } }
function writeTask(patch) {
  const cur = readTask()
  const next = Object.assign({}, cur, patch)
  const tmp = cfg.taskFile + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, cfg.taskFile)
}

const args = [
  'exec',
  '--skip-git-repo-check',
  '--sandbox', 'read-only',
  '--ephemeral',
  '--color', 'never',
  '-m', cfg.model,
  '-o', cfg.outFile,
  '-',                       // read prompt from stdin
]

const input = fs.createReadStream(cfg.inFile)
const child = spawn(cfg.codex, args, { stdio: ['pipe', 'pipe', 'pipe'] })
input.pipe(child.stdin)

let stderr = ''
let stdout = ''
child.stdout.on('data', (d) => { stdout += d.toString() })
child.stderr.on('data', (d) => { stderr += d.toString() })

child.on('error', (err) => {
  writeTask({ status: 'error', error: 'spawn-failed: ' + err.message, finishedAt: new Date().toISOString() })
  process.exit(0)
})

child.on('close', (code) => {
  let result = null
  try { result = fs.readFileSync(cfg.outFile, 'utf8') } catch {}
  if (result == null || result.trim() === '') {
    // fall back to captured stdout if -o produced nothing
    result = stdout
  }
  result = (result || '').trim()
  try { fs.unlinkSync(cfg.inFile) } catch {}
  try { fs.unlinkSync(cfg.outFile) } catch {}
  if (code === 0) {
    writeTask({ status: 'done', result: result, finishedAt: new Date().toISOString() })
  } else {
    writeTask({ status: 'error', error: 'codex exited ' + code + (stderr ? (': ' + stderr.trim().slice(-2000)) : ''), result: result || null, finishedAt: new Date().toISOString() })
  }
  process.exit(0)
})
`

function spawnCodexTask(kind, prompt, model) {
  const codex = codexPath()
  if (!codex) return { error: 'codex-not-installed' }

  const taskId = newTaskId()
  const tf = taskFile(taskId)
  const dir = tasksDir()
  const outFile = path.join(dir, taskId + '.out')
  const inFile = path.join(dir, taskId + '.in')
  const runnerFile = path.join(dir, taskId + '.runner.js')
  const cfgFile = path.join(dir, taskId + '.cfg.json')
  const usedModel = model || 'gpt-5.5'

  fs.writeFileSync(inFile, String(prompt))

  // Seed the task record as running.
  writeJsonAtomic(tf, {
    taskId,
    kind,
    status: 'running',
    prompt: String(prompt),
    model: usedModel,
    result: null,
    error: null,
    startedAt: nowIso(),
    finishedAt: null,
    pid: null,
  })

  fs.writeFileSync(runnerFile, RUNNER_SRC)
  fs.writeFileSync(cfgFile, JSON.stringify({
    taskFile: tf, outFile, inFile, codex, model: usedModel, kind,
  }))

  const child = spawn(process.execPath, [runnerFile, cfgFile], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  // Record the pid (best effort).
  const rec = readTask(taskId)
  if (rec) { rec.pid = child.pid; writeJsonAtomic(tf, rec) }

  return { taskId, status: 'running' }
}

// ---------------------------------------------------------------------------
// Tool definitions + dispatch
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'delegate_to_codex',
    description: 'Delegate a task to Codex asynchronously in the background. Returns immediately with a taskId; poll get_task_result or wait_for_tasks to collect the result.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full instruction/prompt for Codex.' },
        model: { type: 'string', description: 'Optional model id (default gpt-5.5).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'cross_review',
    description: 'Ask Codex (async) to critically review `work` against `against` (e.g. a spec, requirements, or another implementation). Returns a taskId.',
    inputSchema: {
      type: 'object',
      properties: {
        work: { type: 'string', description: 'The work product to review.' },
        against: { type: 'string', description: 'The spec/baseline to review it against.' },
      },
      required: ['work', 'against'],
    },
  },
  {
    name: 'get_task_result',
    description: 'Read the current record for an async task: status running|done|error plus result/error and timestamps.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
  {
    name: 'wait_for_tasks',
    description: 'Asynchronously poll until all given tasks are done/error or timeout elapses (default 120000ms). Returns the array of task records.',
    inputSchema: {
      type: 'object',
      properties: {
        taskIds: { type: 'array', items: { type: 'string' } },
        timeoutMs: { type: 'number', description: 'Max time to wait, default 120000.' },
      },
      required: ['taskIds'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all task records for this server run.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'claim_files',
    description: 'Atomically claim a set of files for an owner so parallel agents do not clobber each other. Returns granted + conflicts.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['owner', 'files'],
    },
  },
  {
    name: 'release_files',
    description: 'Release some or all of an owner\'s file claims. Omit files to release everything owned.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['owner'],
    },
  },
  {
    name: 'list_claims',
    description: 'Return the live file-claim table for this run.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'record_task',
    description: 'Append a structured task record (agent/role/result) to the persistent run state (run.json).',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        role: { type: 'string' },
        result: { type: 'string' },
      },
      required: ['agent', 'role', 'result'],
    },
  },
  {
    name: 'read_run',
    description: 'Read the persistent structured run state (run.json) for this run.',
    inputSchema: { type: 'object', properties: {} },
  },
]

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function waitForTasks(taskIds, timeoutMs) {
  const deadline = Date.now() + (typeof timeoutMs === 'number' ? timeoutMs : 120000)
  const ids = Array.isArray(taskIds) ? taskIds : []
  for (;;) {
    const recs = ids.map((id) => readTask(id) || { taskId: id, status: 'error', error: 'no-such-task' })
    const pending = recs.filter((r) => r.status === 'running')
    if (pending.length === 0 || Date.now() >= deadline) return recs
    await wait(250)
  }
}

async function callTool(name, args) {
  args = args || {}
  switch (name) {
    case 'delegate_to_codex':
      return spawnCodexTask('delegate', args.prompt, args.model)

    case 'cross_review': {
      const prompt =
        'You are a rigorous reviewer. Review the WORK below against the AGAINST baseline. ' +
        'List concrete issues, gaps, and risks, then give a verdict.\n\n' +
        '=== WORK ===\n' + String(args.work) + '\n\n' +
        '=== AGAINST ===\n' + String(args.against) + '\n'
      return spawnCodexTask('cross_review', prompt, args.model)
    }

    case 'get_task_result': {
      const rec = readTask(args.taskId)
      if (!rec) return { taskId: args.taskId, status: 'error', error: 'no-such-task' }
      return {
        taskId: rec.taskId,
        status: rec.status,
        result: rec.result,
        error: rec.error,
        startedAt: rec.startedAt,
        finishedAt: rec.finishedAt,
      }
    }

    case 'wait_for_tasks':
      return await waitForTasks(args.taskIds, args.timeoutMs)

    case 'list_tasks':
      return listTaskRecords()

    case 'claim_files':
      return claims.claimFiles(RUN_ID, args.owner, args.files || [], { now: claims.nowStamp() })

    case 'release_files':
      return claims.releaseFiles(RUN_ID, args.owner, args.files || null)

    case 'list_claims':
      return claims.listClaims(RUN_ID)

    case 'record_task': {
      const n = claims.recordTask(RUN_ID, {
        agent: args.agent, role: args.role, result: args.result, ts: claims.nowStamp(),
      })
      return { recorded: n }
    }

    case 'read_run':
      return claims.readRun(RUN_ID)

    default:
      throw { code: -32602, message: 'unknown tool: ' + name }
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 method dispatch
// ---------------------------------------------------------------------------
async function handleRequest(msg) {
  const { id, method, params } = msg

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'hyperpower', version: '0.1.0' },
    })
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    return null // notification: no response
  }

  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS })
  }

  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    try {
      const result = await callTool(name, args)
      const text = typeof result === 'string' ? result : JSON.stringify(result)
      return ok(id, { content: [{ type: 'text', text }] })
    } catch (e) {
      const code = (e && e.code) || -32603
      const message = (e && e.message) || String(e)
      return err(id, code, message)
    }
  }

  if (method === 'ping') {
    return ok(id, {})
  }

  // Other notifications (no id) get silently ignored.
  if (id === undefined || id === null) return null

  return err(id, -32601, 'Method not found: ' + method)
}

function ok(id, result) { return { jsonrpc: '2.0', id, result } }
function err(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } } }

// ---------------------------------------------------------------------------
// Content-Length framed transport over stdio
//
// Each message: `Content-Length: <bytes>\r\n\r\n<utf8 json payload>`.
// We buffer raw bytes (Buffer), parse a header block once \r\n\r\n is present,
// then wait for exactly <bytes> UTF-8 bytes of body before dispatching.
// ---------------------------------------------------------------------------
function send(obj) {
  const json = JSON.stringify(obj)
  const body = Buffer.from(json, 'utf8')
  const header = Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii')
  process.stdout.write(Buffer.concat([header, body]))
}

let buf = Buffer.alloc(0)

function pump() {
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n')
    if (sep === -1) return // need more header bytes
    const header = buf.slice(0, sep).toString('ascii')
    let len = -1
    for (const line of header.split('\r\n')) {
      const m = /^content-length:\s*(\d+)\s*$/i.exec(line)
      if (m) len = parseInt(m[1], 10)
    }
    if (len < 0) {
      // malformed header block: drop it and keep going
      buf = buf.slice(sep + 4)
      continue
    }
    const bodyStart = sep + 4
    if (buf.length - bodyStart < len) return // need more body bytes
    const body = buf.slice(bodyStart, bodyStart + len)
    buf = buf.slice(bodyStart + len)

    let msg
    try { msg = JSON.parse(body.toString('utf8')) } catch {
      send(err(null, -32700, 'Parse error'))
      continue
    }
    dispatch(msg)
  }
}

function dispatch(msg) {
  Promise.resolve()
    .then(() => handleRequest(msg))
    .then((res) => { if (res) send(res) })
    .catch((e) => {
      const id = (msg && msg.id !== undefined) ? msg.id : null
      send(err(id, -32603, (e && e.message) || String(e)))
    })
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  pump()
})
process.stdin.on('end', () => { process.exit(0) })
process.stdin.resume()

// keep the process alive on stdin
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
