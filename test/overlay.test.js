'use strict'
const HP = require('path').join(__dirname,'..','bin','hpw-screen.js')
const { Screen, rowState, makeBar, planOverlay, stripSgr } = require(HP)
const ESC = '\x1b'
const cup = (r, c) => `${ESC}[${r};${c}H`
const sgr = (n) => `${ESC}[${n}m`
let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✔', n) } else { fail++; console.log('  ✗ FAIL', n) } }

// --- rowState -------------------------------------------------------------
ok('done via ✔', rowState('✔ (claude) build  Opus 4.8  10k tok · 41s') === 'done')
ok('running via ⏺', rowState('⏺ (claude) build  Opus 4.8  running…') === 'running')
ok('running via spinner', rowState('⠙ (claude) build  Opus 4.8  running') === 'running')
ok('queued via ○', rowState('○ (codex · gpt-5.5) review   queued') === 'queued')
ok('done via token count (no marker)', rowState('(claude) x  Opus 4.8   9.4k tok') === 'done')
ok('non-node-ish returns null', rowState('just a plain status line') === null)

// --- makeBar --------------------------------------------------------------
ok('done bar full', makeBar('done', 0, 5) === '[▰▰▰▰▰]')
ok('queued bar empty', makeBar('queued', 0, 5) === '[▱▱▱▱▱]')
const b1 = makeBar('running', 0, 5), b2 = makeBar('running', 3, 5)
ok('running bar animates between frames', b1 !== b2 && b1.length === 7 && b2.length === 7)

// --- planOverlay on a realistic cursor-addressed frame --------------------
const s = new Screen(40, 160)
s.write(`${ESC}[H${ESC}[2J`)
s.write(cup(3, 5) + sgr(36) + '✔ (claude) draft-plan' + sgr(0) +
        cup(3, 32) + 'Opus 4.8 (1M context)' + cup(3, 120) + '9.4k tok · 41s')
s.write(cup(5, 5) + '⏺ (codex · gpt-5.5) critique r1' + cup(5, 40) + 'Sonnet 4.6' + cup(5, 120) + 'running…')
s.write(cup(6, 5) + '○ (claude) build' + cup(6, 32) + 'Opus 4.8 (1M context)' + cup(6, 124) + 'queued')

const overlay = planOverlay(s, 0)
ok('overlay is non-empty', overlay.length > 0)
ok('overlay saves & restores cursor (DECSC/DECRC)', overlay.startsWith(ESC + '7') && overlay.endsWith(ESC + '8'))
ok('overlay positions on rows 3,5,6 (1-based)',
   /\x1b\[3;\d+H/.test(overlay) && /\x1b\[5;\d+H/.test(overlay) && /\x1b\[6;\d+H/.test(overlay))
ok('done row painted green + full bar', /\x1b\[3;\d+H\x1b\[32m\[▰▰▰▰▰\]/.test(overlay))
ok('running row painted cyan', /\x1b\[5;\d+H\x1b\[36m\[/.test(overlay))
ok('queued row painted dim + empty bar', /\x1b\[6;\d+H\x1b\[90m\[▱▱▱▱▱\]/.test(overlay))

// the painted column for row 3 must land strictly inside the gap (after model,
// before tokens). Extract it and check against the reconstructed row.
const m = overlay.match(/\x1b\[3;(\d+)H/)
const col0 = parseInt(m[1], 10) - 1
const text = s.rowText(2)
const modelEnd = stripSgr(text).indexOf('(1M context)') + '(1M context)'.length
const tokStart = text.indexOf('9.4k tok')
ok('row3 bar column is between model end and token start',
   col0 > modelEnd && col0 + 7 < tokStart)

// --- frame-advance changes ONLY the running row's bar glyphs --------------
const o0 = planOverlay(s, 0), o1 = planOverlay(s, 2)
const stripPos = (x) => x.replace(/\x1b\[\d+;\d+H/g, '')
ok('successive frames differ (running animates)', stripPos(o0) !== stripPos(o1))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
