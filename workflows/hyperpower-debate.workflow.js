export const meta = {
  name: 'hyperpower-debate',
  description: 'Claude and Codex debate a plan, then build and cross-review — one live table.',
  phases: [
    { title: 'Plan',      detail: 'Claude drafts an initial plan' },
    { title: 'Debate',    detail: 'Codex critiques, Claude revises, until they agree' },
    { title: 'Build',     detail: 'Claude implements; Codex stays read-only' },
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
    'You drive the Codex CLI headlessly and relay ONE concise line. You are a DUMB PIPE,',
    'NOT an investigator. Do EXACTLY these steps and NOTHING else — do NOT read ~/.claude,',
    'do NOT tail logs, do NOT explore the repo, do NOT run bare `codex` (it steals the TTY).',
    '  1. if `command -v codex` fails -> return {"error":"codex-not-installed"} and stop.',
    '  2. Write the BODY below to a temp file with the Write tool, e.g. /tmp/codex-in-<rand>.txt.',
    '  3. Run EXACTLY this one Bash (leave its full output visible — that is the drill-in detail):',
    '       O=/tmp/codex-out-<rand>.txt',
    '       codex exec --skip-git-repo-check --sandbox read-only --ephemeral --color never \\',
    '         -m ' + codexModel + ' -o "$O" < /tmp/codex-in-<rand>.txt 2>&1',
    '       echo "===CODEX FINAL==="; cat "$O"',
    '  4. The text after "===CODEX FINAL===" is Codex\'s clean answer. Return exactly ONE line:',
    '       codex(' + codexModel + '): <that answer, trimmed to the essentials>',
    '     If a JSON schema is required, fill it from that answer with tight strings.',
    '     NEVER paste the full transcript into your answer — it is already visible from step 3.',
    '',
    '--- BODY FOR CODEX ---',
    body,
  ].join('\n')
}
// --- progress bar (emulated) ----------------------------------------------
// HONEST NOTE ON RENDERING: the live `/workflows` table — the spinner, the phase
// tree, and the per-node line `✓ (claude) <label>   12.3k tok` — is drawn by the
// Claude Code Workflow harness, which is NOT in this repo. The script only gets
// the injected primitives `agent({label,phase,schema,model,effort})`, `phase()`,
// `log()` and `args`. There is NO progress/detail/subtitle field on a node, and
// the model badge → token count zone (the gap between the model name and "k tok")
// is drawn entirely by the harness; the script cannot inject text there.
//
// What we CAN control is (a) the node's LABEL text and (b) `log()` lines (printed
// under the active phase). We deliberately do NOT put a per-node bar in the label:
//   - it freezes at 0% (the label is set once at agent-creation and never updated,
//     so a node's bar can never show progress — it is a lie); and
//   - it lengthens the label, which truncates the collapsed-Phases view.
// So the ONLY bar we draw is the OVERALL workflow bar, emitted via `log()` after
// each agent finishes (bumpProgress). That one is honest: it advances monotonically
// and reflects real completed/total agent counts.
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
  // No per-node bar in the label (it would freeze at 0% and truncate the label);
  // the label's "(codex · <model>)" prefix is the source of truth for the engine.
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
  type: 'object', additionalProperties: false, required: ['agree', 'objections'],
  properties: {
    agree: { type: 'boolean' },
    objections: { type: 'array', items: { type: 'string' } },
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
  'Draft a concise, numbered plan to investigate/solve this task. No code yet.\n\n' + task +
  FINAL_TEXT_NOTE,
  'draft-plan', 'Plan', PLAN_SCHEMA
)).plan

// --- Debate (only when Codex is allowed) ----------------------------------
let codexAvailable = allowCodex
const debateLog = []
if (allowCodex) {
  const MAX_ROUNDS = 3
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    phase('Debate')
    log('Debate r' + round + ': Codex is reviewing Claude\'s plan (read-only)…')
    const critique = await codex(
      'Critique this plan. Return concrete objections, or agree.\n\nTASK:\n' + task + '\n\nPLAN:\n' + plan +
      FINAL_TEXT_NOTE,
      'critique r' + round, 'Debate', CRITIQUE_SCHEMA
    )
    if (!critique || critique.error) {
      log('Codex unavailable (' + ((critique && critique.error) || 'no result') + ') — continuing Claude-only.')
      codexAvailable = false
      break
    }
    const objections = critique.objections || []
    if (critique.agree || objections.length === 0) {
      log('Codex agrees after round ' + round + '.')
      debateLog.push({ round, agreed: true })
      break
    }
    debateLog.push({ round, objections })
    plan = (await claude(
      'Codex raised these objections. Address EACH (accept/reject + one-line reason), ' +
      'then return the REVISED plan.\n\nOBJECTIONS:\n- ' + objections.join('\n- ') +
      '\n\nCURRENT PLAN:\n' + plan + FINAL_TEXT_NOTE,
      'revise r' + round, 'Debate', PLAN_SCHEMA
    )).plan
  }
}

// --- Build (Claude implements in-repo; Codex stays read-only) --------------
phase('Build')
const build = await claude(
  'Carry out the agreed plan. If it is an investigation, report findings with exact ' +
  'file:line evidence. If it requires code, make the edits and run tests. Return a ' +
  'summary of what you found / changed.\n\nPLAN:\n' + plan,
  'build', 'Build'
)

// --- Review (Codex reviews the result; Claude reconciles) ------------------
phase('Review')
let codexReview = null
if (codexAvailable) {
  log('Review: Codex is auditing the result (read-only)…')
  codexReview = await codex(
    'Review this work against the plan. Flag correctness bugs, missed edge cases, or ' +
    'unsupported claims, with file:line where possible.\n\nPLAN:\n' + plan +
    '\n\nWORK:\n' + JSON.stringify(build),
    'review', 'Review'
  )
}
const verdict = await claude(
  'Reconcile your work with Codex\'s review. State the final answer, list which Codex ' +
  'points you accept vs reject (with reasons), and flag anything still unverified.\n\n' +
  'WORK:\n' + JSON.stringify(build) + '\n\nCODEX REVIEW:\n' + JSON.stringify(codexReview),
  'reconcile', 'Review'
)

return { task, allowCodex, codexAvailable, plan, debate: debateLog, build, codexReview, verdict }
