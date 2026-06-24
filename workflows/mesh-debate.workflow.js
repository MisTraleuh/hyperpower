export const meta = {
  name: 'mesh-debate',
  description: 'Claude and Codex debate a plan, then implement and cross-review — one live table.',
  phases: [
    { title: 'Plan',      detail: 'Claude drafts an initial plan' },
    { title: 'Debate',    detail: 'Codex critiques, Claude revises, until they agree' },
    { title: 'Implement', detail: 'Codex implements + tests; Claude writes notes' },
    { title: 'Review',    detail: 'Claude cross-reviews the work against the plan' },
  ],
}

const task = (args && args.task) || 'No task provided'
const allowCodex = !!(args && args.allowCodex)

// --- participants ----------------------------------------------------------
// A (codex) node is a subagent told to drive the Codex CLI and relay its output.
// Labelling it `codex:*` makes it show up as a distinct node in the live table.
// Once the plugin is installed you can swap the inline prompt for
// { agentType: 'codex' } to reuse agents/codex.md.
function codex(prompt, label, phase, schema) {
  return agent(
    'You are a thin proxy for the Codex CLI — NOT Claude. Run:\n' +
    '  codex exec --skip-git-repo-check ' + JSON.stringify(prompt) + '\n' +
    'Return ONLY what Codex produced. If `codex` is not on the PATH, return ' +
    '{"error":"codex-not-installed"}.',
    { label, phase, schema }
  )
}
function claude(prompt, label, phase, schema) {
  return agent(prompt, { label, phase, schema })
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

// --- Plan ------------------------------------------------------------------
phase('Plan')
let plan = (await claude(
  'Draft a concise, numbered implementation plan for this task. No code yet.\n\n' + task,
  'claude:draft-plan', 'Plan', PLAN_SCHEMA
)).plan

// --- Debate (only when Codex is allowed) ----------------------------------
let codexAvailable = allowCodex
const debateLog = []
if (allowCodex) {
  const MAX_ROUNDS = 3
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    phase('Debate')
    const critique = await codex(
      'Critique this implementation plan. Return concrete objections, or agree.\n\n' +
      'TASK:\n' + task + '\n\nPLAN:\n' + plan,
      'codex:critique-r' + round, 'Debate', CRITIQUE_SCHEMA
    )
    if (!critique || critique.error) {
      log('Codex unavailable — continuing Claude-only.')
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
    const revised = await claude(
      'Codex raised these objections to your plan. Address EACH (accept or reject ' +
      'with a one-line reason), then return the REVISED plan.\n\n' +
      'OBJECTIONS:\n- ' + objections.join('\n- ') + '\n\nCURRENT PLAN:\n' + plan,
      'claude:revise-r' + round, 'Debate', PLAN_SCHEMA
    )
    plan = revised.plan
  }
}

// --- Implement -------------------------------------------------------------
phase('Implement')
const work = (await parallel([
  () => codexAvailable
    ? codex('Implement this plan and add tests. Return a summary of files changed ' +
            'and test results.\n\n' + plan, 'codex:implement', 'Implement')
    : claude('Implement this plan and add tests. Return a summary of files changed ' +
             'and test results.\n\n' + plan, 'claude:implement', 'Implement'),
  () => claude('Write short migration / reviewer notes for this plan.\n\n' + plan,
               'claude:notes', 'Implement'),
])).filter(Boolean)

// --- Review ----------------------------------------------------------------
phase('Review')
const review = await claude(
  'Cross-review the work below against the plan. Flag correctness bugs, missed ' +
  'edge cases, or test gaps. If clean, say so explicitly.\n\n' +
  'PLAN:\n' + plan + '\n\nWORK:\n' + JSON.stringify(work),
  'claude:cross-review', 'Review'
)

return { task, allowCodex, codexAvailable, plan, debate: debateLog, work, review }
