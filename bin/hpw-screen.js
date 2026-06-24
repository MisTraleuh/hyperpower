'use strict'
/*
 * hpw-screen.js — the testable core of the hyperpower terminal interceptor.
 *
 * Claude Code's /workflows table is drawn by its native binary into the terminal
 * with CURSOR-ADDRESSED writes (move cursor, write text, move again) — not clean
 * lines. To inject a per-agent progress bar into a node row WITHOUT patching the
 * binary, we sit on the output stream, reconstruct the visible screen, find the
 * node rows, locate the gap between the model name and the token field, and emit
 * cursor-positioned writes to paint a bar into that gap.
 *
 * This module is the PURE, dependency-free, unit-testable part: a minimal ANSI
 * screen model + node-row detection + injection planning. The PTY plumbing that
 * feeds it lives in bin/hyperpower-tui (the integration layer).
 *
 * Exports: Screen, findNodeRows, planInjections, stripSgr.
 */

const ESC = '\x1b'

// Strip SGR (color) sequences so text matching works on the visible characters.
function stripSgr(s) { return s.replace(/\x1b\[[0-9;]*m/g, '') }

// ---------------------------------------------------------------------------
// Minimal ANSI screen model. Supports the subset Claude's TUI actually uses to
// place table rows: CUP (cursor position), CUU/CUD/CUF/CUB (moves), ED (erase
// display), EL (erase line), CR, LF, and printable text. SGR is consumed and
// ignored. Wide/combining glyphs are treated as width 1 (documented limitation).
class Screen {
  constructor(rows = 50, cols = 200) {
    this.rows = rows
    this.cols = cols
    this.grid = Array.from({ length: rows }, () => new Array(cols).fill(' '))
    this.cr = 0 // cursor row (0-based)
    this.cc = 0 // cursor col (0-based)
  }

  _clamp() {
    if (this.cr < 0) this.cr = 0
    if (this.cr >= this.rows) this.cr = this.rows - 1
    if (this.cc < 0) this.cc = 0
    if (this.cc >= this.cols) this.cc = this.cols - 1
  }

  _eraseLineFrom(c) { for (let i = c; i < this.cols; i++) this.grid[this.cr][i] = ' ' }
  _eraseAll() { for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) this.grid[r][c] = ' ' }

  write(chunk) {
    const s = chunk
    let i = 0
    while (i < s.length) {
      const ch = s[i]
      if (ch === ESC && s[i + 1] === '[') {
        // CSI sequence: ESC [ params letter
        let j = i + 2
        let params = ''
        while (j < s.length && /[0-9;?]/.test(s[j])) { params += s[j]; j++ }
        const final = s[j]
        this._csi(final, params)
        i = j + 1
        continue
      }
      if (ch === ESC) {
        // skip a 2-char escape we don't model (e.g. ESC M, ESC =), best-effort
        i += 2
        continue
      }
      if (ch === '\n') { this.cr++; this._clamp(); i++; continue }
      if (ch === '\r') { this.cc = 0; i++; continue }
      if (ch === '\t') { this.cc = Math.min(this.cols - 1, (Math.floor(this.cc / 8) + 1) * 8); i++; continue }
      if (ch === '\b') { this.cc = Math.max(0, this.cc - 1); i++; continue }
      const code = s.charCodeAt(i)
      if (code < 32) { i++; continue } // other control chars: ignore
      // printable
      this.grid[this.cr][this.cc] = ch
      this.cc++
      if (this.cc >= this.cols) { this.cc = this.cols - 1 } // no auto-wrap (TUI repositions)
      i++
    }
    return this
  }

  _csi(final, params) {
    const nums = params.replace(/^\?/, '').split(';').map((x) => (x === '' ? NaN : parseInt(x, 10)))
    const n = (idx, dflt) => (Number.isNaN(nums[idx]) || nums[idx] === undefined ? dflt : nums[idx])
    switch (final) {
      case 'H': case 'f': // CUP row;col (1-based)
        this.cr = n(0, 1) - 1; this.cc = n(1, 1) - 1; this._clamp(); break
      case 'A': this.cr -= n(0, 1); this._clamp(); break
      case 'B': this.cr += n(0, 1); this._clamp(); break
      case 'C': this.cc += n(0, 1); this._clamp(); break
      case 'D': this.cc -= n(0, 1); this._clamp(); break
      case 'G': this.cc = n(0, 1) - 1; this._clamp(); break // CHA column
      case 'd': this.cr = n(0, 1) - 1; this._clamp(); break // VPA row
      case 'J': { // ED
        const m = n(0, 0)
        if (m === 2 || m === 3) this._eraseAll()
        else if (m === 0) { this._eraseLineFrom(this.cc); for (let r = this.cr + 1; r < this.rows; r++) this.grid[r].fill(' ') }
        break
      }
      case 'K': { // EL
        const m = n(0, 0)
        if (m === 0) this._eraseLineFrom(this.cc)
        else if (m === 1) { for (let c = 0; c <= this.cc; c++) this.grid[this.cr][c] = ' ' }
        else if (m === 2) this.grid[this.cr].fill(' ')
        break
      }
      default: break // SGR (m), DECTCEM (h/l), etc.: ignore
    }
  }

  rowText(r) { return this.grid[r].join('').replace(/\s+$/, '') }
  allRows() { const out = []; for (let r = 0; r < this.rows; r++) out.push(this.rowText(r)); return out }
}

// ---------------------------------------------------------------------------
// Node-row detection. A workflow node row contains a "(claude)" / "(codex ...)"
// label and, further right, a status/measurement field (token count, "running…",
// "queued", "done"). The GAP we inject into is the whitespace run immediately
// before that right-hand field.
const LABEL_RE = /\((?:claude|codex)[^)]*\)/
// right-hand field: token count, or a known status word.
const RIGHT_RE = /(\d+(?:\.\d+)?k?\s*tok|running…?|queued|done|error|pending)/

function findNodeRows(screen) {
  const rows = []
  for (let r = 0; r < screen.rows; r++) {
    const text = screen.rowText(r)
    const lab = LABEL_RE.exec(text)
    if (!lab) continue
    const right = RIGHT_RE.exec(text)
    if (!right) continue
    const rightStart = right.index
    if (rightStart <= lab.index + lab[0].length) continue // right field must be to the right of the label
    // gap = run of spaces immediately before the right field.
    let gapStart = rightStart
    while (gapStart > 0 && text[gapStart - 1] === ' ') gapStart--
    const gapWidth = rightStart - gapStart
    rows.push({
      row: r, text,
      labelStart: lab.index, labelEnd: lab.index + lab[0].length,
      gapStart, gapEnd: rightStart, gapWidth,
      rightStart,
    })
  }
  return rows
}

// Plan where to paint bars. barFor(rowInfo) -> string|null (the bar text already
// rendered, WITHOUT color — caller adds SGR). We only inject when the gap can hold
// the bar plus one space of padding on each side, so we never shove the layout.
function planInjections(screen, barFor) {
  const injections = []
  for (const info of findNodeRows(screen)) {
    const bar = barFor(info)
    if (!bar) continue
    const need = bar.length + 2 // 1 space padding each side
    if (info.gapWidth < need) continue // not enough room — skip, don't break layout
    // center the bar within the gap
    const slack = info.gapWidth - bar.length
    const col = info.gapStart + Math.floor(slack / 2)
    injections.push({ row: info.row, col, text: bar })
  }
  return injections
}

// ---------------------------------------------------------------------------
// Bar state + rendering, driven purely by what the row already shows (so we need
// NO cross-reference to the run-dir for the bar): the native row carries its own
// status (✔ done, ⏺/spinner running, ○ queued) and/or a token count.
const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷⠿]/
function rowState(text) {
  if (/✔|✓|\bdone\b/.test(text)) return 'done'
  if (/⏺|◉|\brunning\b/.test(text) || SPINNER.test(text)) return 'running'
  if (/○|◌|\bqueued\b|\bpending\b/.test(text)) return 'queued'
  // No explicit status marker but a finished-looking token count → treat as done.
  if (/\d+(?:\.\d+)?k?\s*tok/.test(text)) return 'done'
  return null
}

const FILLED = '▰', EMPTY = '▱'
function makeBar(state, frame, width = 5) {
  if (state === 'done') return '[' + FILLED.repeat(width) + ']'
  if (state === 'queued') return '[' + EMPTY.repeat(width) + ']'
  // running: a 2-wide bright window marching across, to signal live activity.
  const span = width + 2
  const pos = ((frame % span) + span) % span
  let s = ''
  for (let i = 0; i < width; i++) s += (i === pos || i === pos - 1) ? FILLED : EMPTY
  return '[' + s + ']'
}

const BAR_COLOR = { done: '\x1b[32m', running: '\x1b[36m', queued: '\x1b[90m' }

// Build the overlay byte string to paint onto the LIVE terminal after a frame:
// save cursor (DECSC) → for each fitting node row, position into the gap and
// write the colored bar → restore cursor (DECRC). Returns '' when nothing fits.
function planOverlay(screen, frame, opts = {}) {
  const width = opts.width == null ? 5 : opts.width
  let body = ''
  for (const info of findNodeRows(screen)) {
    const st = rowState(info.text)
    if (!st) continue
    const bar = makeBar(st, frame, width)
    if (info.gapWidth < bar.length + 2) continue // need 1 space padding each side
    const slack = info.gapWidth - bar.length
    const col = info.gapStart + Math.floor(slack / 2)
    body += `${ESC}[${info.row + 1};${col + 1}H` + (BAR_COLOR[st] || '') + bar + `${ESC}[0m`
  }
  if (!body) return ''
  return `${ESC}7` + body + `${ESC}8` // DECSC … DECRC (save/restore cursor + attrs)
}

module.exports = {
  Screen, findNodeRows, planInjections, stripSgr,
  rowState, makeBar, planOverlay,
}
