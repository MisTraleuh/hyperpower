export const meta = {
  name: 'hyperpower-debate',
  description: 'Claude and Codex debate a plan, then build and cross-review — one live table.',
  phases: [
    { title: 'Plan',      detail: 'Claude drafts an initial plan' },
    { title: 'Debate',    detail: 'Codex critiques, Claude revises, until they agree' },
    { title: 'Build',     detail: 'Claude implements WHILE Codex preps in parallel (file-claim safe)' },
    { title: 'Review',    detail: 'Codex reviews the result, Claude reconciles' },
  ],
}

// --- args (robust: accepts object, JSON string, or plain string) -----------
let task = 'No task provided'
let allowCodex = false
;(function parseArgs() {
  let a = args
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch { task = a; return }
  }
  if (a && typeof a === 'object') {
    task = a.task || a.prompt || task
    allowCodex = !!a.allowCodex
  }
})()

// --- participants ----------------------------------------------------------
// A (codex) node is a Claude subagent that drives the Codex CLI headlessly. Its
// LABEL carries the real Codex model — "(codex · gpt-5.5)" — pinned via `-m`, so
// the LABEL is the source of truth for which engine actually thought.
//
// BADGE LIMITATION (not fixable): the node's small model badge will read the
// Claude PROXY model (Sonnet), NOT gpt-5.5. This is unavoidable — the node IS a
// Claude subagent that shells out to Codex, so the harness badge reflects the
// Claude model running the node. Switching to agentType:'hyperpower:codex' would
// NOT change this (still a Claude model under the hood) and would drop the inline
// dumb-pipe guardrails below — so we keep the inline prompt + model:'sonnet'. The
// "(codex · gpt-5.5)" in the LABEL is the source of truth; the badge is cosmetic.
//
// The proxy runs on Sonnet so it reliably follows the dumb-pipe procedure instead
// of wandering off (a weaker model went reading ~/.claude transcripts instead of
// running Codex).
let codexModel = (args && typeof args === 'object' && args.codexModel) ? String(args.codexModel) : 'gpt-5.5'
function codexPrompt(body) {
  return [
    'You drive the Codex CLI headlessly and relay its answer FAITHFULLY. You are a PIPE',
    'for Codex, NOT an investigator. Do EXACTLY these steps — do NOT read ~/.claude, do',
    'NOT tail logs, do NOT explore the repo, do NOT run bare `codex` (it steals the TTY).',
    '  1. if `command -v codex` fails -> return {"error":"codex-not-installed"} and stop.',
    '  2. Write the BODY below to a temp file with the Write tool, e.g. /tmp/codex-in-<rand>.txt.',
    '  3. Run EXACTLY this one Bash (leave its FULL output visible — it IS Codex\'s trace):',
    '       O=/tmp/codex-out-<rand>.txt',
    '       codex exec --skip-git-repo-check --sandbox read-only --ephemeral --color never \\',
    '         -m ' + codexModel + ' -o "$O" < /tmp/codex-in-<rand>.txt 2>&1',
    '       echo "===CODEX FINAL==="; cat "$O"',
    '  4. The text after "===CODEX FINAL===" is Codex\'s answer. Relay it FAITHFULLY — this',
    '     is the trace the user wants to SEE, so do NOT shrink it to one line:',
    '     - If a JSON schema is required: put Codex\'s COMPLETE reasoning/answer VERBATIM in',
    '       the `reasoning` field (keep its substance, do not summarize it away), then fill',
    '       the structured fields (objections / agree / etc.) FROM that same answer.',
    '     - If no schema: return Codex\'s full answer, prefixed with "codex(' + codexModel + '): ".',
    '     Represent Codex\'s actual thinking — never substitute your own opinion for Codex\'s.',
    '',
    '--- BODY FOR CODEX ---',
    body,
  ].join('\n')
}
// --- progress: what a plugin can and CANNOT do -----------------------------
// HONEST NOTE: the live `/workflows` table — the spinner, the phase tree, and the
// per-node line `✓ (claude) <label>  Opus 4.8   12.3k tok · 5 tools · 40s` — is
// drawn by Claude Code's own native binary (a Bun-compiled executable, ~217 MB,
// at ~/.local/share/claude/versions/<v>), NOT by this repo. A plugin only gets the
// injected primitives `agent({label,phase,schema,model,effort})`, `phase()`,
// `log()` and `args`.
//
// A true PER-AGENT progress bar (empty when queued → animated while running →
// full when done, placed in the gap between the model badge and the token count)
// is a HARNESS feature. A plugin cannot do it: the only per-node text we control
// is the LABEL, which is fixed once the agent spawns and can never update — so it
// can show neither live progress nor a "done = full" state. We therefore do NOT
// fake a per-node bar (an earlier version put renderBar(0,1) — always 0% — into the
// label, which looked frozen and truncated the view). The honest progress signal
// is the harness's own "X/Y agents · time" header plus the OVERALL bar we emit via
// log() after each agent finishes (bumpProgress).
function renderBar(done, total, width = 10) {
  total = Math.max(1, total)
  const ratio = Math.max(0, Math.min(1, done / total))
  const filled = Math.round(ratio * width)
  // Unicode blocks with an ASCII-safe intent: █ filled, ░ empty. Terminals that
  // can render the harness table render these fine; if not, they degrade legibly.
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const pct = Math.round(ratio * 100)
  return '[' + bar + '] ' + pct + '%'
}

// Total expected agents, used for the overall bar. Recomputed once allowCodex is
// known: 1 plan + (debate rounds: up to 1 critique + 1 revise each) + 1 build +
// (1 review) + 1 reconcile. We over-count debate rounds conservatively; the bar
// only needs to advance monotonically and finish near 100%, not be exact.
let agentsDone = 0
let agentsTotal = 1 /* plan */ + 1 /* build */ + 1 /* reconcile */
function bumpProgress(nodeLabel) {
  agentsDone++
  log(renderBar(agentsDone, agentsTotal) + '  ' + agentsDone + '/' + agentsTotal +
    ' agents · just finished: ' + nodeLabel)
}

function codex(body, label, phase, schema) {
  // Sonnet/low: capable enough to follow the dumb-pipe procedure without wandering.
  // No bar in the label (it can't update, so it would only ever lie); the
  // "(codex · <model>)" tag stays the source of truth for which engine thought.
  const p = agent(codexPrompt(body), {
    label: '(codex · ' + codexModel + ') ' + label,
    phase, schema, model: 'sonnet', effort: 'low',
  })
  return Promise.resolve(p).then((r) => { bumpProgress('(codex) ' + label); return r })
}
function claude(prompt, label, phase, schema) {
  const p = agent(prompt, {
    label: '(claude) ' + label,
    phase, schema,
  })
  return Promise.resolve(p).then((r) => { bumpProgress('(claude) ' + label); return r })
}

// --- orchestration primitives (beat AgentMesh, stay a plugin) ---------------
// The workflow script is sandboxed (no fs/require), but the AGENTS it spawns have
// Bash. So file-claim coordination + persistent run state are driven by telling
// each agent to call our CLI `node bin/hpw-claims.js` (see bin/hpw-claims.js).
// A stable per-run id namespaces the claim table + run record under ~/.hyperpower.
const RUN_ID = (args && typeof args === 'object' && args.runId) ? String(args.runId)
  : 'hpw-' + Math.abs((task || 'x').split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(36)
const CLAIMS_CLI = 'node "$CLAUDE_PLUGIN_ROOT/bin/hpw-claims.js"'
// Instruction block appended to any agent that may EDIT files, so parallel agents
// never clobber each other: claim → (back off on conflict) → edit → release → record.
function claimNote(owner, role) {
  return '\n\nFILE-CLAIM PROTOCOL (you may run in parallel with another engine — do NOT clobber it):\n' +
    '1. BEFORE editing any file, claim it:  ' + CLAIMS_CLI + ' claim ' + RUN_ID + ' ' + owner + ' <file...>\n' +
    '   (if $CLAUDE_PLUGIN_ROOT is unset, use the repo path to bin/hpw-claims.js). Exit code 3 = a\n' +
    '   conflict: that file is owned by the other agent — do NOT touch it, work around it or wait.\n' +
    '2. AFTER you finish editing, release:   ' + CLAIMS_CLI + ' release ' + RUN_ID + ' ' + owner + ' <file...>\n' +
    '3. When done, record your task:         ' + CLAIMS_CLI + ' record ' + RUN_ID + ' ' + owner + ' ' + role + ' "<one-line result>"\n' +
    'Only claimed files are yours to write. Honor conflicts strictly.'
}

// Drill-in body fix: an agent whose final turn is a StructuredOutput call produces
// an EMPTY finalText, so the harness drill-in panel for that node shows nothing.
// We append this instruction to every schema'd prompt so the agent ALSO prints a
// short plain-text summary as its final assistant message, populating the drill-in.
// (Residual uncertainty: if the harness treats the StructuredOutput call as the
// terminal turn, trailing text may be dropped; we ask for the summary to be the
// LAST thing emitted to maximize the chance it lands.)
const FINAL_TEXT_NOTE =
  '\n\nIMPORTANT — after you call StructuredOutput, ALSO write a 2-4 line plain-text ' +
  'summary as your final assistant message (the same turn is fine), so the drill-in ' +
  'panel for this node is not empty. Keep it human-readable, no JSON.'

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['plan'],
  properties: { plan: { type: 'string', description: 'The step-by-step plan' } },
}
const CRITIQUE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['agree', 'objections', 'reasoning'],
  properties: {
    agree: { type: 'boolean' },
    objections: { type: 'array', items: { type: 'string' } },
    reasoning: { type: 'string', description: "Codex's full critique/analysis VERBATIM — the visible trace of what Codex actually argued" },
    error: { type: 'string' },
  },
}

log('Task: ' + task.slice(0, 120) + (task.length > 120 ? '…' : ''))
if (task === 'No task provided') log('WARNING: empty task — check that args was passed as a JSON object, not a string.')

// Now that allowCodex is known, budget the overall bar. With Codex: a typical
// debate is ~1 critique + 1 revise, plus the review node. renderBar() clamps at
// 100%, so a slight under-budget just means the bar fills sooner — acceptable.
if (allowCodex) agentsTotal += 2 /* critique + revise */ + 1 /* review */
log(renderBar(0, agentsTotal) + '  0/' + agentsTotal + ' agents · starting')

// --- Plan ------------------------------------------------------------------
phase('Plan')
let plan = (await claude(
  'Draft a rigorous, numbered plan to solve this task — good enough to survive an ' +
  'adversarial review by a second engine. For each step be specific (what, where, why); ' +
  'call out the key risks, edge cases, and assumptions, and how you would verify success. ' +
  'No code yet, but no hand-waving either.\n\n' + task +
  FINAL_TEXT_NOTE,
  'draft-plan', 'Plan', PLAN_SCHEMA
)).plan

// --- Debate (only when Codex is allowed) ----------------------------------
let codexAvailable = allowCodex
const debateLog = []
if (allowCodex) {
  const MAX_ROUNDS = 3
  // Force a REAL debate: Codex may not rubber-stamp on round 1, and we require at
  // least one full critique→revise cycle before any agreement is accepted. This is
  // the fix for "the debate gets skipped / it doesn't think enough": before, Codex
  // could `agree` on the first pass and the loop broke with zero revisions.
  const MIN_REVISIONS = 1
  let revisions = 0
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    phase('Debate')
    log('Debate r' + round + ': Codex is challenging the plan (read-only)…')
    const firstPass = round === 1
    const critique = await codex(
      (firstPass
        ? 'Adversarially critique this plan. You MUST surface at least TWO concrete, ' +
          'specific weaknesses, risks, or gaps — do NOT rubber-stamp and do NOT agree on ' +
          'this first pass. Set agree=false and list the objections.'
        : 'Critique the REVISED plan. If it is genuinely solid now, you may set agree=true; ' +
          'otherwise return remaining concrete objections.') +
      '\n\nTASK:\n' + task + '\n\nPLAN:\n' + plan + FINAL_TEXT_NOTE,
      'critique r' + round, 'Debate', CRITIQUE_SCHEMA
    )
    if (!critique || critique.error) {
      log('Codex unavailable (' + ((critique && critique.error) || 'no result') + ') — continuing Claude-only.')
      codexAvailable = false
      break
    }
    let objections = critique.objections || []
    const reasoning = (critique.reasoning || '').trim()
    // Surface Codex's actual trace in the live log so the debate is visible, not silent.
    log('Codex r' + round + ' · ' + objections.length + ' objection(s)' +
      (reasoning ? ' — ' + reasoning.replace(/\s+/g, ' ').slice(0, 140) : ''))
    // Only accept agreement once at least one revision has actually happened.
    if ((critique.agree || objections.length === 0) && revisions >= MIN_REVISIONS) {
      log('Codex agrees after round ' + round + ' (post-revision).')
      debateLog.push({ round, agreed: true, reasoning })
      break
    }
    // No objections but we still owe a revision: make Claude self-harden the plan
    // rather than waving it through, so there is always genuine back-and-forth.
    if (objections.length === 0) {
      log('Codex raised no objections on r' + round + ' — forcing a hardening pass anyway.')
      objections = ['No explicit objection from Codex — proactively harden the plan: ' +
        'tighten the weakest step, add an edge case you may have missed, and state one risk.']
    }
    debateLog.push({ round, objections, reasoning })
    // Feed Codex's FULL reasoning (not just bullet objections) into the revision, so the
    // revised plan genuinely integrates Codex's thinking instead of pattern-matching bullets.
    plan = (await claude(
      'Codex (a second, independent engine) critiqued your plan. Engage with it seriously.\n\n' +
      (reasoning ? "CODEX'S FULL REASONING:\n" + reasoning + '\n\n' : '') +
      'CONCRETE OBJECTIONS:\n- ' + objections.join('\n- ') + '\n\n' +
      'Address EACH objection (accept or reject, with a one-line reason), incorporate what is ' +
      'right, push back on what is wrong, and return a genuinely STRONGER revised plan — not a ' +
      'cosmetic edit.\n\nCURRENT PLAN:\n' + plan + FINAL_TEXT_NOTE,
      'revise r' + round, 'Debate', PLAN_SCHEMA
    )).plan
    revisions++
  }
}

// --- Build (PARALLEL: Claude implements WHILE Codex prepares, no clobber) ---
// Unlike a strictly sequential pipeline, here Claude's implementation and Codex's
// independent prep run CONCURRENTLY (the runtime's parallel()). Claude WRITES files
// (claiming each first); Codex stays READ-ONLY and prepares a test/risk checklist
// from the plan, so its work is genuinely independent — no false parallelism, and
// the file-claim registry guarantees no clobber if a future variant lets both write.
phase('Build')
let buildPrep = null
const buildTasks = [
  () => claude(
    'Carry out the agreed plan. If it requires code, make the edits and run tests; report ' +
    'findings with exact file:line evidence. Return a summary of what you found / changed.\n\n' +
    'PLAN:\n' + plan + claimNote('claude', 'build'),
    'build', 'Build'
  ),
]
if (codexAvailable) {
  buildTasks.push(() => codex(
    'READ-ONLY prep IN PARALLEL with Claude\'s implementation. Do NOT edit files. From the ' +
    'plan, produce a concise checklist of: tests that should exist, edge cases to verify, and ' +
    'the top risks to watch during implementation. This runs while Claude builds.\n\nPLAN:\n' + plan,
    'build-prep', 'Build'
  ))
}
const buildResults = await parallel(buildTasks)
const build = buildResults[0]
if (buildResults.length > 1 && buildResults[1]) {
  buildPrep = buildResults[1]
  if (typeof buildPrep === 'string' && buildPrep.trim()) {
    log('Codex build-prep · ' + buildPrep.replace(/\s+/g, ' ').slice(0, 140))
  }
}

// --- Review (Codex reviews the result; Claude reconciles) ------------------
phase('Review')
let codexReview = null
if (codexAvailable) {
  log('Review: Codex is auditing the result (read-only)…')
  codexReview = await codex(
    'Review this work against the plan THOROUGHLY. Flag correctness bugs, missed edge ' +
    'cases, or unsupported claims, with file:line where possible. Give your full reasoning ' +
    '— this review is shown to the user as Codex\'s trace.\n\nPLAN:\n' + plan +
    (buildPrep ? '\n\nYOUR EARLIER BUILD-PREP CHECKLIST (verify it was honored):\n' + JSON.stringify(buildPrep) : '') +
    '\n\nWORK:\n' + JSON.stringify(build),
    'review', 'Review'
  )
  if (typeof codexReview === 'string' && codexReview.trim()) {
    log('Codex review · ' + codexReview.replace(/\s+/g, ' ').slice(0, 160))
  }
}
const verdict = await claude(
  'Reconcile your work with Codex\'s review. State the final answer, list which Codex ' +
  'points you accept vs reject (with reasons), and flag anything still unverified.\n\n' +
  'WORK:\n' + JSON.stringify(build) + '\n\nCODEX REVIEW:\n' + JSON.stringify(codexReview),
  'reconcile', 'Review'
)

return { task, allowCodex, codexAvailable, runId: RUN_ID, plan, debate: debateLog, buildPrep, build, codexReview, verdict }
