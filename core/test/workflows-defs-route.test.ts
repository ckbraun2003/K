/**
 * Named-workflow definitions route — GET/GET:id/PATCH /api/workflows (P5.3b).
 *
 * Registers workflowsRoutes on a bare Fastify app (like workflows-route.test.ts) so no
 * bootstrap/socket/poller runs. DB is isolated via vitest.config.ts K_DATA_DIR. The suite
 * seeds the built-in templates itself, then asserts the list/detail/patch surface and
 * cleans up its rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { db } from '../src/db.js'
import { workflowsRoutes } from '../src/routes/workflows.js'
import { seedWorkflowDefinitions, getWorkflowDef } from '../src/workflow-defs.js'
import type { NamedWorkflow } from '@k/shared'

const SEED_IDS = ['code-wave', 'investigate', 'refactor']

beforeAll(() => {
  seedWorkflowDefinitions()
})

afterAll(() => {
  for (const id of SEED_IDS) db.prepare('DELETE FROM workflow_definitions WHERE id = ?').run(id)
})

async function makeApp() {
  const app = Fastify()
  await app.register(workflowsRoutes)
  return app
}

describe('GET /api/workflows', () => {
  it('returns the seeded templates (seed order)', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/workflows' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as NamedWorkflow[]
      const names = body.map(w => w.name)
      for (const n of ['Code wave', 'Investigate', 'Refactor']) expect(names).toContain(n)
      const codeWave = body.find(w => w.id === 'code-wave')!
      expect(Array.isArray(codeWave.roles)).toBe(true)
      expect(codeWave.roles.length).toBeGreaterThan(0)
      expect(codeWave.crossProject).toBe(false)
    } finally {
      await app.close()
    }
  })
})

describe('GET /api/workflows/:id', () => {
  it('200 for a real template, 404 for an unknown id', async () => {
    const app = await makeApp()
    try {
      const ok = await app.inject({ method: 'GET', url: '/api/workflows/code-wave' })
      expect(ok.statusCode).toBe(200)
      expect((ok.json() as NamedWorkflow).id).toBe('code-wave')

      const miss = await app.inject({ method: 'GET', url: '/api/workflows/nope' })
      expect(miss.statusCode).toBe(404)
      expect((miss.json() as { error: string }).error).toBe('not found')
    } finally {
      await app.close()
    }
  })
})

describe('PATCH /api/workflows/:id', () => {
  it('200 + round-trips a promptScaffold + crossProject patch', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/workflows/refactor',
        payload: { promptScaffold: 'edited {{CHECKLIST}}', crossProject: true },
      })
      expect(res.statusCode).toBe(200)
      const updated = res.json() as NamedWorkflow
      expect(updated.promptScaffold).toBe('edited {{CHECKLIST}}')
      expect(updated.crossProject).toBe(true)
      // The durable row reflects the patch.
      expect(getWorkflowDef('refactor')!.crossProject).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('400 on an empty patch and on an unknown key (.strict)', async () => {
    const app = await makeApp()
    try {
      const empty = await app.inject({ method: 'PATCH', url: '/api/workflows/refactor', payload: {} })
      expect(empty.statusCode).toBe(400)
      expect((empty.json() as { error: string }).error).toBe('empty patch')

      const bad = await app.inject({
        method: 'PATCH',
        url: '/api/workflows/refactor',
        payload: { bogus: 1 },
      })
      expect(bad.statusCode).toBe(400)
      expect((bad.json() as { error: string }).error).toBe('invalid patch')
    } finally {
      await app.close()
    }
  })

  it('404 on an unknown id', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/workflows/no-such-wf',
        payload: { crossProject: true },
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('SEAM: renaming onto an existing name (UNIQUE) is a 400, row UNCHANGED', async () => {
    const app = await makeApp()
    try {
      const before = getWorkflowDef('investigate')!.name
      // Rename `investigate` onto the seeded `Code wave` name → SQLITE_CONSTRAINT_UNIQUE.
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/workflows/investigate',
        payload: { name: 'Code wave' },
      })
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: string }).error).toBe('name already in use')
      // The UPDATE threw before committing — the row keeps its prior name.
      expect(getWorkflowDef('investigate')!.name).toBe(before)
    } finally {
      await app.close()
    }
  })
})
