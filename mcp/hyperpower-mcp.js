#!/usr/bin/env node
'use strict'
/*
 * hyperpower-mcp.js — dependency-free MCP (Model Context Protocol) stdio server.
 *
 * Gives hyperpower the ASYNC multi-agent coordination AgentMesh has: Claude
 * delegates work to Codex in the BACKGROUND, keeps working, and collects the
 * result later. Pure Node — JSON-RPC 2.0 implemented by hand over stdio using
 * Newline-delimited JSON framing (the MCP stdio standard).
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

function binPath(name) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' })
  if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0]
  return null
}
function codexPath() { return binPath('codex') }
function claudePath() { return binPath('claude') }

// ---------------------------------------------------------------------------
// Generic background runner.
//
// We can't keep a child handle around (the server may answer many requests and
// the parent shouldn't block), so we spawn a tiny detached Node wrapper that:
//   1. runs <cmd> <args...>, feeding the prompt over stdin (from inFile),
//   2. on exit, atomically writes status:done+result (or status:error) into the
//      task json.
// The result text is read from outFile (e.g. codex `-o`) if `outFile` is set,
// otherwise from captured stdout (e.g. claude `-p ... --output-format text`).
// The wrapper is generated to a temp file and executed with `node`.
//
// cfg: { taskFile, cmd, args, inFile, outFile|null, label }
// ---------------------------------------------------------------------------
const RUNNER_SRC = `
'use strict'
const fs = require('fs')
const { spawn } = require('child_process')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))

function readTask() { try { return JSON.parse(fs.readFileSync(cfg.taskFile, 'utf8')) } catch { return {} } }
function writeTask(patch) {
  const cur = readTask()
  const next = Object.assign({}, cur, patch)
  const tmp = cfg.taskFile + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, cfg.taskFile)
}

const input = fs.createReadStream(cfg.inFile)
const child = spawn(cfg.cmd, cfg.args, { stdio: ['pipe', 'pipe', 'pipe'] })
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
  if (cfg.outFile) {
    try { result = fs.readFileSync(cfg.outFile, 'utf8') } catch {}
  }
  if (result == null || result.trim() === '') {
    // fall back to captured stdout if outFile is unset or produced nothing
    result = stdout
  }
  result = (result || '').trim()
  try { fs.unlinkSync(cfg.inFile) } catch {}
  if (cfg.outFile) { try { fs.unlinkSync(cfg.outFile) } catch {} }
  if (code === 0) {
    writeTask({ status: 'done', result: result, finishedAt: new Date().toISOString() })
  } else {
    writeTask({ status: 'error', error: (cfg.label || cfg.cmd) + ' exited ' + code + (stderr ? (': ' + stderr.trim().slice(-2000)) : ''), result: result || null, finishedAt: new Date().toISOString() })
  }
  process.exit(0)
})
`

// Generic spawner: builds the task record, writes the prompt to a temp inFile,
// drops the runner + cfg, and launches the detached node wrapper.
function spawnBgTask({ kind, prompt, model, cmd, args, outFile, label }) {
  const taskId = newTaskId()
  const tf = taskFile(taskId)
  const dir = tasksDir()
  const inFile = path.join(dir, taskId + '.in')
  const runnerFile = path.join(dir, taskId + '.runner.js')
  const cfgFile = path.join(dir, taskId + '.cfg.json')

  fs.writeFileSync(inFile, String(prompt))

  // Seed the task record as running.
  writeJsonAtomic(tf, {
    taskId,
    kind,
    status: 'running',
    prompt: String(prompt),
    model: model || null,
    result: null,
    error: null,
    startedAt: nowIso(),
    finishedAt: null,
    pid: null,
  })

  fs.writeFileSync(runnerFile, RUNNER_SRC)
  fs.writeFileSync(cfgFile, JSON.stringify({
    taskFile: tf, cmd, args, inFile, outFile: outFile || null, label: label || cmd,
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

// Delegate to Codex: `codex exec ... -o <outfile> -` (prompt on stdin).
function spawnCodexTask(kind, prompt, model) {
  const codex = codexPath()
  if (!codex) return { error: 'codex-not-installed' }

  const dir = tasksDir()
  const usedModel = model || 'gpt-5.5'
  const outFile = path.join(dir, newTaskId() + '.out')

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--ephemeral',
    '--color', 'never',
    '-m', usedModel,
    '-o', outFile,
    '-',                       // read prompt from stdin
  ]

  return spawnBgTask({
    kind, prompt, model: usedModel, cmd: codex, args, outFile, label: 'codex',
  })
}

// Delegate to Claude: `claude -p --output-format text --permission-mode plan`
// (prompt on stdin). Read-only / advisory posture: no --dangerously-skip-permissions.
function spawnClaudeTask(kind, prompt, model) {
  const claude = claudePath()
  if (!claude) return { error: 'claude-not-installed' }

  const args = [
    '-p',                       // print mode (headless, non-interactive)
    '--output-format', 'text',
    '--permission-mode', 'plan', // read-only / planning posture: cannot edit
  ]
  if (model) { args.push('--model', model) }

  // Wrap with an explicit read-only advisory instruction so the delegation
  // stays analysis/review only even if permission-mode plan is loosened.
  const wrapped =
    'You are an advisory sub-agent invoked in read-only mode. ' +
    'Perform analysis/review only. Do NOT edit, create, or delete any files; ' +
    'do NOT run state-changing commands. Respond with your answer directly.\n\n' +
    String(prompt)

  return spawnBgTask({
    kind, prompt: wrapped, model: model || null, cmd: claude, args, outFile: null, label: 'claude',
  })
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
    name: 'delegate_to_claude',
    description: 'Delegate a task to Claude asynchronously in the background (the mirror of delegate_to_codex; use this from the Codex CLI to hand work to Claude). Runs Claude headless in a read-only / advisory posture (analysis & review only — it will not edit files). Returns immediately with a taskId; poll get_task_result or wait_for_tasks to collect the result.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full instruction/prompt for Claude.' },
        model: { type: 'string', description: 'Optional model id/alias (e.g. sonnet, opus). Defaults to the Claude CLI default.' },
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
      return spawnCodexTask('codex', args.prompt, args.model)

    case 'delegate_to_claude':
      return spawnClaudeTask('claude', args.prompt, args.model)

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
    // Echo the client's requested protocol version so strict/newer clients (e.g.
    // recent Claude Code) accept the handshake instead of failing to connect.
    const wanted = (params && typeof params.protocolVersion === 'string')
      ? params.protocolVersion : '2024-11-05'
    return ok(id, {
      protocolVersion: wanted,
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
// Newline-delimited JSON transport over stdio — the MCP stdio standard.
//
// Per the MCP spec, stdio messages are JSON objects DELIMITED BY NEWLINES and must
// not contain embedded newlines. (Claude Code's client sends exactly this — NOT
// LSP-style `Content-Length:` framing.) We write `JSON.stringify(msg) + "\n"`, and
// read line-by-line. For robustness we ALSO accept legacy Content-Length frames if
// a client happens to send them.
// ---------------------------------------------------------------------------
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

let buf = Buffer.alloc(0)

function pump() {
  for (;;) {
    // Legacy Content-Length frame? (only if the buffer literally starts with it)
    if (/^content-length:/i.test(buf.slice(0, 16).toString('ascii'))) {
      const sep = buf.indexOf('\r\n\r\n')
      if (sep === -1) return
      const header = buf.slice(0, sep).toString('ascii')
      let len = -1
      for (const line of header.split('\r\n')) {
        const m = /^content-length:\s*(\d+)\s*$/i.exec(line)
        if (m) len = parseInt(m[1], 10)
      }
      const bodyStart = sep + 4
      if (len < 0) { buf = buf.slice(bodyStart); continue }
      if (buf.length - bodyStart < len) return
      const body = buf.slice(bodyStart, bodyStart + len)
      buf = buf.slice(bodyStart + len)
      parseAndDispatch(body)
      continue
    }
    // Newline-delimited JSON (the normal path).
    const nl = buf.indexOf(0x0a) // '\n'
    if (nl === -1) return // need a full line
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    const trimmed = line.toString('utf8').trim()
    if (trimmed) parseAndDispatch(Buffer.from(trimmed, 'utf8'))
  }
}

function parseAndDispatch(body) {
  let msg
  try { msg = JSON.parse(body.toString('utf8')) } catch {
    send(err(null, -32700, 'Parse error'))
    return
  }
  dispatch(msg)
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
