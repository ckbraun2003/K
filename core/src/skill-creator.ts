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
import { createHash, randomUUID } from 'crypto'
import type { DraftEval, Skill, SkillDraft } from '@k/shared'
import { db, eventsDb } from './db.js'
import { getProfile } from './profiles.js'
import { startRun, REPO_ROOT } from './supervisor.js'
import { trackSupervisedRun } from './run-lifecycle.js'
import { buildEvalPrompt, deriveEvalStatus, registerSkill } from './skills.js'
import { assertSafeSegment } from './agent-config.js'
import { estimateTokens } from './token-estimate.js'
import { isPathWithin } from './paths.js'

// ─── State-conflict error (route maps → 409) ─────────────────────────────────

/** A lifecycle-state conflict (e.g. refining while an authoring run is live, or
 *  refining a draft that has no content yet). Routes answer 409. */
export class DraftStateError extends Error {}

/** A save collision: the target slug already exists as a library directory or a
 *  registered qualified key. Routes answer 409. */
export class DraftCollisionError extends Error {}

// ─── Draft evals storage (D2 decision — parallel minimal table) ──────────────
// skill_evals.skillId is NOT NULL REFERENCES skills(id) with foreign_keys=ON, so
// a draft id can never ride that table. The sanctioned alternative is this
// PARALLEL MINIMAL table, column-for-column the skill_evals shape with skillId →
// draftId (FK → skill_drafts, CASCADE: deleting a draft deletes its eval
// history; runId stays a LOOSE ref like skill_drafts.run_id — deleting a run
// never cascades here). db.ts's schema is FROZEN at v7 this program, so the
// table is created HERE, idempotently, on module load — the same
// CREATE-IF-NOT-EXISTS idiom db.ts itself uses for migrated/fixture DBs. The
// conductor may fold this into db.ts's canonical schema at a later version
// bump; the statement is a no-op then.
db.exec(`
  CREATE TABLE IF NOT EXISTS skill_draft_evals (
    id             TEXT PRIMARY KEY,
    draftId        TEXT NOT NULL REFERENCES skill_drafts(id) ON DELETE CASCADE,
    runId          TEXT,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','pass','fail')),
    regression     INTEGER NOT NULL DEFAULT 0,
    baselineEvalId TEXT REFERENCES skill_draft_evals(id) ON DELETE SET NULL,
    createdAt      INTEGER NOT NULL,
    completedAt    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_skill_draft_evals_draft ON skill_draft_evals(draftId);
`)

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
 *  completion lands on a missing row and no-ops (its draft-eval history goes
 *  with it — FK CASCADE). Returns false for unknown ids. */
export function deleteDraft(id: string): boolean {
  return deleteDraftStmt.run(id).changes > 0
}

// ─── Draft evals (D2) — the skill_evals machinery, draft-scoped ──────────────
// SQL mirrors db.ts's skillEvalsDb statements verbatim (skillId → draftId).

const insertDraftEvalStmt = db.prepare(`
  INSERT INTO skill_draft_evals (id, draftId, runId, status, regression, baselineEvalId, createdAt, completedAt)
  VALUES (@id, @draftId, NULL, 'pending', 0, NULL, @createdAt, NULL)
`)
const getDraftEvalStmt = db.prepare(`SELECT * FROM skill_draft_evals WHERE id = ?`)
const listDraftEvalsStmt = db.prepare(`
  SELECT * FROM skill_draft_evals WHERE draftId = ? ORDER BY createdAt DESC LIMIT 20
`)
// Most recent completed (pass|fail) eval for a draft — the regression baseline.
const latestCompletedDraftEvalStmt = db.prepare(`
  SELECT * FROM skill_draft_evals
  WHERE draftId = ? AND status IN ('pass','fail')
  ORDER BY createdAt DESC LIMIT 1
`)
const patchDraftEvalRunIdStmt = db.prepare(`UPDATE skill_draft_evals SET runId = ? WHERE id = ?`)
const updateDraftEvalResultStmt = db.prepare(`
  UPDATE skill_draft_evals SET status = @status, regression = @regression, baselineEvalId = @baselineEvalId, completedAt = @completedAt WHERE id = @id
`)

/** DB row → DraftEval shape (mirrors skills.ts::rowToSkillEval). */
export function rowToDraftEval(r: Record<string, unknown>): DraftEval {
  return {
    id: String(r.id),
    draftId: String(r.draftId),
    runId: r.runId != null ? String(r.runId) : null,
    status: r.status as DraftEval['status'],
    regression: Number(r.regression) === 1,
    baselineEvalId: r.baselineEvalId != null ? String(r.baselineEvalId) : null,
    createdAt: Number(r.createdAt),
    completedAt: r.completedAt != null ? Number(r.completedAt) : null,
  }
}

export function listDraftEvals(draftId: string): DraftEval[] {
  return (listDraftEvalsStmt.all(draftId) as Record<string, unknown>[]).map(rowToDraftEval)
}

/** Finalize a draft eval: regression vs the prior completed baseline, exactly
 *  skills.ts::finalizeSkillEval's rule (was-pass → now-fail). Exported so tests
 *  can drive the result path directly. */
export function finalizeDraftEval(
  evalId: string,
  draftId: string,
  newStatus: 'pass' | 'fail',
): DraftEval {
  const baselineRow = latestCompletedDraftEvalStmt.get(draftId) as
    | Record<string, unknown>
    | undefined
  const baseline =
    baselineRow && String(baselineRow.id) !== evalId ? rowToDraftEval(baselineRow) : null
  const regression = baseline?.status === 'pass' && newStatus === 'fail'
  updateDraftEvalResultStmt.run({
    id: evalId,
    status: newStatus,
    regression: regression ? 1 : 0,
    baselineEvalId: baseline?.id ?? null,
    completedAt: Date.now(),
  })
  return rowToDraftEval(getDraftEvalStmt.get(evalId) as Record<string, unknown>)
}

/** The Skill-shaped stand-in that threads a DRAFT's content through the eval
 *  harness's own prompt builder (skills.ts::buildEvalPrompt). `source` carries
 *  the raw SKILL.md text: readSkillSource treats any non-in-root-path string as
 *  inline content and embeds it verbatim — the same semantics an inline
 *  automation-registry skill gets. */
function pseudoSkillForEval(draft: SkillDraft, skillMd: string): Skill {
  const name = parseSkillFrontmatter(skillMd).name ?? draft.nameHint ?? `draft-${draft.id.slice(0, 8)}`
  return {
    id: draft.id,
    name,
    type: 'skill',
    source: skillMd,
    triggerType: 'manual',
    schedule: null,
    eventTrigger: null,
    enabled: true,
    createdAt: draft.createdAt,
  }
}

/**
 * Evaluate the draft's CURRENT skill_md via the eval harness, exactly as
 * POST /api/skills/:id/test does (skills.ts::runSkillTest): durable 'pending'
 * eval row first; startRun(buildEvalPrompt(...)) — the SAME default-profile
 * dispatch runSkillTest uses; trackSupervisedRun → finalize with
 * deriveEvalStatus(terminal status); dispatch throw degrades to a finalized
 * 'fail' row + runId '' (route stays 202). Guards: no live authoring run (the
 * landing would swap the content under the eval) and content must exist.
 * Returns null for an unknown id.
 */
export async function evaluateDraft(id: string): Promise<{ evalId: string; runId: string } | null> {
  const row = getDraftStmt.get(id) as Record<string, unknown> | undefined
  if (!row) return null
  if (String(row.status) === 'drafting') {
    throw new DraftStateError('an authoring run is in progress — evaluate after it lands')
  }
  const skillMd = row.skill_md != null ? String(row.skill_md) : null
  if (!skillMd) {
    throw new DraftStateError('draft has no content to evaluate yet')
  }

  const evalId = randomUUID()
  insertDraftEvalStmt.run({ id: evalId, draftId: id, createdAt: Date.now() })

  let run
  try {
    run = await startRun(buildEvalPrompt(pseudoSkillForEval(rowToSkillDraft(row), skillMd)))
  } catch (e) {
    console.warn(`[skill-creator] evaluateDraft dispatch failed for ${id}:`, e)
    finalizeDraftEval(evalId, id, 'fail')
    return { evalId, runId: '' }
  }

  trackSupervisedRun(run.id, {
    onStarted: rid => patchDraftEvalRunIdStmt.run(rid, evalId),
    finalize: status => finalizeDraftEval(evalId, id, deriveEvalStatus(status)),
  })

  return { evalId, runId: run.id }
}

// ─── Save to K's library (D2) ────────────────────────────────────────────────

const DEFAULT_SKILLS_ROOT = path.join(REPO_ROOT, 'agent-config', 'skills')

const getSkillByQualifiedKeyStmt = db.prepare(`SELECT id FROM skills WHERE qualified_key = ?`)
// Provenance columns registerSkill's insertSkill statement (db.ts, frozen) does
// not bind — set in the same transaction as the insert.
const updateSkillProvenanceStmt = db.prepare(`
  UPDATE skills SET content_hash = @contentHash, est_tokens = @estTokens, est_tokens_meta = @estTokensMeta WHERE id = @id
`)
const setDraftSavedSkillStmt = db.prepare(`UPDATE skill_drafts SET saved_skill_id = ?, updated_at = ? WHERE id = ?`)

/** Frontmatter fields from a shaped SKILL.md (single-line values, the house
 *  convention; surrounding quotes stripped). Pure + exported for unit-testing. */
export function parseSkillFrontmatter(skillMd: string): { name: string | null; description: string | null } {
  const lines = skillMd.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return { name: null, description: null }
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break }
  }
  if (close === -1) return { name: null, description: null }
  const fm = lines.slice(1, close).join('\n')
  const unquote = (s: string): string => s.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim()
  const name = /^name:[ \t]*(.+)$/m.exec(fm)
  const description = /^description:[ \t]*(.+)$/m.exec(fm)
  return {
    name: name ? unquote(name[1]) : null,
    description: description ? unquote(description[1]) : null,
  }
}

/** Rewrite the frontmatter `name:` field to `slug` (K invariant: the frontmatter
 *  name matches the library directory). Line endings are normalized to LF first
 *  (review fix: without it a CRLF draft saved a MIXED-EOL file — every line CRLF
 *  except the rewritten name line); everything else — description included — is
 *  preserved verbatim. Pure + exported for unit-testing. Precondition:
 *  isSkillMdShaped(skillMd) (the caller gates). */
export function rewriteFrontmatterName(skillMd: string, slug: string): string {
  const lines = skillMd.replace(/\r\n/g, '\n').split('\n')
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break }
  }
  for (let i = 1; i < close; i++) {
    if (/^name:[ \t]*/.test(lines[i])) {
      lines[i] = `name: ${slug}`
      break
    }
  }
  return lines.join('\n')
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Windows reserved device names — they pass BOTH assertSafeSegment and the
 *  kebab regex, and Node on Win11 happily creates `con/SKILL.md`, but
 *  git-for-windows cannot track it (reviewer-verified live). KEEP IN LOCKSTEP
 *  with routes/skill-creator.ts::SaveBodySchema (the same two-layer
 *  route-400 / service-throw duplication as the kebab rule). */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/** The always-loaded metadata slice of a SKILL.md: its frontmatter block,
 *  opening `---` through the closing `---` INCLUSIVE — the SAME rule as
 *  run-assets.ts::skillMetaText, the program-wide est_tokens_meta convention
 *  (conductor ruling). Falls back to the bare name for unshaped content. */
function skillMetaSlice(content: string, fallbackName: string): string {
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3)
    if (end > 0) return content.slice(0, end + 4)
  }
  return fallbackName
}

/**
 * Save a ready draft into K's library: write agent-config/skills/<slug>/SKILL.md
 * (frontmatter name rewritten to the slug) and register the automation-registry
 * row with k-native provenance (source_kind 'k' + enabled 1 via the table
 * defaults, qualified_key = slug via registerSkill, content_hash/est_tokens[_meta]
 * set in the same transaction).
 *
 * Slug trust: assertSafeSegment + a strict kebab-case regex + the Windows
 * reserved-device-name rejection, THEN a guardUnder-style isPathWithin
 * confinement on the resolved dir/file — the slug is never trusted beyond the
 * asserts (spec requirement). Collisions (existing library dir OR existing
 * qualified_key) → DraftCollisionError (409). Not-ready / unshaped content →
 * DraftStateError (409). Unknown id → null (404).
 *
 * Re-saving an ALREADY-SAVED draft under a different slug is deliberate
 * "save-as-new" behavior (conductor product ruling): the first skill stays
 * registered; the draft's saved_skill_id repoints to the newest save.
 *
 * Crash honesty: the file lands before the registry transaction; a failure in
 * the transaction removes the just-created dir and rethrows, so no orphan
 * library entry silently masquerades as registered. `opts.skillsRoot` exists for
 * test confinement only (production callers use the default).
 */
export function saveDraft(
  id: string,
  name: string,
  opts: { skillsRoot?: string } = {},
): { skill: Skill } | null {
  const row = getDraftStmt.get(id) as Record<string, unknown> | undefined
  if (!row) return null
  const skillMd = row.skill_md != null ? String(row.skill_md) : null
  if (String(row.status) !== 'ready' || !skillMd) {
    throw new DraftStateError('draft is not ready to save (no landed content)')
  }
  if (!isSkillMdShaped(skillMd)) {
    throw new DraftStateError('draft content is not a structurally valid SKILL.md (frontmatter name + description, then a body)')
  }

  assertSafeSegment(name, 'skill slug')
  // KEEP IN LOCKSTEP with routes/skill-creator.ts::SaveBodySchema (route = the
  // friendly 400; this = the hard gate for non-route callers).
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`skill slug must be kebab-case: "${name}"`)
  }
  if (WINDOWS_RESERVED_NAMES.test(name)) {
    throw new Error(`skill slug is a reserved Windows device name: "${name}"`)
  }
  const skillsRoot = opts.skillsRoot ?? DEFAULT_SKILLS_ROOT
  const dir = path.join(skillsRoot, name)
  const file = path.join(dir, 'SKILL.md')
  if (!isPathWithin(skillsRoot, dir) || !isPathWithin(dir, file)) {
    throw new Error(`skill slug escapes the library root: "${name}"`)
  }

  if (fs.existsSync(dir)) {
    throw new DraftCollisionError(`a skill directory named '${name}' already exists in K's library`)
  }
  if (getSkillByQualifiedKeyStmt.get(name)) {
    throw new DraftCollisionError(`a registered skill with qualified key '${name}' already exists`)
  }

  const finalContent = rewriteFrontmatterName(skillMd, name)
  const { description } = parseSkillFrontmatter(finalContent)

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, finalContent, 'utf8')

  let skill: Skill
  try {
    const registerWithProvenance = db.transaction((): Skill => {
      const s = registerSkill({
        name,
        description: description ?? undefined,
        type: 'skill',
        source: `agent-config/skills/${name}/SKILL.md`,
        triggerType: 'manual',
      })
      updateSkillProvenanceStmt.run({
        id: s.id,
        contentHash: sha256(finalContent),
        estTokens: estimateTokens(finalContent),
        // Meta = the raw frontmatter block (run-assets.ts::skillMetaText rule —
        // the program-wide est_tokens_meta convention, conductor ruling).
        estTokensMeta: estimateTokens(skillMetaSlice(finalContent, name)),
      })
      return s
    })
    skill = registerWithProvenance()
  } catch (e) {
    // Never leave an unregistered library dir behind masquerading as saved.
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    throw e
  }

  setDraftSavedSkillStmt.run(skill.id, Date.now(), id)
  return { skill }
}
