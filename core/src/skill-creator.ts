/**
 * Skill Creator — drafts lifecycle (D-071).
 *
 * A draft moves: brief → AUTHORING RUN → skill_md ('ready') → manual edits /
 * refine revisions → (D2) evaluate via the eval harness → save into K's library
 * (agent-config/skills/). A draft is honest about its state: it is NOT a saved
 * skill until /save lands it.
 *
 * DISPATCH PATTERN (mirrors skills.ts::runSkillTest — durable row first, degrade
 * on throw, trackSupervisedRun for completion):
 *   1. the skill_drafts row is inserted/flipped to 'drafting' BEFORE the await,
 *      so it survives a dispatch crash;
 *   2. `await startRun(prompt, { profile })` under the SECRETARY tier — resolved
 *      via getProfile('k-secretary'), the existing seeded-profile lookup
 *      (routes/chief.ts precedent). FAIL-CLOSED: if that profile is missing we
 *      mark the draft 'failed' rather than silently escalating to the default
 *      ORCHESTRATOR profile (D-054 fail-closed narrowing). startAgentRun is
 *      deliberately NOT used: its AgentRunTrigger enum has no honest value for
 *      an authoring run (shared/ is frozen this wave) and an agent_runs row
 *      would feed the chief-wake heuristics;
 *   3. on the run's terminal event (run-lifecycle.ts::trackSupervisedRun — the
 *      same subscribe+DB-backstop seam every supervised tracker rides), extract
 *      the SKILL.md from the run's recorded output and land it.
 *
 * AUTHORING GUIDANCE DELIVERY: the skill-authoring asset
 * (agent-config/skills/skill-authoring/SKILL.md) is EMBEDDED into the authoring
 * prompt. startRun has no per-run skill-mounting seam (skills mount via tier
 * bundles only), and mounting it on the secretary BUNDLE would leak it into
 * every K front-door run — so prompt embedding is the honest delivery today.
 *
 * REVISION SEMANTICS (SkillDraftSchema: "0 = the initial draft"): the initial
 * authoring completion keeps revision 0; every refine completion and every
 * manual edit bumps +1.
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { SkillDraft } from '@k/shared'
import { db, eventsDb } from './db.js'
import { getProfile } from './profiles.js'
import { startRun, REPO_ROOT } from './supervisor.js'
import { trackSupervisedRun } from './run-lifecycle.js'

// ─── State-conflict error (route maps → 409) ─────────────────────────────────

/** A lifecycle-state conflict (e.g. refining while an authoring run is live, or
 *  refining a draft that has no content yet). Routes answer 409. */
export class DraftStateError extends Error {}

// ─── Prepared statements (module load — skills.ts::patchSkillRunId precedent) ─

const insertDraftStmt = db.prepare(`
  INSERT INTO skill_drafts (id, name_hint, brief, skill_md, revision, status, run_id, saved_skill_id, created_at, updated_at)
  VALUES (@id, @nameHint, @brief, NULL, 0, 'drafting', NULL, NULL, @createdAt, @updatedAt)
`)
const getDraftStmt = db.prepare(`SELECT * FROM skill_drafts WHERE id = ?`)
const listDraftsStmt = db.prepare(`SELECT * FROM skill_drafts ORDER BY created_at DESC`)
const deleteDraftStmt = db.prepare(`DELETE FROM skill_drafts WHERE id = ?`)
const patchDraftRunIdStmt = db.prepare(`UPDATE skill_drafts SET run_id = ?, updated_at = ? WHERE id = ?`)
const setDraftStatusStmt = db.prepare(`UPDATE skill_drafts SET status = ?, updated_at = ? WHERE id = ?`)
const setDraftContentStmt = db.prepare(`
  UPDATE skill_drafts SET skill_md = @skillMd, revision = @revision, status = @status, updated_at = @updatedAt WHERE id = @id
`)

// The run's FINAL result text: the turn-end `result` stream line is persisted as
// the events row of type 'usage' with `text` = the whole final output
// (providers.ts::parseClaudeLine). Fallback: the last non-empty assistant event
// (eventsDb.latestAssistantEvent — the F-075 "conclusion" statement).
const latestResultTextStmt = db.prepare(
  `SELECT text FROM events WHERE run_id = ? AND type = 'usage' AND text IS NOT NULL AND length(text) > 0 ORDER BY seq DESC LIMIT 1`,
)

// ─── Row mapping ─────────────────────────────────────────────────────────────

export function rowToSkillDraft(r: Record<string, unknown>): SkillDraft {
  return {
    id: String(r.id),
    nameHint: r.name_hint != null ? String(r.name_hint) : null,
    brief: String(r.brief),
    skillMd: r.skill_md != null ? String(r.skill_md) : null,
    revision: Number(r.revision),
    status: r.status as SkillDraft['status'],
    runId: r.run_id != null ? String(r.run_id) : null,
    savedSkillId: r.saved_skill_id != null ? String(r.saved_skill_id) : null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

// ─── Authoring prompts (pure, exported for unit-testing) ─────────────────────

const AUTHORING_GUIDE_PATH = path.join(REPO_ROOT, 'agent-config', 'skills', 'skill-authoring', 'SKILL.md')

/** The skill-authoring guidance embedded into every authoring prompt. Missing/
 *  unreadable asset degrades to '' (the prompt's own output contract still
 *  stands) with a warn — never a throw at dispatch time. */
export function readAuthoringGuide(): string {
  try {
    return fs.readFileSync(AUTHORING_GUIDE_PATH, 'utf8')
  } catch {
    console.warn(`[skill-creator] authoring guide missing/unreadable at ${AUTHORING_GUIDE_PATH} — proceeding without it`)
    return ''
  }
}

/** The strict output contract both authoring prompts end with. The extractor
 *  (extractSkillMd) is the tolerant counterpart of this contract. */
const OUTPUT_CONTRACT = [
  `OUTPUT CONTRACT (strict):`,
  `- Respond with ONLY the complete SKILL.md document: YAML frontmatter with exactly`,
  `  \`name\` (kebab-case) and \`description\` (one line, trigger-rich), then the body.`,
  `- Wrap the document in a single fenced code block (\`\`\`markdown ... \`\`\`).`,
  `  No prose before or after the block.`,
  `- Do NOT create files or directories; your text output IS the deliverable.`,
].join('\n')

function guideSection(): string {
  const guide = readAuthoringGuide()
  if (!guide.trim()) return ''
  return [`<authoring-guide>`, guide.trim(), `</authoring-guide>`, ``].join('\n')
}

export function buildAuthoringPrompt(opts: { brief: string; nameHint: string | null }): string {
  const parts = [
    `You are authoring a NEW K skill (a SKILL.md document) from an operator brief.`,
    ``,
    guideSection(),
    `Operator brief:`,
    `"""`,
    opts.brief,
    `"""`,
    ``,
  ]
  if (opts.nameHint) {
    parts.push(`Suggested skill name: "${opts.nameHint}" — use it (normalized to kebab-case) unless it misrepresents the skill.`, ``)
  }
  parts.push(OUTPUT_CONTRACT)
  return parts.join('\n')
}

export function buildRefinePrompt(opts: { skillMd: string; feedback: string }): string {
  return [
    `You are REFINING an existing K skill draft (SKILL.md) per operator feedback.`,
    ``,
    guideSection(),
    `Current draft:`,
    `"""`,
    opts.skillMd,
    `"""`,
    ``,
    `Operator feedback:`,
    `"""`,
    opts.feedback,
    `"""`,
    ``,
    `Produce the FULL revised SKILL.md (never a diff), applying the feedback while`,
    `preserving what already works.`,
    ``,
    OUTPUT_CONTRACT,
  ].join('\n')
}

// ─── SKILL.md extraction (pure, exported for unit-testing) ───────────────────

/** Minimal structural validity: frontmatter open/close `---` lines, a non-empty
 *  `name:` and `description:` inside, and a non-empty body after. */
export function isSkillMdShaped(text: string): boolean {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return false
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break }
  }
  if (close === -1) return false
  const fm = lines.slice(1, close).join('\n')
  if (!/^name:\s*\S/m.test(fm) || !/^description:\s*\S/m.test(fm)) return false
  return lines.slice(close + 1).join('\n').trim().length > 0
}

/**
 * Extract the SKILL.md document from an authoring run's output. Tolerant of the
 * shapes real runs produce:
 *   - the document fenced in ```markdown ... ``` (with or without an info
 *     string), INCLUDING documents that contain their own inner code fences —
 *     the outer closer is the LAST bare ``` line, so an inner fence never
 *     truncates the document;
 *   - the document raw (no fence), with or without stray prose before it;
 *   - prose containing `---` horizontal rules before the document (each `---`
 *     line is tried as a start; among structurally valid candidates the LAST
 *     one wins — the deliverable is the CONCLUDING artifact per the output
 *     contract, so an earlier frontmatter-shaped block (e.g. an illustrative
 *     "anti-pattern" example, or the pre-revision doc quoted in a refine run's
 *     preamble) never shadows the real document (review HIGH fix).
 * Returns null when no structurally valid SKILL.md is present (caller marks the
 * draft 'failed').
 */
export function extractSkillMd(output: string | null | undefined): string | null {
  if (!output) return null
  const lines = output.replace(/\r\n/g, '\n').split('\n')
  let lastValid: string | null = null
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '---') continue
    // Inside a fence? (odd count of fence-opener lines above this point.)
    const fenceOpensAbove = lines.slice(0, i).filter(l => l.trimStart().startsWith('```')).length
    let end = lines.length
    if (fenceOpensAbove % 2 === 1) {
      // Fenced document: the outer closer is the LAST bare ``` line after i —
      // inner fences close pairwise before it, so this never truncates mid-doc.
      for (let j = lines.length - 1; j > i; j--) {
        if (lines[j].trim() === '```') { end = j; break }
      }
    }
    const candidate = lines.slice(i, end).join('\n').trim()
    if (isSkillMdShaped(candidate)) lastValid = candidate
  }
  return lastValid
}

/** The recorded output text of a finished run: the final `result` line (events
 *  type 'usage'), else the last non-empty assistant message. Null when the run
 *  recorded no text (e.g. killed before any output). */
export function readRunOutputText(runId: string): string | null {
  const usage = latestResultTextStmt.get(runId) as { text?: string } | undefined
  if (usage?.text) return String(usage.text)
  const asst = eventsDb.latestAssistantEvent.get(runId) as { text?: string } | undefined
  return asst?.text ? String(asst.text) : null
}

// ─── Authoring-run completion ────────────────────────────────────────────────

/**
 * Land a finished authoring run on its draft. Non-'done' terminal (error/killed/
 * interrupted) or extraction failure → status 'failed' with the run still linked
 * (run_id) so the UI can open the console; success → skill_md + 'ready', bumping
 * the revision only for refine runs (initial completion keeps revision 0 — the
 * shared schema's "0 = the initial draft"). A draft deleted mid-run is a no-op
 * (the UPDATE matches 0 rows). Exported so tests can drive the completion path
 * directly.
 */
export function finalizeAuthoringRun(
  draftId: string,
  runId: string,
  terminalStatus: string,
  opts: { bumpRevision: boolean },
): void {
  const row = getDraftStmt.get(draftId) as Record<string, unknown> | undefined
  if (!row) return // deleted mid-run — nothing to land
  const now = Date.now()
  if (terminalStatus !== 'done') {
    setDraftStatusStmt.run('failed', now, draftId)
    return
  }
  const skillMd = extractSkillMd(readRunOutputText(runId))
  if (skillMd == null) {
    console.warn(`[skill-creator] draft ${draftId}: run ${runId} completed but no SKILL.md could be extracted`)
    setDraftStatusStmt.run('failed', now, draftId)
    return
  }
  setDraftContentStmt.run({
    id: draftId,
    skillMd,
    revision: Number(row.revision) + (opts.bumpRevision ? 1 : 0),
    status: 'ready',
    updatedAt: now,
  })
}

/**
 * Dispatch one authoring run for a draft (create or refine). The draft row is
 * already in status 'drafting'. Degrades on dispatch failure: the draft flips
 * 'failed' and no error escapes (mirrors runSkillTest — the route stays 202 and
 * the failure is visible/durable).
 */
async function dispatchAuthoringRun(
  draftId: string,
  prompt: string,
  opts: { bumpRevision: boolean },
): Promise<void> {
  let run
  try {
    const profile = getProfile('k-secretary')
    if (!profile) throw new Error(`secretary profile 'k-secretary' not found — refusing to escalate to the default profile`)
    run = await startRun(prompt, { profile })
  } catch (e) {
    console.warn(`[skill-creator] authoring dispatch failed for draft ${draftId}:`, e)
    setDraftStatusStmt.run('failed', Date.now(), draftId)
    return
  }
  trackSupervisedRun(run.id, {
    onStarted: rid => patchDraftRunIdStmt.run(rid, Date.now(), draftId),
    finalize: status => finalizeAuthoringRun(draftId, run.id, status, opts),
  })
}

// ─── Drafts service ──────────────────────────────────────────────────────────

export function getDraft(id: string): SkillDraft | null {
  const row = getDraftStmt.get(id) as Record<string, unknown> | undefined
  return row ? rowToSkillDraft(row) : null
}

export function listDrafts(): SkillDraft[] {
  return (listDraftsStmt.all() as Record<string, unknown>[]).map(rowToSkillDraft)
}

/** Insert the draft (status 'drafting') and dispatch the initial authoring run.
 *  Always returns the durable draft — a failed dispatch returns it as 'failed'. */
export async function createDraft(opts: { brief: string; nameHint?: string | null }): Promise<SkillDraft> {
  const id = randomUUID()
  const now = Date.now()
  insertDraftStmt.run({ id, nameHint: opts.nameHint ?? null, brief: opts.brief, createdAt: now, updatedAt: now })
  await dispatchAuthoringRun(
    id,
    buildAuthoringPrompt({ brief: opts.brief, nameHint: opts.nameHint ?? null }),
    { bumpRevision: false },
  )
  // Non-null: the row was just inserted and only an explicit DELETE removes it.
  return getDraft(id)!
}

/**
 * Manual edit: replace skill_md and bump the revision. Status derives from the
 * CONTENT alone: non-blank → 'ready', blank → 'failed' — a draft must never
 * claim 'ready' with nothing to evaluate/save (review HIGH fix: keeping the
 * prior status let a blanked ready draft stay 'ready'). Rejected while an
 * authoring run is live (the run's completion would clobber the manual edit).
 * Returns null for an unknown id.
 */
export function updateDraft(id: string, patch: { skillMd: string }): SkillDraft | null {
  const row = getDraftStmt.get(id) as Record<string, unknown> | undefined
  if (!row) return null
  if (String(row.status) === 'drafting') {
    throw new DraftStateError('an authoring run is in progress — wait for it to finish before editing')
  }
  const hasContent = patch.skillMd.trim().length > 0
  setDraftContentStmt.run({
    id,
    skillMd: patch.skillMd,
    revision: Number(row.revision) + 1,
    status: hasContent ? 'ready' : 'failed',
    updatedAt: Date.now(),
  })
  return getDraft(id)
}

/**
 * Refine: dispatch a new authoring run against the CURRENT skill_md + operator
 * feedback; the completion bumps the revision. Requires content to refine and no
 * live authoring run (DraftStateError → 409 at the route). A failed refine keeps
 * the prior skill_md (status 'failed' is honest about the last action; a manual
 * edit or a successful refine restores 'ready'). Returns null for an unknown id.
 */
export async function refineDraft(id: string, feedback: string): Promise<SkillDraft | null> {
  const row = getDraftStmt.get(id) as Record<string, unknown> | undefined
  if (!row) return null
  if (String(row.status) === 'drafting') {
    throw new DraftStateError('an authoring run is already in progress')
  }
  const skillMd = row.skill_md != null ? String(row.skill_md) : null
  if (!skillMd) {
    throw new DraftStateError('draft has no content to refine yet')
  }
  setDraftStatusStmt.run('drafting', Date.now(), id)
  await dispatchAuthoringRun(id, buildRefinePrompt({ skillMd, feedback }), { bumpRevision: true })
  return getDraft(id)
}

/** Delete a draft. Deleting one with a live authoring run is safe: the tracked
 *  completion lands on a missing row and no-ops. Returns false for unknown ids. */
export function deleteDraft(id: string): boolean {
  return deleteDraftStmt.run(id).changes > 0
}
