'use strict'
// Atomic file-claim registry + persistent run state tests.
const path = require('path')
const fs = require('fs')
const os = require('os')
const cp = require('child_process')
const C = require(path.join(__dirname, '..', 'bin', 'hpw-claims.js'))
let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✔', n) } else { fail++; console.log('  ✗ FAIL', n) } }

// Hermetic isolation: root() reads HYPERPOWER_HOME at call time, so pointing it at a
// fresh temp dir BEFORE any C.* call routes every claim/release/record/readRun under
// tmpHome, never the real ~/.hyperpower. The exit handler fires on normal exit, on a
// thrown error, AND on the trailing process.exit(fail?1:0) — guaranteed single cleanup.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hpw-test-'))
process.env.HYPERPOWER_HOME = tmpHome
process.on('exit', () => { try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {} })

const RID = 'unittest-' + process.pid

const r = C.claimFiles(RID, 'claude', ['src/a.ts', 'src/b.ts'])
ok('claude grants 2 files', r.granted.length === 2 && r.conflicts.length === 0)
const r2 = C.claimFiles(RID, 'codex', ['src/a.ts', 'src/c.ts'])
ok('codex conflicts on a.ts, owner=claude', r2.conflicts.length === 1 && r2.conflicts[0].owner === 'claude')
ok('codex still gets c.ts', r2.granted.some(p => p.endsWith('c.ts')))
ok('re-claim own file = ok', C.claimFiles(RID, 'claude', ['src/a.ts']).conflicts.length === 0)
C.releaseFiles(RID, 'claude', ['src/a.ts'])
ok('after release codex can take a.ts', C.claimFiles(RID, 'codex', ['src/a.ts']).granted.length === 1)
C.recordTask(RID, { agent: 'claude', role: 'build', ts: '2026-06-25T00:00:00Z', result: 'ok' })
const run = C.readRun(RID)
ok('run.json persisted task', run && run.tasks.length === 1 && run.tasks[0].agent === 'claude')

const bin = path.join(__dirname, '..', 'bin', 'hpw-claims.js')
const expected = require(path.join(__dirname, '..', '.claude-plugin', 'plugin.json')).version
const childEnv = { ...process.env, HYPERPOWER_HOME: tmpHome }

// version: plain text, stdout EXACTLY `<version>\n` (no trim — we lock the raw bytes)
const vOut = cp.execFileSync(process.execPath, [bin, 'version'], { encoding: 'utf8', env: childEnv })
ok('version subcommand prints exactly plugin.json version + newline', vOut === expected + '\n')

// version policy: trailing args are intentionally ignored (see 1.2 dispatcher comment)
const vExtra = cp.execFileSync(process.execPath, [bin, 'version', 'extra'], { encoding: 'utf8', env: childEnv })
ok('version ignores trailing args (documented CLI policy)', vExtra === expected + '\n')

// empty-list: MUST use a run id that no earlier step ever claimed, so the table is
// genuinely empty. RID was claimed/re-claimed above (a.ts/b.ts/c.ts survive), so
// `list RID` would return 3 entries, NOT {}. Use a fresh, never-touched id under tmpHome.
const EMPTY_RID = 'empty-' + process.pid
const listOut = cp.execFileSync(process.execPath, [bin, 'list', EMPTY_RID], { encoding: 'utf8', env: childEnv }).trim()
ok('list on a never-claimed run id (isolated home) returns {}', listOut === '{}')

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
