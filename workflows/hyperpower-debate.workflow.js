export const meta = {
  name: 'hyperpower-debate',
  description: 'Claude and Codex debate a plan, then build and cross-review — one live table.',
  phases: [
    { title: 'Plan',    detail: 'Claude drafts a rigorous plan; Codex debates it' },
    { title: 'Todo',    detail: 'Spec actionable tickets (todo skill); Codex debates them' },
    { title: 'Dev',     detail: 'Implement tickets (dev skill) WHILE Codex preps in parallel' },
    { title: 'Verify',  detail: 'Audit the implementation (verify-dev skill); Codex debates; loop if KO' },
    { title: 'Ship',    detail: 'Build + test (build/test skills); Codex final review; reconcile' },
  ],
}

// --- args (robust: accepts object, JSON string, or plain string) -----------
let task = 'No task provided'
let allowCodex = false
// Tri-state mode: forceMode = 'quick' | 'full' | null (null = let the workflow
// decide intelligently from the plan's own complexity assessment).
let forceMode = null
;(function parseArgs() {
  let a = args
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch { task = a; return }
  }
  if (a && typeof a === 'object') {
    task = a.task || a.prompt || task
    allowCodex = !!a.allowCodex
    if (a.quick === true) forceMode = 'quick'
    if (a.full === true || a.deep === true) forceMode = 'full'
    if (typeof a.mode === 'string' && /^(quick|full)$/.test(a.mode)) forceMode = a.mode
  }
  // Fallback: detect an explicit flag in the task text.
  if (/(^|\s)--(quick|lite)(\s|$)/.test(task)) { forceMode = 'quick'; task = task.replace(/(^|\s)--(quick|lite)(\s|$)/g, ' ').trim() }
  if (/(^|\s)--(full|deep)(\s|$)/.test(task)) { forceMode = 'full'; task = task.replace(/(^|\s)--(full|deep)(\s|$)/g, ' ').trim() }
})()
let quick = false // resolved after the plan's self-assessment (see below)

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
// Initial plan ALSO self-assesses complexity, so the workflow can pick its own
// depth (quick vs full) without the user passing a flag.
const PLAN0_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['plan', 'complexity', 'complexityReason'],
  properties: {
    plan: { type: 'string', description: 'The step-by-step plan' },
    complexity: { type: 'string', enum: ['quick', 'full'],
      description: 'quick = small/self-contained (≈1 file, a flag, a tiny fix) → short cycle; full = a real feature/refactor/migration, multi-file, or needs tests+verification → full skill-driven cycle' },
    complexityReason: { type: 'string', description: 'One line: why this complexity.' },
  },
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

// --- skill-driven phases ----------------------------------------------------
// The big change: each phase APPLIES one of the user's skills (~/.claude/skills/
// <name>/SKILL.md). The workflow script is sandboxed, but the agents it spawns have
// the Read tool — so we tell each agent to read its skill file and follow that
// methodology. Robust whether or not subagents can invoke the Skill tool directly.
function skillNote(skill) {
  return '\n\nMETHODOLOGY — apply the "' + skill + '" skill: Read the file ' +
    '~/.claude/skills/' + skill + '/SKILL.md and follow its procedure rigorously. ' +
    'If that path is missing, fall back to senior-engineer best practice for ' + skill + '.'
}

let codexAvailable = allowCodex
const debateLog = []

// Generalized FORCED debate gate, reusable at every milestone. Codex must raise
// concrete objections (no rubber-stamp), and the artifact goes through >=1 real
// critique->revise cycle before agreement. `reviseFn(objections, reasoning, current)`
// returns the revised artifact (a string). Returns the possibly-revised artifact.
async function debateGate(gate, phaseName, artifactKind, artifact, reviseFn) {
  if (!codexAvailable) return artifact
  const MAX_ROUNDS = 3, MIN_REVISIONS = 1
  let revisions = 0, current = artifact
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    phase(phaseName)
    log(gate + ' debate r' + round + ': Codex challenges the ' + artifactKind + '…')
    const first = round === 1
    const critique = await codex(
      (first
        ? 'Adversarially critique this ' + artifactKind + '. Surface at least TWO concrete, ' +
          'specific weaknesses/risks/gaps — do NOT rubber-stamp, set agree=false.'
        : 'Critique the REVISED ' + artifactKind + '. If genuinely solid now you may set ' +
          'agree=true; else return remaining concrete objections.') +
      '\n\nTASK:\n' + task + '\n\n' + artifactKind.toUpperCase() + ':\n' + current + FINAL_TEXT_NOTE,
      gate + '-critique r' + round, phaseName, CRITIQUE_SCHEMA
    )
    if (!critique || critique.error) {
      log('Codex unavailable (' + ((critique && critique.error) || 'no result') + ') — continuing Claude-only.')
      codexAvailable = false
      break
    }
    let objections = critique.objections || []
    const reasoning = (critique.reasoning || '').trim()
    log('Codex [' + gate + ' r' + round + '] · ' + objections.length + ' objection(s)' +
      (reasoning ? ' — ' + reasoning.replace(/\s+/g, ' ').slice(0, 130) : ''))
    if ((critique.agree || objections.length === 0) && revisions >= MIN_REVISIONS) {
      log('Codex agrees on the ' + artifactKind + ' after round ' + round + '.')
      debateLog.push({ gate, round, agreed: true, reasoning })
      break
    }
    if (objections.length === 0) {
      objections = ['No explicit objection — proactively harden the ' + artifactKind +
        ': tighten the weakest part, add a missed edge case, state one risk.']
    }
    debateLog.push({ gate, round, objections, reasoning })
    current = await reviseFn(objections, reasoning, current, round)
    revisions++
  }
  return current
}

log('Task: ' + task.slice(0, 120) + (task.length > 120 ? '…' : ''))
if (task === 'No task provided') log('WARNING: empty task — check that args was passed as a JSON object, not a string.')
// Budget the overall bar: 5 phases, each up to ~2 nodes when Codex debates.
agentsTotal = 6 + (allowCodex ? 6 : 0)
log(renderBar(0, agentsTotal) + '  0/' + agentsTotal + ' agents · starting')

// === 1. PLAN (+ self-assessed complexity) → decide depth → debate ===========
phase('Plan')
const plan0 = await claude(
  'Draft a rigorous, numbered plan to solve this task — good enough to survive an ' +
  'adversarial review by a second engine. Be specific (what/where/why), call out risks, ' +
  'edge cases, assumptions, and how to verify success. No code yet.\n\n' +
  'ALSO assess this task\'s complexity: "quick" if it is small and self-contained ' +
  '(≈1 file, a flag, a tiny fix — a full ticket/verify/ship cycle would be overkill), or ' +
  '"full" if it is a real feature/refactor/migration, touches multiple files, or needs ' +
  'tests + verification. Be honest — most one-off changes are "quick".\n\n' + task + FINAL_TEXT_NOTE,
  'draft-plan', 'Plan', PLAN0_SCHEMA
)
let plan = plan0.plan
// Resolve depth: explicit flag wins; otherwise the plan's own assessment decides.
if (forceMode) {
  quick = forceMode === 'quick'
  log('Mode: ' + forceMode + ' (forced by flag).')
} else {
  quick = plan0.complexity === 'quick'
  log('Mode: ' + (quick ? 'quick' : 'full') + ' (auto) — ' + (plan0.complexityReason || plan0.complexity))
}
plan = await debateGate('plan', 'Plan', 'plan', plan, (obj, reasoning, cur) =>
  claude('Codex critiqued your plan. Engage seriously.\n\n' +
    (reasoning ? "CODEX REASONING:\n" + reasoning + '\n\n' : '') +
    'OBJECTIONS:\n- ' + obj.join('\n- ') + '\n\nAddress each (accept/reject + reason), and ' +
    'return a STRONGER revised plan.\n\nCURRENT PLAN:\n' + cur + FINAL_TEXT_NOTE,
    'plan-revise', 'Plan', PLAN_SCHEMA).then((r) => r.plan))

// === QUICK MODE: short Plan → Build → Review (skip Todo/Verify/Ship) =========
// For small tasks the full skill-driven cycle is overkill (it can be ~20 agents).
// --quick keeps the debated plan + parallel build + Codex review/reconcile only.
if (quick) {
  log('Quick mode: Plan → Build → Review (Todo/Verify/Ship skipped).')
  phase('Dev')
  const qTasks = [
    () => claude(
      'Carry out the agreed plan. Make the edits and run what you can; report changes with ' +
      'exact file:line evidence.' + claimNote('claude', 'build') + '\n\nPLAN:\n' + plan,
      'build', 'Dev'),
  ]
  if (codexAvailable) {
    qTasks.push(() => codex(
      'READ-ONLY prep IN PARALLEL with Claude: tests/edge cases/risks from the plan. ' +
      'Do NOT edit files.\n\nPLAN:\n' + plan, 'build-prep', 'Dev'))
  }
  const qRes = await parallel(qTasks)
  const qBuild = qRes[0]
  phase('Ship')
  let qReview = null
  if (codexAvailable) {
    qReview = await codex(
      'Review this work against the plan. Flag correctness bugs, missed edge cases, or ' +
      'unsupported claims, with file:line. Give your full reasoning.\n\nPLAN:\n' + plan +
      '\n\nWORK:\n' + JSON.stringify(qBuild), 'final-review', 'Ship')
    if (typeof qReview === 'string' && qReview.trim()) log('Codex review · ' + qReview.replace(/\s+/g, ' ').slice(0, 160))
  }
  const qVerdict = await claude(
    'Reconcile your work with Codex\'s review. State the final answer, list which Codex points ' +
    'you accept vs reject (with reasons), and flag anything still unverified.\n\nWORK:\n' +
    JSON.stringify(qBuild) + '\n\nCODEX REVIEW:\n' + JSON.stringify(qReview), 'reconcile', 'Ship')
  return { task, allowCodex, codexAvailable, runId: RUN_ID, quick: true, plan,
    debate: debateLog, build: qBuild, codexReview: qReview, verdict: qVerdict }
}

// === 2. TODO (todo skill) → debate =========================================
phase('Todo')
let todo = (await claude(
  'Turn the agreed plan into actionable technical tickets (a todo list): precise specs, ' +
  'the exact files each ticket touches, dependencies, and execution order.' +
  skillNote('todo') + '\n\nPLAN:\n' + plan + FINAL_TEXT_NOTE,
  'spec-todo', 'Todo', PLAN_SCHEMA
)).plan
todo = await debateGate('todo', 'Todo', 'todo', todo, (obj, reasoning, cur) =>
  claude('Codex critiqued your tickets. Engage seriously.\n\n' +
    (reasoning ? "CODEX REASONING:\n" + reasoning + '\n\n' : '') +
    'OBJECTIONS:\n- ' + obj.join('\n- ') + '\n\nFix the ticket specs/order/deps and return the ' +
    'revised todo list.\n\nCURRENT TODO:\n' + cur + FINAL_TEXT_NOTE,
    'todo-revise', 'Todo', PLAN_SCHEMA).then((r) => r.plan))

// === 3. DEV (dev skill) — Claude implements WHILE Codex preps in parallel ===
phase('Dev')
let devPrep = null
const devTasks = [
  () => claude(
    'Implement the tickets with senior-architect rigor (backend + frontend + close each ticket). ' +
    'Make the edits and run what you can; report changes with exact file:line evidence.' +
    skillNote('dev') + claimNote('claude', 'dev') + '\n\nTODO:\n' + todo,
    'dev', 'Dev'),
]
if (codexAvailable) {
  devTasks.push(() => codex(
    'READ-ONLY, IN PARALLEL with Claude\'s implementation. Do NOT edit files. From the todo, ' +
    'produce a verification checklist: tests that must exist, edge cases, and the top risks to ' +
    'watch. This runs while Claude develops.\n\nTODO:\n' + todo,
    'dev-prep', 'Dev'))
}
const devResults = await parallel(devTasks)
let dev = devResults[0]
if (devResults.length > 1 && devResults[1]) {
  devPrep = devResults[1]
  if (typeof devPrep === 'string' && devPrep.trim()) log('Codex dev-prep · ' + devPrep.replace(/\s+/g, ' ').slice(0, 130))
}

// === 4. VERIFY (verify-dev skill) → debate → loop if KO =====================
let verify = null
const MAX_FIX_ROUNDS = 2
for (let fix = 0; fix <= MAX_FIX_ROUNDS; fix++) {
  phase('Verify')
  verify = await claude(
    'Audit the real implementation with senior code-review rigor: backend/frontend/DB ' +
    'consistency, edge cases, dead code, and whether each ticket is truly done. State a clear ' +
    'verdict: OK or KO, and list blocking issues with file:line.' +
    skillNote('verify-dev') + '\n\nTODO:\n' + todo +
    (devPrep ? '\n\nCODEX CHECKLIST:\n' + JSON.stringify(devPrep) : '') +
    '\n\nWORK:\n' + JSON.stringify(dev) + FINAL_TEXT_NOTE,
    fix === 0 ? 'verify-dev' : 'verify-dev r' + (fix + 1), 'Verify', PLAN_SCHEMA
  )
  // Debate the audit: real bugs vs false positives.
  verify = { plan: await debateGate('verify', 'Verify', 'audit', verify.plan, (obj, reasoning, cur) =>
    claude('Codex debated your audit (which findings are real bugs vs false positives?).\n\n' +
      (reasoning ? "CODEX REASONING:\n" + reasoning + '\n\n' : '') +
      'POINTS:\n- ' + obj.join('\n- ') + '\n\nReturn the reconciled audit with a clear OK/KO ' +
      'verdict and the real blocking issues only.\n\nCURRENT AUDIT:\n' + cur + FINAL_TEXT_NOTE,
      'verify-revise', 'Verify', PLAN_SCHEMA).then((r) => r.plan)) }
  const isKO = /\bKO\b/i.test(verify.plan) && !/\bverdict[:\s]+OK\b/i.test(verify.plan)
  if (!isKO || fix === MAX_FIX_ROUNDS) {
    log(isKO ? 'Verify still KO after ' + (fix + 1) + ' round(s) — shipping with caveats.' : 'Verify OK.')
    break
  }
  log('Verify KO (round ' + (fix + 1) + ') — looping back to Dev to fix blocking issues.')
  phase('Dev')
  dev = await claude(
    'Your implementation was audited and found KO. Fix EVERY blocking issue listed, then report ' +
    'what you changed with file:line.' + skillNote('dev') + claimNote('claude', 'dev-fix') +
    '\n\nAUDIT (blocking issues):\n' + verify.plan + '\n\nTODO:\n' + todo,
    'dev-fix r' + (fix + 1), 'Dev')
}

// === 5. SHIP (build + test skills) → Codex final review → reconcile =========
phase('Ship')
const ship = await claude(
  'Bring the project to a deliverable state: clean build, types, linter, then actively run a ' +
  'test plan (nominal + edge + error cases) with raw proof and a clear verdict.' +
  skillNote('build') + skillNote('test') + '\n\nWORK SO FAR:\n' + JSON.stringify(dev) +
  '\n\nAUDIT:\n' + JSON.stringify(verify),
  'build+test', 'Ship')

let codexReview = null
if (codexAvailable) {
  log('Ship: Codex final review (read-only)…')
  codexReview = await codex(
    'Final review of the SHIPPED state against the plan & todo. Flag correctness bugs, missed ' +
    'edge cases, or unsupported "it works" claims, with file:line. Give your full reasoning.' +
    '\n\nPLAN:\n' + plan + '\n\nTODO:\n' + todo + '\n\nBUILD+TEST:\n' + JSON.stringify(ship),
    'final-review', 'Ship')
  if (typeof codexReview === 'string' && codexReview.trim()) log('Codex final review · ' + codexReview.replace(/\s+/g, ' ').slice(0, 160))
}
const verdict = await claude(
  'Reconcile everything with Codex\'s final review. State the final answer, list which Codex ' +
  'points you accept vs reject (with reasons), and flag anything still unverified.\n\n' +
  'BUILD+TEST:\n' + JSON.stringify(ship) + '\n\nCODEX REVIEW:\n' + JSON.stringify(codexReview),
  'reconcile', 'Ship')

return { task, allowCodex, codexAvailable, runId: RUN_ID, plan, todo, debate: debateLog,
  devPrep, dev, verify, ship, codexReview, verdict }
