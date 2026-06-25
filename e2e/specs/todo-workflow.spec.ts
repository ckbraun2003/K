import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gotoApp, captureConsole, type ConsoleSink } from '../lib/harness'

// better-sqlite3 lives only in core/node_modules (e2e isn't a workspace pkg),
// so resolve it from there rather than relying on root hoisting.
type SqliteCtor = new (file: string, opts?: { readonly?: boolean }) => {
  prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown }
  close: () => void
}
const coreRequire = createRequire(path.resolve(__dirname, '..', '..', 'core', 'package.json'))
const Database = coreRequire('better-sqlite3') as SqliteCtor

// ===========================================================================
// todo-workflow — BOUNDED live smoke for the delegation-workflow dispatch.
//
// Proves end-to-end (real browser + real core, plan-mode):
//   - Tasks tab multi-select + action bar + run button text/count
//   - POST /api/projects/:id/tasks/dispatch → 202 { workflowRunId, runId }
//   - selected tasks flip to in_progress (NOT done)
//   - a real run is created with the delegation-loop prompt
//   - a workflow_runs DB row is inserted (status running/terminal, task_ids, run_id)
//   - the run is KILLED immediately so the plan-mode agent does no work
//
// Setup/teardown + DB-side-effect assertions go through the core API directly
// (bearer token) on CORE_PORT; the UI interactions drive the real Vite app.
// ===========================================================================

const CORE_PORT = process.env.CORE_PORT ?? '3001'
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`
const TOKEN = 'dev-token-change-me'
const AUTH = { Authorization: `Bearer ${TOKEN}` }
// The isolated e2e DB the webServer boots core against (K_DATA_DIR derived from CORE_PORT).
const DB_PATH = path.resolve(__dirname, '..', '.data', `core-${CORE_PORT}`, 'k.db')

const UNIQUE = `todo-wf-${Date.now().toString(36)}`

let apiCtx: APIRequestContext
let repoDir = ''
let projectId = ''
let taskIds: string[] = []
let dispatchedRunId: string | null = null
let sink: ConsoleSink

test.describe.configure({ mode: 'serial' })

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/** Throwaway local git repo so the dispatched plan-run is isolated from the K repo. */
function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-todo-wf-'))
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${UNIQUE}\n\nThrowaway smoke fixture.\n`)
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const add = (a, b) => a + b\n')
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'k-smoke@example.com')
  git(dir, 'config', 'user.name', 'K Smoke')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'chore: scaffold smoke fixture')
  return dir
}

test.beforeAll(async () => {
  apiCtx = await pwRequest.newContext({ baseURL: CORE_URL, extraHTTPHeaders: AUTH })

  // 1. Isolated project: register a throwaway local repo.
  repoDir = makeTempRepo()
  const regRes = await apiCtx.post('/api/projects', {
    data: { name: UNIQUE, localPath: repoDir },
  })
  expect(regRes.ok(), `register project failed: ${regRes.status()} ${await regRes.text()}`).toBeTruthy()
  const project = await regRes.json()
  projectId = project.id
  expect(projectId).toBeTruthy()

  // 2a. Seed one task via the API (the UI-add path is exercised in step 2b below).
  const t1 = await apiCtx.post(`/api/projects/${projectId}/tasks`, {
    data: { title: `${UNIQUE} seed task A` },
  })
  expect(t1.ok()).toBeTruthy()
  taskIds.push((await t1.json()).id)
})

test.afterAll(async () => {
  // Teardown: kill any run we started; remove the temp repo. (DB is the isolated
  // e2e DB — we leave the project/tasks rows.)
  if (dispatchedRunId) {
    await apiCtx.post(`/api/runs/${dispatchedRunId}/kill`).catch(() => {})
  }
  await apiCtx.dispose().catch(() => {})
  if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true })
})

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

// ---------------------------------------------------------------------------
// 2b. Seed a SECOND task THROUGH the UI to exercise the existing add path.
// ---------------------------------------------------------------------------
test('add a task through the Tasks-tab UI', async ({ page }) => {
  await gotoApp(page, `#/project/${projectId}/tasks`)

  const input = page.getByPlaceholder('New task title…')
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.fill(`${UNIQUE} ui task B`)
  await page.getByRole('button', { name: /^Add$/ }).click()

  // The new row should render once the tasks query invalidates + refetches.
  await expect(page.getByText(`${UNIQUE} ui task B`)).toBeVisible({ timeout: 15_000 })

  // Capture both ids from the API so DB/integration assertions are id-exact.
  const listRes = await apiCtx.get(`/api/projects/${projectId}/tasks`)
  const tasks: Array<{ id: string; title: string }> = await listRes.json()
  expect(tasks.length).toBeGreaterThanOrEqual(2)
  taskIds = tasks.map(t => t.id)
})

// ---------------------------------------------------------------------------
// 3 + 4. UI: checkboxes, action-bar visibility/count, dispatch, toast, clear.
// ---------------------------------------------------------------------------
test('select → action bar → dispatch → toast → selection clears', async ({ page }) => {
  await gotoApp(page, `#/project/${projectId}/tasks`)

  // Both rows render with their per-row checkboxes.
  for (const id of taskIds) {
    await expect(page.getByTestId(`task-select-${id}`)).toBeVisible({ timeout: 15_000 })
  }

  // Action bar is NOT visible initially.
  await expect(page.getByTestId('tasks-workflow-bar')).toHaveCount(0)
  const runBtn = page.getByTestId('tasks-run-workflow')
  await expect(runBtn).toHaveCount(0)

  // Select all → action bar appears, run button text reflects the count, enabled.
  await page.getByTestId('tasks-select-all').check()
  await expect(page.getByTestId('tasks-workflow-bar')).toBeVisible()
  await expect(runBtn).toBeVisible()
  await expect(runBtn).toHaveText(new RegExp(`Run delegation workflow on ${taskIds.length} selected`))
  await expect(runBtn).toBeEnabled()

  // Dispatch.
  await runBtn.click()

  // Success toast with the "View run →" action.
  const toast = page.getByTestId('tasks-workflow-toast')
  await expect(toast).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('tasks-workflow-toast-link')).toHaveText(/View run/)

  // Selection clears + action bar disappears.
  await expect(page.getByTestId('tasks-workflow-bar')).toHaveCount(0)
  await expect(page.getByTestId('tasks-select-all')).not.toBeChecked()
})

// ---------------------------------------------------------------------------
// 5. Integration assertions via API + DB. Capture the runId, then KILL it.
// ---------------------------------------------------------------------------
test('integration: tasks in_progress, run created with delegation prompt, workflow_run row', async () => {
  // (a) Both dispatched tasks are now in_progress (NOT done).
  const tasksRes = await apiCtx.get(`/api/projects/${projectId}/tasks`)
  const tasks: Array<{ id: string; status: string }> = await tasksRes.json()
  for (const id of taskIds) {
    const t = tasks.find(x => x.id === id)
    expect(t, `task ${id} missing`).toBeTruthy()
    expect(t!.status, `task ${id} should be in_progress, got ${t!.status}`).toBe('in_progress')
  }

  // (b) A new run exists for the project whose prompt carries the delegation wording.
  const runsRes = await apiCtx.get(`/api/runs?projectId=${projectId}`)
  const runs: Array<{ id: string; prompt: string }> = await runsRes.json()
  expect(runs.length).toBeGreaterThanOrEqual(1)
  const wfRun = runs.find(r => /delegation loop/i.test(r.prompt))
  expect(wfRun, 'no run with delegation-loop prompt found').toBeTruthy()
  dispatchedRunId = wfRun!.id

  // (c) DB: exactly one workflow_runs row for the project, run_id set, task_ids has both.
  expect(fs.existsSync(DB_PATH), `e2e DB not found at ${DB_PATH}`).toBeTruthy()
  const db = new Database(DB_PATH, { readonly: true })
  try {
    const rows = db
      .prepare('SELECT id, run_id, task_ids, status FROM workflow_runs WHERE project_id = ?')
      .all(projectId) as Array<{ id: string; run_id: string | null; task_ids: string; status: string }>
    expect(rows.length, `expected exactly 1 workflow_run, got ${rows.length}`).toBe(1)
    const row = rows[0]
    expect(row.run_id, 'workflow_run.run_id should be set').toBe(dispatchedRunId)
    const storedIds: string[] = JSON.parse(row.task_ids)
    for (const id of taskIds) expect(storedIds).toContain(id)
    expect(['running', 'completed', 'failed']).toContain(row.status)
  } finally {
    db.close()
  }

  // (d) KILL the run immediately so the plan-mode agent does no work.
  const killRes = await apiCtx.post(`/api/runs/${dispatchedRunId}/kill`)
  expect(killRes.ok()).toBeTruthy()

  // Bounded best-effort: poll briefly for the workflow_run to finalize (no longer
  // 'running'). Killing is sufficient; finalize lag is acceptable and just noted.
  let finalized = false
  for (let i = 0; i < 10; i++) {
    const db = new Database(DB_PATH, { readonly: true })
    let status = 'running'
    try {
      const r = db.prepare('SELECT status FROM workflow_runs WHERE project_id = ?').get(projectId) as
        | { status: string }
        | undefined
      status = r?.status ?? 'running'
    } finally {
      db.close()
    }
    if (status !== 'running') {
      finalized = true
      break
    }
    await new Promise(res => setTimeout(res, 1000))
  }
  // Don't fail the smoke on finalize lag; record it for the report.
  console.log(`[todo-workflow] workflow_run finalized within ~10s: ${finalized}`)
})

test.afterEach(async () => {
  // Fail-loud: a client SPA can crash at module-eval with no failing assertion.
  expect(sink?.pageErrors ?? [], `page errors: ${sink?.pageErrors.join('\n')}`).toHaveLength(0)
})
