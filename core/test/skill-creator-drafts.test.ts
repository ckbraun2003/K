/**
 * D-071 Wave D1 — Skill Creator drafts: store CRUD, revision/status transitions,
 * authoring dispatch (FAKED — no real agent spawns), SKILL.md extraction
 * (fenced / raw / inner fences / prose noise / failures), and the
 * /api/skill-creator route contract (validation-first ordering, 404/409/204).
 *
 * The supervisor is mocked (campaign-s7-skills-eval precedent): the fake
 * startRun records the prompt, inserts a REAL runs row already at a TERMINAL
 * status plus its output event — so trackSupervisedRun's DB backstop finalizes
 * the draft synchronously inside the awaited service call (deterministic, no
 * polling). DB is isolated via vitest.config.ts K_DATA_DIR.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { SkillDraftSchema } from '@k/shared'
import { db } from '../src/db.js'

// Shared between the hoisted mock factory and the tests.
const H = vi.hoisted(() => {
  const VALID_MD = [
    '---',
    'name: test-skill',
    'description: A test skill for D1 authoring.',
    '---',
    '',
    '# Test Skill',
    '',
    'Do the thing.',
  ].join('\n')
  return {
    VALID_MD,
    DEFAULT_OUTPUT: '```markdown\n' + VALID_MD + '\n```',
    /** Per-call overrides consumed FIFO by the fake startRun; empty → default
     *  (terminal 'done' + the valid fenced doc as the usage-event text). */
    queue: [] as Array<{ status?: string; output?: string | null; eventType?: string; reject?: string }>,
    prompts: [] as string[],
    /** When true, getProfile('k-secretary') resolves null (fail-closed guard test). */
    hideSecretary: false,
  }
})

// Partial passthrough mock so ONE test can make the seeded secretary profile
// vanish without touching the real DB row (FK-safe; the seed stays intact for
// every other test file sharing the fixture DB).
vi.mock('../src/profiles.js', async () => {
  const actual = await vi.importActual<typeof import('../src/profiles.js')>('../src/profiles.js')
  return {
    ...actual,
    getProfile: (id: string) =>
      H.hideSecretary && id === 'k-secretary' ? null : actual.getProfile(id),
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
      const id = `mock-d1-${randomUUID().slice(0, 8)}`
      db.prepare(
        `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, ?, '.', ?, ?)`,
      ).run(id, prompt, cfg.status ?? 'done', Date.now())
      const output = cfg.output === undefined ? H.DEFAULT_OUTPUT : cfg.output
      if (output != null) {
        db.prepare(
          `INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, 0, ?, ?, ?)`,
        ).run(randomUUID(), id, cfg.eventType ?? 'usage', Date.now(), output)
      }
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

const {
  buildAuthoringPrompt,
  buildRefinePrompt,
  createDraft,
  deleteDraft,
  extractSkillMd,
  finalizeAuthoringRun,
  getDraft,
  isSkillMdShaped,
  listDrafts,
  refineDraft,
  updateDraft,
  DraftStateError,
} = await import('../src/skill-creator.js')
const { getProfile, seedProfiles } = await import('../src/profiles.js')

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance

beforeAll(async () => {
  // The fail-closed dispatch requires the seeded secretary profile.
  if (!getProfile('k-secretary')) seedProfiles()
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
  // skill_drafts is written only by this lane's tests; events FK → runs, so
  // events go first.
  try { db.prepare(`DELETE FROM skill_drafts`).run() } catch { /* ignore */ }
  try { db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-d1-%'`).run() } catch { /* ignore */ }
  try { db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-d1-%'`).run() } catch { /* ignore */ }
})

// ─── extraction (pure) ──────────────────────────────────────────────────────────

describe('extractSkillMd', () => {
  it('extracts a fenced document (```markdown info string)', () => {
    expect(extractSkillMd('```markdown\n' + H.VALID_MD + '\n```')).toBe(H.VALID_MD)
  })

  it('extracts a fenced document with no info string', () => {
    expect(extractSkillMd('```\n' + H.VALID_MD + '\n```')).toBe(H.VALID_MD)
  })

  it('extracts a raw (unfenced) document', () => {
    expect(extractSkillMd(H.VALID_MD)).toBe(H.VALID_MD)
  })

  it('tolerates prose before and after a fenced document', () => {
    const out = 'Here is your skill:\n\n```markdown\n' + H.VALID_MD + '\n```\n\nLet me know!'
    expect(extractSkillMd(out)).toBe(H.VALID_MD)
  })

  it('an inner code fence never truncates the document (outer closer = last bare ```)', () => {
    const inner = [
      '---',
      'name: inner-fence',
      'description: Contains its own code fences.',
      '---',
      '',
      '# Inner',
      '',
      '```bash',
      'echo hi',
      '```',
      '',
      'Tail line after the inner fence.',
    ].join('\n')
    expect(extractSkillMd('```markdown\n' + inner + '\n```')).toBe(inner)
  })

  it('skips a `---` horizontal rule in leading prose and finds the real document', () => {
    const out = 'Intro\n---\nmore prose\n\n' + H.VALID_MD
    expect(extractSkillMd(out)).toBe(H.VALID_MD)
  })

  it('the LAST valid candidate wins — an illustrative example block never shadows the real document (review HIGH)', () => {
    const bogus = ['---', 'name: helper', 'description: misc utilities', '---', 'some non-informative body'].join('\n')
    const out = [
      'Anti-pattern example (do NOT do this):',
      '',
      '```',
      bogus,
      '```',
      '',
      "Now here's my actual authored skill:",
      '',
      '```markdown',
      H.VALID_MD,
      '```',
    ].join('\n')
    expect(extractSkillMd(out)).toBe(H.VALID_MD)
    // Raw (unfenced) variant of the same shape.
    expect(extractSkillMd(bogus + '\n\nThe real one:\n\n' + H.VALID_MD)).toBe(H.VALID_MD)
  })

  it('null/empty/whitespace → null', () => {
    expect(extractSkillMd(null)).toBeNull()
    expect(extractSkillMd('')).toBeNull()
    expect(extractSkillMd('   \n  ')).toBeNull()
  })

  it('missing name or description or body → null', () => {
    expect(extractSkillMd('---\ndescription: x\n---\nbody')).toBeNull()
    expect(extractSkillMd('---\nname: x\n---\nbody')).toBeNull()
    expect(extractSkillMd('---\nname: x\ndescription: y\n---\n   ')).toBeNull()
    expect(extractSkillMd('I could not produce a skill, sorry.')).toBeNull()
  })

  it('isSkillMdShaped: unclosed frontmatter → false', () => {
    expect(isSkillMdShaped('---\nname: x\ndescription: y\nbody with no close')).toBe(false)
  })
})

// ─── prompts (pure) ─────────────────────────────────────────────────────────────

describe('authoring prompts', () => {
  it('buildAuthoringPrompt embeds the brief, the guide, and the output contract', () => {
    const p = buildAuthoringPrompt({ brief: 'MY-UNIQUE-BRIEF-77', nameHint: null })
    expect(p).toContain('MY-UNIQUE-BRIEF-77')
    expect(p).toContain('<authoring-guide>') // asset embedded (no per-run mounting seam)
    expect(p).toContain('OUTPUT CONTRACT')
    expect(p).not.toContain('Suggested skill name')
  })

  it('buildAuthoringPrompt carries the nameHint when present', () => {
    const p = buildAuthoringPrompt({ brief: 'b', nameHint: 'my-hinted-name' })
    expect(p).toContain('"my-hinted-name"')
  })

  it('buildAuthoringPrompt appends retry guidance only when feedback is given', () => {
    const withFb = buildAuthoringPrompt({ brief: 'b', nameHint: null, feedback: 'FB-RETRY-1' })
    expect(withFb).toContain('FB-RETRY-1')
    expect(withFb).toContain('previous authoring attempt failed')
    const without = buildAuthoringPrompt({ brief: 'b', nameHint: null })
    expect(without).not.toContain('previous authoring attempt failed')
  })

  it('buildRefinePrompt embeds current content + feedback + contract', () => {
    const p = buildRefinePrompt({ skillMd: 'CURRENT-DOC-XYZ', feedback: 'FEEDBACK-ABC' })
    expect(p).toContain('CURRENT-DOC-XYZ')
    expect(p).toContain('FEEDBACK-ABC')
    expect(p).toContain('OUTPUT CONTRACT')
  })
})

// ─── createDraft lifecycle (service, faked dispatch) ────────────────────────────

describe('createDraft', () => {
  it('happy path: authoring run lands → skillMd extracted, status ready, revision 0, runId linked', async () => {
    const before = H.prompts.length
    const draft = await createDraft({ brief: 'Write a skill that does X.', nameHint: 'do-x' })
    // The wire shape is the shared schema, exactly.
    SkillDraftSchema.parse(draft)
    expect(draft.status).toBe('ready')
    expect(draft.skillMd).toBe(H.VALID_MD)
    expect(draft.revision).toBe(0) // initial completion keeps "0 = the initial draft"
    expect(draft.runId).toMatch(/^mock-d1-/)
    expect(draft.savedSkillId).toBeNull()
    // The dispatched prompt embeds the brief + the hint.
    const prompt = H.prompts[before]
    expect(prompt).toContain('Write a skill that does X.')
    expect(prompt).toContain('"do-x"')
  })

  it('raw (unfenced) run output is extracted too', async () => {
    H.queue.push({ output: H.VALID_MD })
    const draft = await createDraft({ brief: 'raw output brief' })
    expect(draft.status).toBe('ready')
    expect(draft.skillMd).toBe(H.VALID_MD)
  })

  it('falls back to the last assistant event when no result line was recorded', async () => {
    H.queue.push({ output: H.DEFAULT_OUTPUT, eventType: 'assistant' })
    const draft = await createDraft({ brief: 'assistant fallback brief' })
    expect(draft.status).toBe('ready')
    expect(draft.skillMd).toBe(H.VALID_MD)
  })

  it('extraction failure → status failed, run stays linked, no content', async () => {
    H.queue.push({ output: 'no skill here, just chatter' })
    const draft = await createDraft({ brief: 'bad output brief' })
    expect(draft.status).toBe('failed')
    expect(draft.skillMd).toBeNull()
    expect(draft.runId).toMatch(/^mock-d1-/) // console linkable
  })

  it('non-done terminal (error) → status failed', async () => {
    H.queue.push({ status: 'error', output: null })
    const draft = await createDraft({ brief: 'error run brief' })
    expect(draft.status).toBe('failed')
  })

  it('killed terminal → status failed even if output existed', async () => {
    H.queue.push({ status: 'killed', output: H.DEFAULT_OUTPUT })
    const draft = await createDraft({ brief: 'killed run brief' })
    expect(draft.status).toBe('failed')
  })

  it('dispatch throw degrades: durable draft marked failed, no exception escapes', async () => {
    H.queue.push({ reject: 'spawn ENOENT: claude not found' })
    const draft = await createDraft({ brief: 'dispatch failure brief' })
    expect(draft.status).toBe('failed')
    expect(draft.runId).toBeNull()
    // Durable: re-readable from the store.
    expect(getDraft(draft.id)?.status).toBe('failed')
  })

  it('FAIL-CLOSED: missing k-secretary profile → draft failed, nothing dispatched (never escalates to the default profile)', async () => {
    H.hideSecretary = true
    try {
      const calls = H.prompts.length
      const draft = await createDraft({ brief: 'no secretary profile' })
      expect(draft.status).toBe('failed')
      expect(draft.runId).toBeNull()
      expect(H.prompts.length).toBe(calls) // startRun never invoked
    } finally {
      H.hideSecretary = false
    }
  })
})

// ─── manual edit / refine / delete transitions ──────────────────────────────────

describe('updateDraft (manual edit)', () => {
  it('bumps revision and lands ready; unknown id → null', async () => {
    const draft = await createDraft({ brief: 'to edit' })
    const edited = updateDraft(draft.id, { skillMd: H.VALID_MD + '\n\nEdited.' })
    expect(edited?.revision).toBe(draft.revision + 1)
    expect(edited?.status).toBe('ready')
    expect(edited?.skillMd).toContain('Edited.')
    expect(updateDraft('nope', { skillMd: 'x' })).toBeNull()
  })

  it('restores ready on a failed draft (recovery path after a failed refine)', async () => {
    H.queue.push({ output: 'garbage' })
    const draft = await createDraft({ brief: 'failed then edited' })
    expect(draft.status).toBe('failed')
    const edited = updateDraft(draft.id, { skillMd: H.VALID_MD })
    expect(edited?.status).toBe('ready')
  })

  it('a blank edit lands failed, never ready (nothing to evaluate/save)', async () => {
    H.queue.push({ output: 'garbage' })
    const draft = await createDraft({ brief: 'blank edit target' })
    const edited = updateDraft(draft.id, { skillMd: '   ' })
    expect(edited?.status).toBe('failed')
    expect(edited?.revision).toBe(draft.revision + 1)
  })

  it('blanking an already-READY draft flips it to failed — a draft never claims ready with blank content (review HIGH)', async () => {
    const draft = await createDraft({ brief: 'ready then blanked' })
    expect(draft.status).toBe('ready')
    const edited = updateDraft(draft.id, { skillMd: '  \n  ' })
    expect(edited?.status).toBe('failed')
    expect(edited?.skillMd).toBe('  \n  ')
  })

  it('rejects while an authoring run is live (would clobber the landing)', async () => {
    const draft = await createDraft({ brief: 'edit while drafting' })
    db.prepare(`UPDATE skill_drafts SET status = 'drafting' WHERE id = ?`).run(draft.id)
    expect(() => updateDraft(draft.id, { skillMd: 'x' })).toThrow(DraftStateError)
  })
})

describe('refineDraft', () => {
  it('dispatches with current content + feedback via buildRefinePrompt; completion bumps the revision (behavior lock)', async () => {
    const draft = await createDraft({ brief: 'to refine' })
    expect(draft.revision).toBe(0)
    const before = H.prompts.length
    const refined = await refineDraft(draft.id, 'tighten the verification section')
    expect(refined?.revision).toBe(1)
    expect(refined?.status).toBe('ready')
    const prompt = H.prompts[before]
    expect(prompt).toContain('tighten the verification section')
    expect(prompt).toContain(H.VALID_MD) // refines the CURRENT document
    // The REFINE prompt, not the initial authoring prompt.
    expect(prompt).toContain('REFINING an existing K skill draft')
    expect(prompt).not.toContain('authoring a NEW K skill')
  })

  it('RETRY-OF-INITIAL: a failed FIRST attempt refines as a fresh authoring run (brief + feedback; revision stays 0)', async () => {
    H.queue.push({ output: 'garbage' }) // first attempt: extraction failure
    const draft = await createDraft({ brief: 'RETRY-BRIEF-42', nameHint: 'retry-skill' })
    expect(draft.status).toBe('failed')
    expect(draft.skillMd).toBeNull()

    const before = H.prompts.length
    const retried = await refineDraft(draft.id, 'RETRY-FEEDBACK-99') // default mock: valid output
    expect(retried?.status).toBe('ready')
    expect(retried?.skillMd).toBe(H.VALID_MD)
    expect(retried?.revision).toBe(0) // retry of the INITIAL draft, not a refinement

    const prompt = H.prompts[before]
    expect(prompt).toContain('RETRY-BRIEF-42')          // rebuilt from the brief
    expect(prompt).toContain('"retry-skill"')            // nameHint carried
    expect(prompt).toContain('RETRY-FEEDBACK-99')        // operator guidance appended
    expect(prompt).toContain('authoring a NEW K skill')  // the INITIAL prompt shape
    expect(prompt).not.toContain('REFINING an existing K skill draft')
  })

  it('a failed refine keeps the prior content, status failed', async () => {
    const draft = await createDraft({ brief: 'refine fails' })
    H.queue.push({ status: 'error', output: null })
    const refined = await refineDraft(draft.id, 'feedback')
    expect(refined?.status).toBe('failed')
    expect(refined?.skillMd).toBe(H.VALID_MD) // never lose landed content
    expect(refined?.revision).toBe(0)
  })

  it('contentless NON-failed draft → DraftStateError; live run → DraftStateError; unknown → null', async () => {
    // A 'ready' row with null content cannot arise from the public flows — forge
    // it to lock the residual guard (the failed-null shape now RETRIES instead).
    const anomalous = await createDraft({ brief: 'anomalous ready-null' })
    db.prepare(`UPDATE skill_drafts SET skill_md = NULL WHERE id = ?`).run(anomalous.id)
    await expect(refineDraft(anomalous.id, 'f')).rejects.toThrow(DraftStateError)

    const ok = await createDraft({ brief: 'live run' })
    db.prepare(`UPDATE skill_drafts SET status = 'drafting' WHERE id = ?`).run(ok.id)
    await expect(refineDraft(ok.id, 'f')).rejects.toThrow(DraftStateError)

    expect(await refineDraft('nope', 'f')).toBeNull()
  })
})

describe('deleteDraft / finalize race', () => {
  it('deletes; unknown → false; a landing on a deleted draft no-ops', async () => {
    const draft = await createDraft({ brief: 'to delete' })
    expect(deleteDraft(draft.id)).toBe(true)
    expect(getDraft(draft.id)).toBeNull()
    expect(deleteDraft(draft.id)).toBe(false)
    // Completion for a deleted draft must not throw or resurrect anything.
    expect(() => finalizeAuthoringRun(draft.id, 'mock-d1-gone', 'done', { bumpRevision: false })).not.toThrow()
    expect(getDraft(draft.id)).toBeNull()
  })

  it('listDrafts returns newest first and maps the shared shape', async () => {
    const a = await createDraft({ brief: 'older' })
    db.prepare(`UPDATE skill_drafts SET created_at = created_at - 60000 WHERE id = ?`).run(a.id)
    const b = await createDraft({ brief: 'newer' })
    const all = listDrafts()
    for (const d of all) SkillDraftSchema.parse(d)
    const ids = all.map(d => d.id)
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id))
  })
})

// ─── route contract ─────────────────────────────────────────────────────────────

describe('routes /api/skill-creator/drafts', () => {
  it('POST → 202 with the shared draft shape', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/skill-creator/drafts', headers: AUTH,
      payload: { brief: 'route brief', nameHint: 'route-skill' },
    })
    expect(res.statusCode).toBe(202)
    const draft = SkillDraftSchema.parse(res.json())
    expect(draft.brief).toBe('route brief')
    expect(draft.status).toBe('ready') // fake run completes synchronously
  })

  it('POST validation: missing brief → 400; unknown field → 400 (strict)', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/skill-creator/drafts', headers: AUTH, payload: {} })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toBe('validation failed')
    const extra = await app.inject({
      method: 'POST', url: '/api/skill-creator/drafts', headers: AUTH,
      payload: { brief: 'x', bogus: true },
    })
    expect(extra.statusCode).toBe(400)
  })

  it('GET list + GET by id + 404', async () => {
    const created = SkillDraftSchema.parse((await app.inject({
      method: 'POST', url: '/api/skill-creator/drafts', headers: AUTH, payload: { brief: 'listable' },
    })).json())
    const list = await app.inject({ method: 'GET', url: '/api/skill-creator/drafts', headers: AUTH })
    expect(list.statusCode).toBe(200)
    expect((list.json() as { id: string }[]).some(d => d.id === created.id)).toBe(true)
    const one = await app.inject({ method: 'GET', url: `/api/skill-creator/drafts/${created.id}`, headers: AUTH })
    expect(one.statusCode).toBe(200)
    const missing = await app.inject({ method: 'GET', url: '/api/skill-creator/drafts/nope', headers: AUTH })
    expect(missing.statusCode).toBe(404)
  })

  it('PATCH: body validated BEFORE existence (F-022) — bad body + unknown id → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/skill-creator/drafts/nope', headers: AUTH, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('PATCH: valid body + unknown id → 404; valid edit → 200', async () => {
    const missing = await app.inject({
      method: 'PATCH', url: '/api/skill-creator/drafts/nope', headers: AUTH, payload: { skillMd: 'x' },
    })
    expect(missing.statusCode).toBe(404)
    const created = SkillDraftSchema.parse((await app.inject({
      method: 'POST', url: '/api/skill-creator/drafts', headers: AUTH, payload: { brief: 'patch me' },
    })).json())
    const patched = await app.inject({
      method: 'PATCH', url: `/api/skill-creator/drafts/${created.id}`, headers: AUTH,
      payload: { skillMd: H.VALID_MD + '\nPatched.' },
    })
    expect(patched.statusCode).toBe(200)
    expect(SkillDraftSchema.parse(patched.json()).revision).toBe(created.revision + 1)
  })

  it('PATCH while a run is live → 409 with a human-readable error', async () => {
    const created = SkillDraftSchema.parse((await app.inject({
      method: 'POST', url: '/api/skill-creator/drafts', headers: AUTH, payload: { brief: 'busy' },
    })).json())
    db.prepare(`UPDATE skill_drafts SET status = 'drafting' WHERE id = ?`).run(created.id)
    const res = await app.inject({
      method: 'PATCH', url: `/api/skill-creator/drafts/${created.id}`, headers: AUTH,
      payload: { skillMd: 'x' },
    })
    expect(res.statusCode).toBe(409)
    expect(typeof res.json().error).toBe('string')
  })

  it('POST /refine → 202; empty feedback → 400; unknown → 404; no content → 409', async () => {
    const created = SkillDraftSchema.parse((await app.inject({
      method: 'POST', url: '/api/skill-creator/drafts', headers: AUTH, payload: { brief: 'refinable' },
    })).json())
    const ok = await app.inject({
      method: 'POST', url: `/api/skill-creator/drafts/${created.id}/refine`, headers: AUTH,
      payload: { feedback: 'be stricter' },
    })
    expect(ok.statusCode).toBe(202)
    expect(SkillDraftSchema.parse(ok.json()).revision).toBe(1)

    const bad = await app.inject({
      method: 'POST', url: `/api/skill-creator/drafts/${created.id}/refine`, headers: AUTH, payload: { feedback: '' },
    })
    expect(bad.statusCode).toBe(400)

    const missing = await app.inject({
      method: 'POST', url: '/api/skill-creator/drafts/nope/refine', headers: AUTH, payload: { feedback: 'x' },
    })
    expect(missing.statusCode).toBe(404)

    // A FAILED first attempt is retryable via /refine (retry-of-initial) → 202,
    // and the retry lands the draft ready at revision 0.
    H.queue.push({ output: 'garbage' })
    const failedFirst = SkillDraftSchema.parse((await app.inject({
      method: 'POST', url: '/api/skill-creator/drafts', headers: AUTH, payload: { brief: 'retry via route' },
    })).json())
    expect(failedFirst.status).toBe('failed')
    const retried = await app.inject({
      method: 'POST', url: `/api/skill-creator/drafts/${failedFirst.id}/refine`, headers: AUTH, payload: { feedback: 'try again' },
    })
    expect(retried.statusCode).toBe(202)
    const retriedDraft = SkillDraftSchema.parse(retried.json())
    expect(retriedDraft.status).toBe('ready')
    expect(retriedDraft.revision).toBe(0)

    // The residual 409: contentless in a NON-failed status (forged — cannot
    // arise from the public flows).
    const anomalous = SkillDraftSchema.parse((await app.inject({
      method: 'POST', url: '/api/skill-creator/drafts', headers: AUTH, payload: { brief: 'anomalous route' },
    })).json())
    db.prepare(`UPDATE skill_drafts SET skill_md = NULL WHERE id = ?`).run(anomalous.id)
    const conflict = await app.inject({
      method: 'POST', url: `/api/skill-creator/drafts/${anomalous.id}/refine`, headers: AUTH, payload: { feedback: 'x' },
    })
    expect(conflict.statusCode).toBe(409)
  })

  it('DELETE → 204 then 404', async () => {
    const created = SkillDraftSchema.parse((await app.inject({
      method: 'POST', url: '/api/skill-creator/drafts', headers: AUTH, payload: { brief: 'deletable' },
    })).json())
    const del = await app.inject({ method: 'DELETE', url: `/api/skill-creator/drafts/${created.id}`, headers: AUTH })
    expect(del.statusCode).toBe(204)
    const gone = await app.inject({ method: 'DELETE', url: `/api/skill-creator/drafts/${created.id}`, headers: AUTH })
    expect(gone.statusCode).toBe(404)
  })
})
