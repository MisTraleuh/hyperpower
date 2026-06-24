'use strict'
const assert = require('assert')
const { Screen, findNodeRows, planInjections, stripSgr } =
  require(require('path').join(__dirname,'..','bin','hpw-screen.js'))

const ESC = '\x1b'
const cup = (r, c) => `${ESC}[${r};${c}H`
const sgr = (n) => `${ESC}[${n}m`
let pass = 0, fail = 0
function ok(name, cond) { if (cond) { pass++; console.log('  ✔', name) } else { fail++; console.log('  �’✗ FAIL', name) } }

// --- Frame 1: a realistic cursor-addressed claude /workflows table ----------
// Built the way the native TUI does it: home, clear, then position each row and
// write it with SGR color noise interleaved.
const s = new Screen(40, 160)
s.write(`${ESC}[H${ESC}[2J`)
s.write(cup(1, 2) + sgr(1) + 'hyperpower-debate' + sgr(0))
s.write(cup(2, 4) + 'Plan')
// node row 3: icon, label, model, big gap, tokens — with color codes sprinkled in
s.write(cup(3, 5) + sgr(36) + '⏺ (claude) draft-plan' + sgr(0) +
        cup(3, 32) + sgr(2) + 'Opus 4.8 (1M context)' + sgr(0) +
        cup(3, 120) + '9.4k tok')
s.write(cup(4, 4) + 'Debate')
// node row 5: codex, running
s.write(cup(5, 5) + sgr(35) + '⏺ (codex · gpt-5.5) critique r1' + sgr(0) +
        cup(5, 40) + 'Sonnet 4.6' + cup(5, 120) + 'running…')
// node row 6: queued
s.write(cup(6, 5) + '○ (claude) build' + cup(6, 32) + 'Opus 4.8 (1M context)' + cup(6, 124) + 'queued')
// a NON-node row that must be ignored
s.write(cup(7, 4) + 'just a status line, no node here, 12 tokens used')

const rows = findNodeRows(s)
ok('finds exactly 3 node rows', rows.length === 3)
ok('row indices are 3,5,6', rows.map(r => r.row).join(',') === '2,4,5') // 0-based

// gap for row 3 must be BETWEEN the model "(1M context)" and "9.4k tok"
const r3 = rows.find(r => r.row === 2)
const before = stripSgr(r3.text.slice(0, r3.gapStart)).trimEnd()
const after = r3.text.slice(r3.gapEnd)
ok('row3 gap is after the model', before.endsWith('(1M context)'))
ok('row3 right field is the token count', after.startsWith('9.4k tok'))
ok('row3 gap is wide', r3.gapWidth > 40)

// --- injection planning -----------------------------------------------------
const BAR = '[▰▰▰▱▱]'
const inj = planInjections(s, () => BAR)
ok('plans 3 injections (all gaps wide enough)', inj.length === 3)
const i3 = inj.find(x => x.row === 2)
ok('row3 injection col sits inside the gap', i3.col >= r3.gapStart + 1 && i3.col + BAR.length <= r3.gapEnd - 1)

// apply the injection to a copy of the row and check we did not overwrite model/tokens
const grid = s.grid[2].slice()
for (let k = 0; k < BAR.length; k++) grid[i3.col + k] = BAR[k]
const painted = grid.join('').replace(/\s+$/, '')
ok('after paint, model text intact', painted.includes('Opus 4.8 (1M context)'))
ok('after paint, token text intact', painted.includes('9.4k tok'))
ok('after paint, bar present between them',
   painted.indexOf('Opus 4.8 (1M context)') < painted.indexOf(BAR) &&
   painted.indexOf(BAR) < painted.indexOf('9.4k tok'))

// --- narrow-gap safety: a row whose gap can't fit the bar must be skipped ----
const s2 = new Screen(10, 60)
s2.write(cup(1, 1) + '⏺ (claude) x' + cup(1, 20) + 'M' + cup(1, 24) + '9k tok')
const inj2 = planInjections(s2, () => '[▰▰▰▰▰▰▰▰▰▰]')
ok('skips injection when gap too small (no layout break)', inj2.length === 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
