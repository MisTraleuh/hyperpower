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
// A (codex) node is a LIGHTWEIGHT Claude proxy (haiku/low) that drives the Codex
// CLI headlessly. The node's own badge therefore honestly shows the cheap proxy
// model; Codex's REAL model (e.g. gpt-5.5) is reported inside the node's output.
// The full Codex transcript stays VISIBLE in the node (drill-in to see what Codex
// actually ran); the returned value is a tight one-liner.
function codexPrompt(body) {
  return [
    'You are a LIGHTWEIGHT headless proxy for the Codex CLI — NOT Claude. Be cheap and fast.',
    'SAFETY (a past version hijacked the user terminal — never repeat it):',
    '  - never run bare `codex` (interactive, steals the TTY); ALWAYS `codex exec`.',
    '  - ALWAYS feed the prompt from a FILE on stdin; never a shell arg, never the keyboard.',
    '  - keep Codex read-only.',
    'Steps:',
    '  1. if `command -v codex` fails -> return {"error":"codex-not-installed"} and stop.',
    '  2. Write the BODY below to a unique temp file with the Write tool, e.g. /tmp/codex-<rand>.txt.',
    '  3. Run this Bash and LEAVE ITS OUTPUT VISIBLE — it is the full Codex transcript so the user',
    '     can drill in and see exactly what Codex did, including any commands Codex ran:',
    '       L=/tmp/codex-last-<rand>.txt',
    '       codex exec --skip-git-repo-check --sandbox read-only --ephemeral --color never \\',
    '         -o "$L" < /tmp/codex-<rand>.txt 2>&1; echo "--- CLEAN FINAL ---"; cat "$L"',
    '  4. RETURN A CONCISE RESULT — one short line, NEVER the transcript (already visible above).',
    '     Read Codex\'s model and token count from the transcript banner/footer. Shape:',
    '       codex(<model>, <Ntok>): <clean final from -o, trimmed to the essentials>',
    '     If a JSON schema is requested, fill it from the clean final and keep strings tight.',
    '',
    '--- BODY FOR CODEX ---',
    body,
  ].join('\n')
}
function codex(body, label, phase, schema) {
  // haiku/low: the proxy does trivial relay work, so its node badge stays cheap & honest.
  return agent(codexPrompt(body), { label: '(codex) ' + label, phase, schema, model: 'haiku', effort: 'low' })
}
function claude(prompt, label, phase, schema) {
  return agent(prompt, { label: '(claude) ' + label, phase, schema })
}

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

// --- Plan ------------------------------------------------------------------
phase('Plan')
let plan = (await claude(
  'Draft a concise, numbered plan to investigate/solve this task. No code yet.\n\n' + task,
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
      'Critique this plan. Return concrete objections, or agree.\n\nTASK:\n' + task + '\n\nPLAN:\n' + plan,
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
      '\n\nCURRENT PLAN:\n' + plan,
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
