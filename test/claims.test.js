'use strict'
// Atomic file-claim registry + persistent run state tests.
const path = require('path')
const fs = require('fs')
const C = require(path.join(__dirname, '..', 'bin', 'hpw-claims.js'))
let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✔', n) } else { fail++; console.log('  ✗ FAIL', n) } }
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

fs.rmSync(C.root(RID), { recursive: true, force: true })
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
