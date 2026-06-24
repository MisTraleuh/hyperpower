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
let CLAUDE_MODEL = 'claude'
let CODEX_MODEL = 'gpt-5.5'
;(function parseArgs() {
  let a = args
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch { task = a; return }
  }
  if (a && typeof a === 'object') {
    task = a.task || a.prompt || task
    allowCodex = !!a.allowCodex
    if (a.claudeModel) CLAUDE_MODEL = a.claudeModel
    if (a.codexModel) CODEX_MODEL = a.codexModel
  }
})()

// --- participants ----------------------------------------------------------
// A (codex) node is a subagent told to run the Codex CLI HEADLESSLY and relay its
// output. The full terminal-safety contract is inlined so it holds even if the
// codex agent definition isn't loaded. Labels carry the model so the live table
// reads "(codex·gpt-5.5)" / "(claude)".
function codexPrompt(body) {
  return [
    'You are a headless proxy for the Codex CLI — NOT Claude. Relay ONLY Codex output.',
    'SAFETY (a past version hijacked the user terminal — never repeat it):',
    '  - never run bare `codex` (interactive); ALWAYS `codex exec`.',
    '  - ALWAYS feed the prompt from a file on stdin; never as a shell arg, never the keyboard.',
    '  - keep Codex read-only.',
    'Steps:',
    '  1. if `command -v codex` fails -> return {"error":"codex-not-installed"} and stop.',
    '  2. Write the BODY below to a unique temp file (Write tool, e.g. /tmp/codex-<rand>.txt).',
    '  3. run: codex exec --skip-git-repo-check --sandbox read-only --ephemeral < <file> 2>&1',
    '  4. return ONLY Codex\'s substantive answer (strip its banner/footer).',
    '',
    '--- BODY FOR CODEX ---',
    body,
  ].join('\n')
}
function codex(body, label, phase, schema) {
  return agent(codexPrompt(body), { label: '(codex·' + CODEX_MODEL + ') ' + label, phase, schema })
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
