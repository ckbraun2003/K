/**
 * D-071 Wave D2 — Skill Creator evaluate + save-to-library.
 *
 * Evaluate: the eval harness reused EXACTLY as POST /api/skills/:id/test —
 * durable pending row, buildEvalPrompt against the DRAFT's content, terminal
 * status → pass/fail via deriveEvalStatus, regression vs the prior completed
 * draft eval. Dispatch FAKED (campaign-s7 supervisor-mock pattern — terminal
 * run rows finalize synchronously through the trackSupervisedRun DB backstop).
 *
 * Save: slug validation (kebab + assertSafeSegment + path confinement), 409 on
 * BOTH collision paths (library dir, registered qualified_key), frontmatter
 * name rewritten to the slug, registry row provenance (qualified_key,
 * source_kind 'k', enabled, est_tokens[_meta], content_hash sha256). Service
 * tests use a TEMP skillsRoot; one route-level 201 test exercises the real
 * library root with a unique slug + full cleanup.
 *
 * Drafts are seeded by direct INSERT (decoupled from D1's authoring dispatch).
 * DB isolated via vitest.config.ts K_DATA_DIR.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { DraftEvalSchema } from '@k/shared'
import { db } from '../src/db.js'

const H = vi.hoisted(() => ({
  /** Per-call overrides consumed FIFO by the fake startRun; empty → terminal 'done'. */
  queue: [] as Array<{ status?: string; reject?: string }>,
  prompts: [] as string[],
  /** When true, the next registerSkill call throws (cleanup-path test). */
  failRegister: false,
}))

// Partial passthrough mock so ONE test can make registerSkill fail inside
// saveDraft's registry transaction (exercising the file-write-then-cleanup
// crash-honesty path). Everything else in skills.js stays real.
vi.mock('../src/skills.js', async () => {
  const actual = await vi.importActual<typeof import('../src/skills.js')>('../src/skills.js')
  return {
    ...actual,
    registerSkill: (opts: Parameters<typeof actual.registerSkill>[0]) => {
      if (H.failRegister) throw new Error('registry down (test)')
      return actual.registerSkill(opts)
    },
  }
})

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  const { randomUUID } = await import('node:crypto')
  return {
    ...actual,
    startRun: vi.fn(async (prompt: string) => {
      H.prompts.push(prompt)
      const cfg = H.queue.shift() ?? {}
      if (cfg.reject) throw new Error(cfg.reject)
      const id = `mock-d2-${randomUUID().slice(0, 8)}`
      db.prepare(
        `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, ?, '.', ?, ?)`,
      ).run(id, prompt, cfg.status ?? 'done', Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

const {
  DraftCollisionError,
  DraftStateError,
  evaluateDraft,
  finalizeDraftEval,
  listDraftEvals,
  parseSkillFrontmatter,
  rewriteFrontmatterName,
  saveDraft,
} = await import('../src/skill-creator.js')

const VALID_MD = [
  '---',
  'name: authored-name',
  'description: A test skill for D2 save.',
  '---',
  '',
  '# Authored Skill',
  '',
  '```bash',
  'echo verification',
  '```',
  '',
  'Body of the skill.',
].join('\n')

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance
let tmpRoot: string

/** Direct-insert a draft row (decoupled from the authoring dispatch). */
function makeDraft(opts: { status?: string; skillMd?: string | null; nameHint?: string | null } = {}): string {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO skill_drafts (id, name_hint, brief, skill_md, revision, status, run_id, saved_skill_id, created_at, updated_at)
     VALUES (?, ?, 'test brief', ?, 0, ?, NULL, NULL, ?, ?)`,
  ).run(id, opts.nameHint ?? null, opts.skillMd === undefined ? VALID_MD : opts.skillMd, opts.status ?? 'ready', now, now)
  return id
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'k-d2-skills-root-'))
})

afterAll(async () => {
  await app.close()
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  // skill_draft_evals cascades with the drafts.
  try { db.prepare(`DELETE FROM skill_drafts`).run() } catch { /* ignore */ }
  try { db.prepare(`DELETE FROM skills WHERE name LIKE 'd2-%'`).run() } catch { /* ignore */ }
  try { db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-d2-%'`).run() } catch { /* ignore */ }
  try { db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-d2-%'`).run() } catch { /* ignore */ }
})

// ─── evaluate ───────────────────────────────────────────────────────────────────

describe('evaluateDraft', () => {
  it('runs the eval harness against the draft content: pending row → pass on done terminal', async () => {
    const draftId = makeDraft()
    const before = H.prompts.length
    const result = await evaluateDraft(draftId)
    expect(result).not.toBeNull()
    expect(result!.runId).toMatch(/^mock-d2-/)
    // The prompt is buildEvalPrompt over the DRAFT content (verdict protocol included).
    const prompt = H.prompts[before]
    expect(prompt).toContain('Body of the skill.')
    expect(prompt).toContain('EVAL VERDICT: PASS')
    // Finalized synchronously by the DB backstop (terminal 'done' → pass).
    const evals = listDraftEvals(draftId)
    expect(evals).toHaveLength(1)
    DraftEvalSchema.parse(evals[0])
    expect(evals[0].id).toBe(result!.evalId)
    expect(evals[0].status).toBe('pass')
    expect(evals[0].runId).toBe(result!.runId)
    expect(evals[0].regression).toBe(false)
    expect(evals[0].completedAt).not.toBeNull()
  })

  it('regression flags only a was-pass → now-fail (baseline = prior completed eval)', async () => {
    const draftId = makeDraft()
    const first = await evaluateDraft(draftId) // done → pass
    H.queue.push({ status: 'error' })
    const second = await evaluateDraft(draftId) // error → fail
    const evals = listDraftEvals(draftId)
    const failed = evals.find(e => e.id === second!.evalId)!
    expect(failed.status).toBe('fail')
    expect(failed.regression).toBe(true)
    expect(failed.baselineEvalId).toBe(first!.evalId)
  })

  it('dispatch throw degrades: finalized fail row + empty runId, 202-shaped return', async () => {
    const draftId = makeDraft()
    H.queue.push({ reject: 'spawn ENOENT' })
    const result = await evaluateDraft(draftId)
    expect(result!.runId).toBe('')
    const row = listDraftEvals(draftId).find(e => e.id === result!.evalId)!
    expect(row.status).toBe('fail')
    expect(row.completedAt).not.toBeNull()
  })

  it('guards: no content → DraftStateError; drafting → DraftStateError; unknown → null', async () => {
    const empty = makeDraft({ skillMd: null, status: 'failed' })
    await expect(evaluateDraft(empty)).rejects.toThrow(DraftStateError)
    const busy = makeDraft({ status: 'drafting' })
    await expect(evaluateDraft(busy)).rejects.toThrow(DraftStateError)
    expect(await evaluateDraft('nope')).toBeNull()
  })

  it('finalizeDraftEval never uses a pending row as baseline', () => {
    const draftId = makeDraft()
    const mk = (status: string, age: number): string => {
      const id = randomUUID()
      db.prepare(
        `INSERT INTO skill_draft_evals (id, draftId, runId, status, regression, baselineEvalId, createdAt, completedAt)
         VALUES (?, ?, NULL, ?, 0, NULL, ?, ?)`,
      ).run(id, draftId, status, Date.now() - age, status === 'pending' ? null : Date.now() - age)
      return id
    }
    const completedPass = mk('pass', 5000)
    mk('pending', 2000) // newer but pending — never a baseline
    const current = mk('pending', 0)
    const res = finalizeDraftEval(current, draftId, 'fail')
    expect(res.baselineEvalId).toBe(completedPass)
    expect(res.regression).toBe(true)
  })

  it('deleting the draft cascades its eval history (FK)', async () => {
    const draftId = makeDraft()
    await evaluateDraft(draftId)
    expect(listDraftEvals(draftId).length).toBeGreaterThan(0)
    db.prepare(`DELETE FROM skill_drafts WHERE id = ?`).run(draftId)
    expect(listDraftEvals(draftId)).toHaveLength(0)
  })
})

// ─── save-to-library (service, temp root) ───────────────────────────────────────

describe('saveDraft', () => {
  it('writes <root>/<slug>/SKILL.md with the frontmatter name REWRITTEN to the slug, registers the row, links the draft', () => {
    const draftId = makeDraft()
    const saved = saveDraft(draftId, 'd2-saved-skill', { skillsRoot: tmpRoot })
    expect(saved).not.toBeNull()
    const { skill } = saved!

    // File written, name corrected, description + body preserved.
    const file = path.join(tmpRoot, 'd2-saved-skill', 'SKILL.md')
    const content = fs.readFileSync(file, 'utf8')
    expect(content).toContain('name: d2-saved-skill')
    expect(content).not.toContain('name: authored-name')
    expect(content).toContain('description: A test skill for D2 save.')
    expect(content).toContain('Body of the skill.')
    expect(parseSkillFrontmatter(content).name).toBe('d2-saved-skill')

    // Registry row: k-native provenance + estimates + hash.
    const row = db.prepare(`SELECT * FROM skills WHERE id = ?`).get(skill.id) as Record<string, unknown>
    expect(row.name).toBe('d2-saved-skill')
    expect(row.qualified_key).toBe('d2-saved-skill')
    expect(row.source_kind).toBe('k')
    expect(Number(row.enabled)).toBe(1)
    expect(row.source).toBe('agent-config/skills/d2-saved-skill/SKILL.md')
    expect(row.type).toBe('skill')
    expect(row.triggerType).toBe('manual')
    expect(row.content_hash).toBe(createHash('sha256').update(content, 'utf8').digest('hex'))
    expect(Number(row.est_tokens)).toBe(Math.ceil(content.length / 4))
    // est_tokens_meta = the raw frontmatter block, opening --- through closing
    // --- INCLUSIVE (run-assets.ts::skillMetaText — the program-wide convention).
    const metaSlice = content.slice(0, content.indexOf('\n---', 3) + 4)
    expect(metaSlice.startsWith('---')).toBe(true)
    expect(metaSlice.endsWith('\n---')).toBe(true)
    expect(Number(row.est_tokens_meta)).toBe(Math.ceil(metaSlice.length / 4))

    // Draft linked; status stays ready.
    const draft = db.prepare(`SELECT saved_skill_id, status FROM skill_drafts WHERE id = ?`).get(draftId) as Record<string, unknown>
    expect(draft.saved_skill_id).toBe(skill.id)
    expect(draft.status).toBe('ready')
  })

  it('a frontmatter name already matching the slug is preserved byte-for-byte', () => {
    const md = VALID_MD.replace('name: authored-name', 'name: d2-exact-name')
    const draftId = makeDraft({ skillMd: md })
    saveDraft(draftId, 'd2-exact-name', { skillsRoot: tmpRoot })
    const content = fs.readFileSync(path.join(tmpRoot, 'd2-exact-name', 'SKILL.md'), 'utf8')
    expect(content).toBe(md)
  })

  it('409 collision: existing library directory', () => {
    fs.mkdirSync(path.join(tmpRoot, 'd2-dir-taken'), { recursive: true })
    const draftId = makeDraft()
    expect(() => saveDraft(draftId, 'd2-dir-taken', { skillsRoot: tmpRoot })).toThrow(DraftCollisionError)
  })

  it('409 collision: existing registered qualified_key — and no directory gets created', () => {
    db.prepare(
      `INSERT INTO skills (id, name, description, type, source, triggerType, schedule, eventTrigger, enabled, createdAt, qualified_key)
       VALUES (?, 'd2-key-taken', NULL, 'skill', 'inline', 'manual', NULL, NULL, 1, ?, 'd2-key-taken')`,
    ).run(randomUUID(), Date.now())
    const draftId = makeDraft()
    expect(() => saveDraft(draftId, 'd2-key-taken', { skillsRoot: tmpRoot })).toThrow(DraftCollisionError)
    expect(fs.existsSync(path.join(tmpRoot, 'd2-key-taken'))).toBe(false)
  })

  it('slug hard gates: traversal, uppercase, spaces, malformed kebab, Windows reserved names all throw and write NOTHING', () => {
    const draftId = makeDraft()
    for (const bad of [
      '../escape', 'a/../b', 'UPPER', 'has space', 'a--b', '-lead', 'trail-', 'dot.dot',
      // Windows reserved device names: kebab-valid, git-for-windows-untrackable.
      'con', 'nul', 'aux', 'prn', 'com1', 'lpt9',
    ]) {
      expect(() => saveDraft(draftId, bad, { skillsRoot: tmpRoot })).toThrow()
    }
    // Nothing new landed in the root (only dirs from earlier tests exist).
    const entries = fs.readdirSync(tmpRoot).sort()
    expect(entries).toEqual(['d2-dir-taken', 'd2-exact-name', 'd2-saved-skill'])
  })

  it('registry-transaction failure removes the just-created dir, leaves no skills row, and rethrows (crash honesty)', () => {
    const draftId = makeDraft()
    H.failRegister = true
    try {
      expect(() => saveDraft(draftId, 'd2-registry-down', { skillsRoot: tmpRoot })).toThrow('registry down (test)')
    } finally {
      H.failRegister = false
    }
    expect(fs.existsSync(path.join(tmpRoot, 'd2-registry-down'))).toBe(false)
    expect(db.prepare(`SELECT id FROM skills WHERE qualified_key = 'd2-registry-down'`).get()).toBeUndefined()
    // The draft stays unlinked and re-savable.
    const draft = db.prepare(`SELECT saved_skill_id, status FROM skill_drafts WHERE id = ?`).get(draftId) as Record<string, unknown>
    expect(draft.saved_skill_id).toBeNull()
    expect(draft.status).toBe('ready')
    const retry = saveDraft(draftId, 'd2-registry-down', { skillsRoot: tmpRoot })
    expect(retry).not.toBeNull()
  })

  it('CRLF draft content saves as normalized LF (no mixed-EOL file)', () => {
    const crlf = VALID_MD.replace(/\n/g, '\r\n')
    const draftId = makeDraft({ skillMd: crlf })
    saveDraft(draftId, 'd2-crlf-skill', { skillsRoot: tmpRoot })
    const content = fs.readFileSync(path.join(tmpRoot, 'd2-crlf-skill', 'SKILL.md'), 'utf8')
    expect(content).not.toContain('\r')
    expect(content).toContain('name: d2-crlf-skill')
    // rewriteFrontmatterName itself normalizes (pure-function lock).
    expect(rewriteFrontmatterName(crlf, 'x-y')).not.toContain('\r')
  })

  it('state gates: not-ready draft and unshaped content → DraftStateError; unknown → null', () => {
    const failed = makeDraft({ status: 'failed' })
    expect(() => saveDraft(failed, 'd2-not-ready', { skillsRoot: tmpRoot })).toThrow(DraftStateError)
    const unshaped = makeDraft({ skillMd: 'just some notes, no frontmatter' })
    expect(() => saveDraft(unshaped, 'd2-unshaped', { skillsRoot: tmpRoot })).toThrow(DraftStateError)
    expect(saveDraft('nope', 'd2-unknown', { skillsRoot: tmpRoot })).toBeNull()
  })

  it('rewriteFrontmatterName touches ONLY the frontmatter name line (a body "name:" line is untouched)', () => {
    const md = ['---', 'name: old', 'description: d.', '---', '', 'name: not-frontmatter', 'body'].join('\n')
    const out = rewriteFrontmatterName(md, 'new-slug')
    expect(out.split('\n')[1]).toBe('name: new-slug')
    expect(out).toContain('name: not-frontmatter')
  })
})

// ─── routes ─────────────────────────────────────────────────────────────────────

describe('routes: evaluate / evals / save', () => {
  it('POST /evaluate → 202 {evalId, runId}; GET /evals lists it; unknown draft → 404', async () => {
    const draftId = makeDraft()
    const res = await app.inject({ method: 'POST', url: `/api/skill-creator/drafts/${draftId}/evaluate`, headers: AUTH })
    expect(res.statusCode).toBe(202)
    const { evalId, runId } = res.json() as { evalId: string; runId: string }
    expect(typeof evalId).toBe('string')
    expect(runId).toMatch(/^mock-d2-/)

    const evals = await app.inject({ method: 'GET', url: `/api/skill-creator/drafts/${draftId}/evals`, headers: AUTH })
    expect(evals.statusCode).toBe(200)
    const parsed = (evals.json() as unknown[]).map(e => DraftEvalSchema.parse(e))
    expect(parsed.some(e => e.id === evalId)).toBe(true)

    expect((await app.inject({ method: 'POST', url: '/api/skill-creator/drafts/nope/evaluate', headers: AUTH })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/skill-creator/drafts/nope/evals', headers: AUTH })).statusCode).toBe(404)
  })

  it('POST /evaluate on a contentless draft → 409', async () => {
    const empty = makeDraft({ skillMd: null, status: 'failed' })
    const res = await app.inject({ method: 'POST', url: `/api/skill-creator/drafts/${empty}/evaluate`, headers: AUTH })
    expect(res.statusCode).toBe(409)
  })

  it('POST /save — 400 bad slug (validated before existence), 404 unknown, 201 real save (cleaned up), then 409 on the same slug', async () => {
    // Validation precedes existence (F-022).
    const bad = await app.inject({ method: 'POST', url: '/api/skill-creator/drafts/nope/save', headers: AUTH, payload: { name: 'Not Kebab' } })
    expect(bad.statusCode).toBe(400)
    // Windows reserved device names 400 at the route layer too (lockstep rule).
    for (const reserved of ['con', 'nul', 'com1']) {
      const res = await app.inject({ method: 'POST', url: '/api/skill-creator/drafts/nope/save', headers: AUTH, payload: { name: reserved } })
      expect(res.statusCode).toBe(400)
    }
    const missing = await app.inject({ method: 'POST', url: '/api/skill-creator/drafts/nope/save', headers: AUTH, payload: { name: 'd2-route-save' } })
    expect(missing.statusCode).toBe(404)

    // Real-root 201: unique slug, full cleanup (file + registry row) in finally.
    const { REPO_ROOT } = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
    const slug = `d2-route-save-${randomUUID().slice(0, 8)}`
    const dir = path.join(REPO_ROOT, 'agent-config', 'skills', slug)
    const draftId = makeDraft()
    try {
      const res = await app.inject({
        method: 'POST', url: `/api/skill-creator/drafts/${draftId}/save`, headers: AUTH, payload: { name: slug },
      })
      expect(res.statusCode).toBe(201)
      const { skill } = res.json() as { skill: { id: string; name: string } }
      expect(skill.name).toBe(slug)
      expect(fs.existsSync(path.join(dir, 'SKILL.md'))).toBe(true)

      // Same slug again → 409 (both collision guards agree).
      const again = await app.inject({
        method: 'POST', url: `/api/skill-creator/drafts/${makeDraft()}/save`, headers: AUTH, payload: { name: slug },
      })
      expect(again.statusCode).toBe(409)
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
      try { db.prepare(`DELETE FROM skills WHERE qualified_key = ?`).run(slug) } catch { /* ignore */ }
    }
  })
})
