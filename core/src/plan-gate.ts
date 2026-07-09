/**
 * E-02 Plan Gate — the pure prompt/parse layer (no process, no FS; unit-testable
 * without any supervisor machinery).
 *
 * Scaffold contract: the plan turn must reply with ONE fenced ```json block
 * matching PlanDocSchema and touch NO files. parsePlanDoc takes the LAST fence
 * (models often echo the example first); an unparseable turn degrades to
 * plan=null with the raw text preserved — the operator still sees and can
 * approve it (buildPlanContinuation's null leg).
 *
 * mount≠grant rider: this scaffold is PROMPT TEXT ONLY — it must never name or
 * imply tools/servers/skills beyond what the run's tier already mounts (it
 * names none; reviewers keep it that way).
 */
import { PlanDocSchema, type PlanDoc } from '@k/shared'
import { agentProfilesDb } from './db.js'

export const PLAN_SCAFFOLD = `

────────────────────────────────────────
PLANNING PHASE — do not implement yet.
Investigate the codebase as needed (read-only), then END YOUR REPLY with exactly ONE fenced \`\`\`json code block — nothing after it — matching:
{
  "steps": [{ "title": "<imperative step>", "detail": "<how / where (optional)>" }],
  "files": ["<paths you expect to create or modify>"],
  "risk": "low" | "medium" | "high",
  "notes": "<assumptions, open questions (optional)>"
}
Do NOT create, modify, or delete any files in this phase. Your plan will be reviewed by the operator; you will be resumed and told to proceed.
────────────────────────────────────────`

export function buildPlanScaffold(prompt: string): string {
  return prompt + PLAN_SCAFFOLD
}

const FENCE_RE = /```json\s*\n([\s\S]*?)```/g

export function parsePlanDoc(text: string): PlanDoc | null {
  let last: string | null = null
  for (const m of text.matchAll(FENCE_RE)) last = m[1]
  if (last == null) return null
  try {
    const parsed = PlanDocSchema.safeParse(JSON.parse(last))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function buildPlanContinuation(plan: PlanDoc | null, edited: boolean): string {
  if (!plan) {
    return 'Your plan is approved. Proceed with the implementation now, following the plan you presented.'
  }
  const steps = plan.steps.map((s, i) => `${i + 1}. ${s.title}${s.detail ? ` — ${s.detail}` : ''}`).join('\n')
  const files = plan.files.length > 0 ? `\nFiles in scope:\n${plan.files.map(f => `- ${f}`).join('\n')}` : ''
  const head = edited
    ? 'Your plan was REVIEWED AND EDITED by the operator. Execute EXACTLY this revised plan (it supersedes your original):'
    : 'Your plan is approved. Execute exactly this plan:'
  return `${head}\n\n${steps}${files}${plan.notes ? `\n\nNotes: ${plan.notes}` : ''}\n\nProceed with the implementation now.`
}

/** D-084: the tier default rides the org-default orchestrator profile's plan_gate
 *  column — operator dispatches without an explicit planGate resolve through it. */
export const ORG_DEFAULT_PROFILE_ID = 'default-orchestrator'

export function orgDefaultPlanGate(): boolean {
  const row = agentProfilesDb.getProfileRow.get(ORG_DEFAULT_PROFILE_ID) as { plan_gate?: number } | undefined
  return row?.plan_gate === 1
}
