# Phase 0 Finish + Command Deck UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Phase 0 (gateway e2e, dashboard) by rebuilding the web UI as the approved Command Deck on the precision-minimal design language (with deliberate flare: ambient glow, live pulses, animated numerals, spring transitions), and pull forward three Phase 1 items: metrics summary, project registry API, and a first GitHubProvider with polling.

**Architecture:** Core gains three thin modules behind existing seams (`metrics`, `projects`, `github` — the GitHubProvider seam from bible §4) plus a generic `broadcast` channel on the EventBus for `github_update` WS messages. Web is rebuilt around a hash-routed Shell (icon sidebar · top bar · stage · activity strip); existing RunConsole/DocViewer/RunList survive restyled. Pure logic lives in dependency-free modules (`*-parse.ts`, `metrics.ts`) so it's unit-testable without DB or subprocesses.

**Tech Stack:** Existing stack (Fastify, better-sqlite3, execa, React 18, Tailwind, framer-motion, TanStack Query). New: `vitest` (core tests), `@fontsource-variable/inter` + `@fontsource/jetbrains-mono` (self-hosted fonts). No router lib — a 20-line hash-route hook.

**Design reference:** `artifacts/bible/sections/06-dashboard-ux.md` (tokens, zones, rules). Spec: `docs/superpowers/specs/2026-06-10-jarvis-system-refinement-design.md`.

---

## File Structure

```
core/
├── src/
│   ├── bible-parse.ts        NEW  pure: frontmatter parser + roadmap phase math (moved from bible.ts)
│   ├── bible.ts              MOD  imports from bible-parse.ts
│   ├── events.ts             MOD  + broadcast(msg)/onBroadcast(fn) generic WS channel
│   ├── metrics.ts            NEW  pure: summarizeRuns(rows, now) → MetricsSummary
│   ├── github-parse.ts       NEW  pure: parsePrList/parseCiRuns (gh --json → typed)
│   ├── github.ts             NEW  GhCliProvider (execa gh) + cache + 60s poller
│   ├── projects.ts           NEW  validateRegistration + registerProject (path|clone)
│   ├── supervisor.ts         MOD  fix REPO_ROOT bug ('../../../' → '../../')
│   ├── db.ts                 MOD  + github_cache table
│   ├── index.ts              MOD  register new routes, forward broadcasts, start poller
│   └── routes/
│       ├── metrics.ts        NEW  GET /api/metrics/summary
│       └── projects.ts       NEW  POST/GET /api/projects, GET /api/projects/:id/github
├── test/
│   ├── bible-parse.test.ts   NEW
│   ├── metrics.test.ts       NEW
│   ├── github-parse.test.ts  NEW
│   └── projects.test.ts      NEW
└── vitest.config.ts          NEW

shared/src/types.ts           MOD  + MetricsSummary, PrInfo, CiRunInfo schemas

web/src/
├── index.css                 MOD  precision-minimal tokens + flare layer (glow, pulse, ambient)
├── main.tsx                  MOD  font imports
├── App.tsx                   MOD  → renders Shell
├── lib/
│   ├── api.ts                MOD  + metrics, projects, github endpoints
│   └── route.ts              NEW  useHashRoute() hook
├── shell/
│   ├── Shell.tsx             NEW  frame grid: sidebar · topbar · stage · strip
│   ├── Sidebar.tsx           NEW  icon rail, 9 destinations (4 live, 5 phase-gated)
│   ├── TopBar.tsx            NEW  view title + ⌘K trigger + connection dot
│   ├── CommandBar.tsx        NEW  ⌘K modal: dispatch run + fuzzy navigate (replaces PromptBar)
│   └── ActivityStrip.tsx     NEW  live runs + day totals
├── pages/
│   ├── Home.tsx              NEW  metrics row + project cards
│   ├── RunsPage.tsx          NEW  RunList + RunConsole side by side
│   ├── DocsPage.tsx          NEW  artifact rail + DocViewer
│   └── ProjectsPage.tsx      NEW  registry list + register dialog + GitHub status
├── components/
│   ├── MetricCard.tsx        NEW  animated numeral + sparkline
│   ├── Sparkline.tsx         NEW  tiny SVG polyline
│   ├── ProjectCard.tsx       NEW  health dot, CI state, PRs, last activity
│   ├── RunList.tsx           MOD  restyle to tokens
│   ├── RunConsole.tsx        MOD  restyle to tokens
│   ├── DocViewer.tsx         MOD  restyle; default to html view
│   └── PromptBar.tsx         DEL  superseded by shell/CommandBar.tsx
└── pages/Dashboard.tsx       DEL  superseded by Shell + pages
```

**Conventions for every task:** TypeScript strict, ESM with `.js` import suffixes in core, existing code style (no semicolons in web, as-is in core). Commit after each task. All `pnpm` commands run from repo root `C:\Users\ckbra\desktop\k`.

---

### Task 1: Fix REPO_ROOT bug + vitest setup

`supervisor.ts` computes `REPO_ROOT = path.join(__dirname, '../../../')` which is `Desktop\`, not the repo (same bug just fixed for `ARTIFACTS_DIR`). Agent runs would execute outside the repo. Fix it, then stand up vitest so every later task can be test-first.

**Files:**
- Modify: `core/src/supervisor.ts:24`
- Modify: `core/package.json`
- Create: `core/vitest.config.ts`
- Create: `core/test/smoke.test.ts`

- [ ] **Step 1: Fix REPO_ROOT**

In `core/src/supervisor.ts` replace:

```ts
const REPO_ROOT = path.join(__dirname, '../../../')
```

with:

```ts
// core/src/* and core/dist/* are both two levels below the repo root
const REPO_ROOT = path.join(__dirname, '../../')
```

- [ ] **Step 2: Add vitest**

Run: `pnpm --filter @k/core add -D vitest@^1.6.0`

In `core/package.json` scripts add: `"test": "vitest run"`

- [ ] **Step 3: Create `core/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Create `core/test/smoke.test.ts`**

```ts
import { describe, it, expect } from 'vitest'

describe('vitest harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @k/core test` → Expected: 1 passed
Run: `pnpm --filter @k/core typecheck` → Expected: clean

- [ ] **Step 6: Commit**

```bash
git add core/src/supervisor.ts core/package.json core/vitest.config.ts core/test/smoke.test.ts pnpm-lock.yaml
git commit -m "fix: REPO_ROOT escaping repo; add vitest harness"
```

---

### Task 2: Extract + test bible parsing (pure module)

`parseFrontmatter` and the roadmap-checkbox math are pure but locked inside `bible.ts` (which imports the DB on load). Extract to a dependency-free module and test it.

**Files:**
- Create: `core/src/bible-parse.ts`
- Modify: `core/src/bible.ts` (remove the two functions, import them)
- Test: `core/test/bible-parse.test.ts`

- [ ] **Step 1: Write the failing test** — `core/test/bible-parse.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { parseFrontmatter, roadmapPhases } from '../src/bible-parse.js'

describe('parseFrontmatter', () => {
  it('parses keys and strips quotes', () => {
    const { meta, body } = parseFrontmatter('---\ntitle: Vision\nicon: "◈"\nstatus: stable\n---\nHello')
    expect(meta.title).toBe('Vision')
    expect(meta.icon).toBe('◈')
    expect(body).toBe('Hello')
  })

  it('handles CRLF line endings', () => {
    const { meta, body } = parseFrontmatter('---\r\ntitle: X\r\n---\r\nbody')
    expect(meta.title).toBe('X')
    expect(body).toBe('body')
  })

  it('returns raw body when no frontmatter', () => {
    const { meta, body } = parseFrontmatter('just markdown')
    expect(meta).toEqual({})
    expect(body).toBe('just markdown')
  })
})

describe('roadmapPhases', () => {
  it('counts checkboxes per ## heading', () => {
    const md = '## Phase 0\n- [x] a\n- [ ] b\n## Phase 1\n- [x] c\n- [x] d\n- [ ] e\n'
    expect(roadmapPhases(md)).toEqual([
      { name: 'Phase 0', done: 1, total: 2 },
      { name: 'Phase 1', done: 2, total: 3 },
    ])
  })

  it('skips headings without checkboxes and strips markdown emphasis', () => {
    const md = '## Notes\nprose only\n## Phase 0 — Foundation *(current)*\n- [X] done\n'
    expect(roadmapPhases(md)).toEqual([{ name: 'Phase 0 — Foundation (current)', done: 1, total: 1 }])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @k/core test` → Expected: FAIL (cannot resolve `../src/bible-parse.js`)

- [ ] **Step 3: Create `core/src/bible-parse.ts`** (moved verbatim from bible.ts, plus the phases function extracted from `liveRoadmapProgress`)

```ts
/** Pure parsing helpers for the bible compiler — no DB, no fs. */

export interface RoadmapPhase { name: string; done: number; total: number }

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return { meta, body: m[2] }
}

/** Checkbox progress per "## …" heading; headings with zero checkboxes are omitted. */
export function roadmapPhases(sectionMd: string): RoadmapPhase[] {
  const phases: RoadmapPhase[] = []
  let current: RoadmapPhase | null = null
  for (const line of sectionMd.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) {
      current = { name: h[1].replace(/\*/g, ''), done: 0, total: 0 }
      phases.push(current)
      continue
    }
    if (current && /^\s*-\s*\[[ xX]\]/.test(line)) {
      current.total++
      if (/^\s*-\s*\[[xX]\]/.test(line)) current.done++
    }
  }
  return phases.filter(p => p.total > 0)
}
```

- [ ] **Step 4: Update `core/src/bible.ts`**

Delete its local `parseFrontmatter` function and the phase-counting loop inside `liveRoadmapProgress`. Add import and rewrite `liveRoadmapProgress` to render only:

```ts
import { parseFrontmatter, roadmapPhases } from './bible-parse.js'
```

```ts
/** Progress bars per "## Phase …" heading, computed from that phase's checkbox counts. */
function liveRoadmapProgress(sectionMd: string): string {
  const withItems = roadmapPhases(sectionMd)
  if (withItems.length === 0) return placeholder('roadmap')
  const bars = withItems.map(p => {
    const pct = Math.round((p.done / p.total) * 100)
    return `<div class="phase-row">
      <span class="phase-name">${escHtml(p.name)}</span>
      <span class="phase-bar"><span class="phase-fill" style="width:${pct}%"></span></span>
      <span class="phase-pct mono">${p.done}/${p.total}</span>
    </div>`
  }).join('')
  return `<div class="roadmap-progress">${bars}</div>`
}
```

(The `BibleSection` interface and everything else in bible.ts stays.)

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @k/core test` → Expected: all PASS
Run: `pnpm --filter @k/core typecheck` → Expected: clean

- [ ] **Step 6: Verify the compiler still works**

Run: `pnpm --filter @k/core exec tsx --eval "import('./src/bible.ts').then(m => m.compileBible()).then(r => console.log(r.sections.length))"`
Expected: `[bible] compiled 9 sections → …` then `9`

- [ ] **Step 7: Commit**

```bash
git add core/src/bible-parse.ts core/src/bible.ts core/test/bible-parse.test.ts
git commit -m "refactor: extract pure bible parsing helpers + tests"
```

---

### Task 3: EventBus broadcast channel

`github_update` (and later `verification_update`) messages need to reach WS clients. Add a generic broadcast channel to the EventBus and forward it in the WS gateway.

**Files:**
- Modify: `core/src/events.ts`
- Modify: `core/src/index.ts` (WS handler)
- Test: `core/test/events.test.ts`

- [ ] **Step 1: Write the failing test** — `core/test/events.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { eventBus } from '../src/events.js'
import type { WsMessage } from '@k/shared'

describe('eventBus.broadcast', () => {
  it('delivers messages to subscribers and unsubscribes cleanly', () => {
    const seen: WsMessage[] = []
    const unsub = eventBus.onBroadcast(m => seen.push(m))
    const msg: WsMessage = { type: 'github_update', projectId: 'p1', kind: 'ci', payload: { ok: true } }
    eventBus.broadcast(msg)
    unsub()
    eventBus.broadcast(msg)
    expect(seen).toEqual([msg])
  })

  it('a throwing subscriber does not break others', () => {
    const seen: WsMessage[] = []
    const unsubBad = eventBus.onBroadcast(() => { throw new Error('boom') })
    const unsubGood = eventBus.onBroadcast(m => seen.push(m))
    eventBus.broadcast({ type: 'ping' })
    unsubBad(); unsubGood()
    expect(seen).toEqual([{ type: 'ping' }])
  })
})
```

Note: importing `events.js` opens the dev SQLite file via `db.js` — that's fine; broadcast doesn't touch tables.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @k/core test` → Expected: FAIL (`onBroadcast` is not a function)

- [ ] **Step 3: Implement in `core/src/events.ts`**

Add `WsMessage` to the type import, then add inside the `eventBus` object:

```ts
import type { AgentEvent, Run, WsMessage } from '@k/shared'
```

```ts
  // ── generic broadcast (github_update, verification_update, …) ────────────
  // Not persisted — transient UI state. Durable facts live in their own tables.

  onBroadcast(fn: (m: WsMessage) => void): () => void {
    broadcastSubs.add(fn)
    return () => broadcastSubs.delete(fn)
  },

  broadcast(m: WsMessage): void {
    for (const sub of broadcastSubs) {
      try { sub(m) } catch { /* subscriber errors must not kill the bus */ }
    }
  },
```

with the set declared next to the others:

```ts
const broadcastSubs = new Set<(m: WsMessage) => void>()
```

- [ ] **Step 4: Forward in the WS gateway** — `core/src/index.ts`, inside the `/ws` handler next to `unsubEvent`/`unsubRun`:

```ts
  const unsubBroadcast = eventBus.onBroadcast((m: WsMessage) => send(m))
```

and in the `close` handler add `unsubBroadcast()`.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @k/core test` and `pnpm --filter @k/core typecheck` → Expected: PASS / clean

- [ ] **Step 6: Commit**

```bash
git add core/src/events.ts core/src/index.ts core/test/events.test.ts
git commit -m "feat: generic EventBus broadcast channel for WS messages"
```

---

### Task 4: Metrics summary (shared schema → pure calc → route)

Feeds the Home metrics row and the activity strip day totals.

**Files:**
- Modify: `shared/src/types.ts`
- Create: `core/src/metrics.ts`
- Create: `core/src/routes/metrics.ts`
- Modify: `core/src/index.ts` (register route)
- Test: `core/test/metrics.test.ts`

- [ ] **Step 1: Add schema to `shared/src/types.ts`** (after the VerificationReport block)

```ts
// ─── Metrics ────────────────────────────────────────────────────────────────

export const DailyMetricSchema = z.object({
  date: z.string(),            // YYYY-MM-DD (local)
  runs: z.number().int(),
  tokens: z.number().int(),
  costUsd: z.number(),
})
export type DailyMetric = z.infer<typeof DailyMetricSchema>

export const MetricsSummarySchema = z.object({
  today: DailyMetricSchema,
  activeRuns: z.number().int(),
  totalRuns: z.number().int(),
  daily: z.array(DailyMetricSchema),  // oldest → newest, last 14 days incl. today
})
export type MetricsSummary = z.infer<typeof MetricsSummarySchema>
```

- [ ] **Step 2: Write the failing test** — `core/test/metrics.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { summarizeRuns, type RunRow } from '../src/metrics.js'

const DAY = 86_400_000
// Fixed "now": 2026-06-10T12:00 local
const now = new Date(2026, 5, 10, 12, 0, 0).getTime()

function row(p: Partial<RunRow>): RunRow {
  return { created_at: now, status: 'done', tokens_in: 100, tokens_out: 50, cost_usd: 0.01, ...p }
}

describe('summarizeRuns', () => {
  it('aggregates today and counts active runs', () => {
    const rows = [
      row({}),                                  // today, done
      row({ status: 'running', cost_usd: 0 }),  // today, active
      row({ created_at: now - DAY }),           // yesterday
    ]
    const s = summarizeRuns(rows, now)
    expect(s.today.runs).toBe(2)
    expect(s.today.tokens).toBe(300)
    expect(s.activeRuns).toBe(1)
    expect(s.totalRuns).toBe(3)
  })

  it('produces 14 daily buckets oldest→newest with zero-fill', () => {
    const s = summarizeRuns([row({ created_at: now - 3 * DAY })], now)
    expect(s.daily).toHaveLength(14)
    expect(s.daily[13].date).toBe('2026-06-10')
    expect(s.daily[10].runs).toBe(1)
    expect(s.daily[0].runs).toBe(0)
  })

  it('counts queued as active', () => {
    const s = summarizeRuns([row({ status: 'queued' })], now)
    expect(s.activeRuns).toBe(1)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @k/core test` → Expected: FAIL (cannot resolve `../src/metrics.js`)

- [ ] **Step 4: Create `core/src/metrics.ts`** (pure — no db import)

```ts
/** Pure metrics aggregation over run rows — no DB, no clock. */

import type { MetricsSummary, DailyMetric } from '@k/shared'

export interface RunRow {
  created_at: number
  status: string
  tokens_in: number
  tokens_out: number
  cost_usd: number
}

const DAY = 86_400_000

function localDateKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function summarizeRuns(rows: RunRow[], now: number): MetricsSummary {
  const buckets = new Map<string, DailyMetric>()
  for (let i = 13; i >= 0; i--) {
    const key = localDateKey(now - i * DAY)
    buckets.set(key, { date: key, runs: 0, tokens: 0, costUsd: 0 })
  }
  let activeRuns = 0
  for (const r of rows) {
    if (r.status === 'running' || r.status === 'queued') activeRuns++
    const b = buckets.get(localDateKey(r.created_at))
    if (!b) continue // older than the window
    b.runs++
    b.tokens += r.tokens_in + r.tokens_out
    b.costUsd += r.cost_usd
  }
  const daily = [...buckets.values()]
  return {
    today: daily[daily.length - 1],
    activeRuns,
    totalRuns: rows.length,
    daily,
  }
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @k/core test` → Expected: PASS

- [ ] **Step 6: Create `core/src/routes/metrics.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import { db } from '../db.js'
import { summarizeRuns, type RunRow } from '../metrics.js'

export async function metricsRoutes(app: FastifyInstance) {
  // GET /api/metrics/summary — today + active + 14-day series
  app.get('/api/metrics/summary', async (_req, reply) => {
    const rows = db.prepare(
      `SELECT created_at, status, tokens_in, tokens_out, cost_usd FROM runs`
    ).all() as RunRow[]
    return reply.send(summarizeRuns(rows, Date.now()))
  })
}
```

- [ ] **Step 7: Register in `core/src/index.ts`**

```ts
import { metricsRoutes } from './routes/metrics.js'
```

next to the other registrations:

```ts
await app.register(metricsRoutes)
```

- [ ] **Step 8: Typecheck both packages**

Run: `pnpm --filter @k/shared typecheck; pnpm --filter @k/core typecheck` → Expected: clean

- [ ] **Step 9: Commit**

```bash
git add shared/src/types.ts core/src/metrics.ts core/src/routes/metrics.ts core/src/index.ts core/test/metrics.test.ts
git commit -m "feat: metrics summary endpoint (today, active, 14-day series)"
```

---

### Task 5: Project registry API

Registers projects via either onboarding path (bible §3). Cloning uses `gh repo clone` into `<repo>/workspace/`.

**Files:**
- Create: `core/src/projects.ts`
- Create: `core/src/routes/projects.ts`
- Modify: `core/src/index.ts` (register route)
- Modify: `.gitignore` (+ `workspace/`)
- Test: `core/test/projects.test.ts`

- [ ] **Step 1: Write the failing test** — `core/test/projects.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { validateRegistration, remoteFromUrl } from '../src/projects.js'

describe('validateRegistration', () => {
  it('accepts a localPath registration', () => {
    expect(validateRegistration({ name: 'x', localPath: 'C:/repo' }).ok).toBe(true)
  })
  it('accepts a githubUrl registration', () => {
    expect(validateRegistration({ name: 'x', githubUrl: 'https://github.com/o/r' }).ok).toBe(true)
  })
  it('rejects neither or both sources', () => {
    expect(validateRegistration({ name: 'x' }).ok).toBe(false)
    expect(validateRegistration({ name: 'x', localPath: 'a', githubUrl: 'b' }).ok).toBe(false)
  })
  it('rejects empty name', () => {
    expect(validateRegistration({ name: ' ', localPath: 'a' }).ok).toBe(false)
  })
})

describe('remoteFromUrl', () => {
  it('extracts owner/repo from https and ssh urls', () => {
    expect(remoteFromUrl('https://github.com/foo/bar')).toBe('foo/bar')
    expect(remoteFromUrl('https://github.com/foo/bar.git')).toBe('foo/bar')
    expect(remoteFromUrl('git@github.com:foo/bar.git')).toBe('foo/bar')
  })
  it('returns null for non-github urls', () => {
    expect(remoteFromUrl('https://gitlab.com/foo/bar')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @k/core test` → Expected: FAIL (cannot resolve `../src/projects.js`)

- [ ] **Step 3: Create `core/src/projects.ts`**

```ts
/**
 * Project registry — bible §3.
 * Two onboarding paths: register an existing local repo by path, or clone a
 * GitHub URL into the managed workspace (gh repo clone).
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execa } from 'execa'
import { v4 as uuid } from 'uuid'
import type { Project } from '@k/shared'
import { projectsDb } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const WORKSPACE_DIR = path.join(__dirname, '../../workspace')

export interface RegistrationBody {
  name: string
  localPath?: string
  githubUrl?: string
}

export function validateRegistration(b: RegistrationBody): { ok: true } | { ok: false; error: string } {
  if (!b.name?.trim()) return { ok: false, error: 'name is required' }
  const sources = [b.localPath, b.githubUrl].filter(Boolean).length
  if (sources !== 1) return { ok: false, error: 'provide exactly one of localPath or githubUrl' }
  return { ok: true }
}

export function remoteFromUrl(url: string): string | null {
  const m = url.match(/(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)
  return m ? m[1] : null
}

function rowToProject(r: Record<string, unknown>): Project {
  return {
    id: String(r.id),
    name: String(r.name),
    localPath: String(r.local_path),
    githubRemote: r.github_remote ? String(r.github_remote) : undefined,
    workspaceManaged: Boolean(r.workspace_managed),
    bibleDir: String(r.bible_dir),
    healthScore: r.health_score == null ? undefined : Number(r.health_score),
    lastVerifiedAt: r.last_verified_at == null ? undefined : Number(r.last_verified_at),
    createdAt: Number(r.created_at),
  }
}

export function listProjects(): Project[] {
  return (projectsDb.listProjects.all() as Array<Record<string, unknown>>).map(rowToProject)
}

export function getProject(id: string): Project | null {
  const row = projectsDb.getProject.get(id) as Record<string, unknown> | undefined
  return row ? rowToProject(row) : null
}

async function detectRemote(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath })
    return remoteFromUrl(stdout.trim()) ?? undefined
  } catch { return undefined }
}

export async function registerProject(b: RegistrationBody): Promise<Project> {
  let localPath: string
  let workspaceManaged = false
  let githubRemote: string | undefined

  if (b.githubUrl) {
    const remote = remoteFromUrl(b.githubUrl)
    if (!remote) throw new Error(`not a GitHub URL: ${b.githubUrl}`)
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
    localPath = path.join(WORKSPACE_DIR, b.name)
    if (!fs.existsSync(localPath)) {
      await execa('gh', ['repo', 'clone', remote, localPath])
    }
    workspaceManaged = true
    githubRemote = remote
  } else {
    localPath = path.resolve(b.localPath!)
    if (!fs.existsSync(path.join(localPath, '.git'))) {
      throw new Error(`${localPath} is not a git repository`)
    }
    githubRemote = await detectRemote(localPath)
  }

  const project: Project = {
    id: uuid(),
    name: b.name.trim(),
    localPath,
    githubRemote,
    workspaceManaged,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  }
  projectsDb.insertProject.run({
    id: project.id,
    name: project.name,
    localPath: project.localPath,
    githubRemote: project.githubRemote ?? null,
    workspaceManaged: project.workspaceManaged ? 1 : 0,
    bibleDir: project.bibleDir,
    createdAt: project.createdAt,
  })
  return project
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @k/core test` → Expected: PASS

- [ ] **Step 5: Create `core/src/routes/projects.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import { validateRegistration, registerProject, listProjects, getProject, type RegistrationBody } from '../projects.js'
import { getGithubStatus } from '../github.js'

export async function projectsRoutes(app: FastifyInstance) {
  // GET /api/projects — fleet list
  app.get('/api/projects', async (_req, reply) => reply.send(listProjects()))

  // POST /api/projects — register (path) or clone (githubUrl)
  app.post<{ Body: RegistrationBody }>('/api/projects', async (req, reply) => {
    const v = validateRegistration(req.body ?? ({} as RegistrationBody))
    if (!v.ok) return reply.status(400).send({ error: v.error })
    try {
      const project = await registerProject(req.body)
      return reply.status(201).send(project)
    } catch (e) {
      return reply.status(400).send({ error: String(e instanceof Error ? e.message : e) })
    }
  })

  // GET /api/projects/:id/github — cached PR + CI status
  app.get<{ Params: { id: string } }>('/api/projects/:id/github', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    return reply.send(getGithubStatus(project.id))
  })
}
```

(`getGithubStatus` arrives in Task 6 — if executing this task standalone, stub it in `core/src/github.ts` as `export function getGithubStatus(_: string) { return { prs: [], ci: [], fetchedAt: null } }`.)

- [ ] **Step 6: Register in `core/src/index.ts`** (same pattern as Task 4):

```ts
import { projectsRoutes } from './routes/projects.js'
// …
await app.register(projectsRoutes)
```

- [ ] **Step 7: Add `workspace/` to `.gitignore`** (new line at the end)

- [ ] **Step 8: Manual verification**

Run: `pnpm --filter @k/core dev` (background), then:

```powershell
$h = @{ Authorization = 'Bearer dev-token-change-me'; 'Content-Type' = 'application/json' }
Invoke-RestMethod -Uri http://localhost:3001/api/projects -Headers $h -Method Post -Body '{"name":"jarvis-core","localPath":"C:/Users/ckbra/desktop/k"}'
Invoke-RestMethod -Uri http://localhost:3001/api/projects -Headers $h
```

Expected: 201 with project JSON (id, `workspaceManaged: false`), then a 1-element list. Stop the dev server.

- [ ] **Step 9: Typecheck + commit**

Run: `pnpm --filter @k/core typecheck` → clean

```bash
git add core/src/projects.ts core/src/routes/projects.ts core/src/index.ts core/test/projects.test.ts .gitignore
git commit -m "feat: project registry API (register path / clone GitHub URL)"
```

---

### Task 6: GitHubProvider — gh CLI, cache, poller

Bible §4: parse `gh … --json` output (pure, tested), cache in SQLite, poll on an interval, broadcast deltas.

**Files:**
- Modify: `shared/src/types.ts` (PrInfo, CiRunInfo, GithubStatus)
- Create: `core/src/github-parse.ts`
- Create: `core/src/github.ts`
- Modify: `core/src/db.ts` (github_cache table)
- Modify: `core/src/index.ts` (start poller)
- Test: `core/test/github-parse.test.ts`

- [ ] **Step 1: Add schemas to `shared/src/types.ts`** (after the Metrics block)

```ts
// ─── GitHub (gh CLI projections) ────────────────────────────────────────────

export const PrInfoSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),               // OPEN | MERGED | CLOSED
  url: z.string(),
  checks: z.enum(['passing', 'failing', 'pending', 'none']),
})
export type PrInfo = z.infer<typeof PrInfoSchema>

export const CiRunInfoSchema = z.object({
  id: z.number(),
  workflow: z.string(),
  branch: z.string(),
  status: z.string(),              // completed | in_progress | queued
  conclusion: z.string().nullable(), // success | failure | … | null while running
  createdAt: z.string(),
})
export type CiRunInfo = z.infer<typeof CiRunInfoSchema>

export const GithubStatusSchema = z.object({
  prs: z.array(PrInfoSchema),
  ci: z.array(CiRunInfoSchema),
  fetchedAt: z.number().nullable(),  // null = never fetched
})
export type GithubStatus = z.infer<typeof GithubStatusSchema>
```

- [ ] **Step 2: Write the failing test** — `core/test/github-parse.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { parsePrList, parseCiRuns } from '../src/github-parse.js'

describe('parsePrList', () => {
  it('maps gh pr list --json output and rolls up checks', () => {
    const gh = [
      {
        number: 42, title: 'Fix parser', state: 'OPEN', url: 'https://github.com/o/r/pull/42',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }],
      },
      { number: 41, title: 'Docs', state: 'MERGED', url: 'u', statusCheckRollup: [] },
    ]
    const prs = parsePrList(gh)
    expect(prs[0]).toEqual({ number: 42, title: 'Fix parser', state: 'OPEN', url: 'https://github.com/o/r/pull/42', checks: 'failing' })
    expect(prs[1].checks).toBe('none')
  })

  it('reports pending when any check lacks a conclusion', () => {
    const prs = parsePrList([{ number: 1, title: 't', state: 'OPEN', url: 'u', statusCheckRollup: [{ conclusion: null }] }])
    expect(prs[0].checks).toBe('pending')
  })

  it('tolerates garbage input', () => {
    expect(parsePrList(null)).toEqual([])
    expect(parsePrList([{ bogus: true }])).toEqual([])
  })
})

describe('parseCiRuns', () => {
  it('maps gh run list --json output', () => {
    const gh = [{
      databaseId: 9, workflowName: 'CI', headBranch: 'main',
      status: 'completed', conclusion: 'failure', createdAt: '2026-06-10T10:00:00Z',
    }]
    expect(parseCiRuns(gh)).toEqual([
      { id: 9, workflow: 'CI', branch: 'main', status: 'completed', conclusion: 'failure', createdAt: '2026-06-10T10:00:00Z' },
    ])
  })
  it('tolerates garbage input', () => {
    expect(parseCiRuns('nope')).toEqual([])
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @k/core test` → Expected: FAIL (cannot resolve `../src/github-parse.js`)

- [ ] **Step 4: Create `core/src/github-parse.ts`** (pure)

```ts
/** Pure projections from `gh … --json` payloads — no subprocess, no DB. */

import type { PrInfo, CiRunInfo } from '@k/shared'

function rollupChecks(rollup: unknown): PrInfo['checks'] {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  let pending = false
  for (const c of rollup) {
    const conclusion = (c as Record<string, unknown>)?.conclusion
    if (conclusion == null || conclusion === '') pending = true
    else if (String(conclusion).toUpperCase() !== 'SUCCESS' && String(conclusion).toUpperCase() !== 'SKIPPED' && String(conclusion).toUpperCase() !== 'NEUTRAL') return 'failing'
  }
  return pending ? 'pending' : 'passing'
}

export function parsePrList(json: unknown): PrInfo[] {
  if (!Array.isArray(json)) return []
  const out: PrInfo[] = []
  for (const raw of json) {
    const r = raw as Record<string, unknown>
    if (typeof r?.number !== 'number' || typeof r?.title !== 'string') continue
    out.push({
      number: r.number,
      title: r.title,
      state: String(r.state ?? 'OPEN'),
      url: String(r.url ?? ''),
      checks: rollupChecks(r.statusCheckRollup),
    })
  }
  return out
}

export function parseCiRuns(json: unknown): CiRunInfo[] {
  if (!Array.isArray(json)) return []
  const out: CiRunInfo[] = []
  for (const raw of json) {
    const r = raw as Record<string, unknown>
    if (typeof r?.databaseId !== 'number') continue
    out.push({
      id: r.databaseId,
      workflow: String(r.workflowName ?? ''),
      branch: String(r.headBranch ?? ''),
      status: String(r.status ?? ''),
      conclusion: r.conclusion == null || r.conclusion === '' ? null : String(r.conclusion),
      createdAt: String(r.createdAt ?? ''),
    })
  }
  return out
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @k/core test` → Expected: PASS

- [ ] **Step 6: Add cache table to `core/src/db.ts`** — extend the `db.exec` block:

```sql
  CREATE TABLE IF NOT EXISTS github_cache (
    project_id  TEXT NOT NULL,
    kind        TEXT NOT NULL,            -- 'pr' | 'ci'
    payload     TEXT NOT NULL,            -- JSON array
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, kind)
  );
```

and helpers after `verificationDb`:

```ts
// ─── GitHub cache helpers ────────────────────────────────────────────────────

const upsertGithubCache = db.prepare(`
  INSERT INTO github_cache (project_id, kind, payload, fetched_at)
  VALUES (@projectId, @kind, @payload, @fetchedAt)
  ON CONFLICT(project_id, kind) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
`)

const getGithubCache = db.prepare(`SELECT * FROM github_cache WHERE project_id = ? AND kind = ?`)

export const githubDb = { upsertGithubCache, getGithubCache }
```

- [ ] **Step 7: Create `core/src/github.ts`** (provider + cache + poller; replace the Task 5 stub if present)

```ts
/**
 * GitHubProvider — bible §4. First implementation: authenticated `gh` CLI.
 * Polls registered projects, caches results in SQLite, broadcasts deltas
 * as github_update WS messages via the EventBus.
 */

import { execa } from 'execa'
import type { GithubStatus, PrInfo, CiRunInfo } from '@k/shared'
import { parsePrList, parseCiRuns } from './github-parse.js'
import { githubDb } from './db.js'
import { eventBus } from './events.js'
import { listProjects } from './projects.js'

const POLL_MS = Number(process.env.GITHUB_POLL_MS ?? 60_000)

async function ghJson(args: string[], cwd: string): Promise<unknown> {
  const { stdout } = await execa('gh', [...args], { cwd, timeout: 30_000 })
  return JSON.parse(stdout)
}

export async function fetchGithubStatus(remote: string, cwd: string): Promise<{ prs: PrInfo[]; ci: CiRunInfo[] }> {
  const [prsRaw, ciRaw] = await Promise.all([
    ghJson(['pr', 'list', '--repo', remote, '--json', 'number,title,state,url,statusCheckRollup'], cwd),
    ghJson(['run', 'list', '--repo', remote, '--limit', '10', '--json', 'databaseId,workflowName,headBranch,status,conclusion,createdAt'], cwd),
  ])
  return { prs: parsePrList(prsRaw), ci: parseCiRuns(ciRaw) }
}

export function getGithubStatus(projectId: string): GithubStatus {
  const pr = githubDb.getGithubCache.get(projectId, 'pr') as Record<string, unknown> | undefined
  const ci = githubDb.getGithubCache.get(projectId, 'ci') as Record<string, unknown> | undefined
  return {
    prs: pr ? JSON.parse(String(pr.payload)) : [],
    ci: ci ? JSON.parse(String(ci.payload)) : [],
    fetchedAt: pr || ci ? Number((pr ?? ci)!.fetched_at) : null,
  }
}

async function pollOnce(): Promise<void> {
  for (const project of listProjects()) {
    if (!project.githubRemote) continue
    try {
      const before = getGithubStatus(project.id)
      const { prs, ci } = await fetchGithubStatus(project.githubRemote, project.localPath)
      const now = Date.now()
      githubDb.upsertGithubCache.run({ projectId: project.id, kind: 'pr', payload: JSON.stringify(prs), fetchedAt: now })
      githubDb.upsertGithubCache.run({ projectId: project.id, kind: 'ci', payload: JSON.stringify(ci), fetchedAt: now })
      if (JSON.stringify(prs) !== JSON.stringify(before.prs)) {
        eventBus.broadcast({ type: 'github_update', projectId: project.id, kind: 'pr', payload: prs })
      }
      if (JSON.stringify(ci) !== JSON.stringify(before.ci)) {
        eventBus.broadcast({ type: 'github_update', projectId: project.id, kind: 'ci', payload: ci })
      }
    } catch (e) {
      // Offline / rate-limited / gh unauthenticated → keep serving cache (bible §4 failure modes)
      console.warn(`[github] poll failed for ${project.name}: ${e instanceof Error ? e.message : e}`)
    }
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null

export function startGithubPoller(): void {
  if (pollTimer || process.env.ENABLE_GITHUB_POLL === 'false') return
  void pollOnce()
  pollTimer = setInterval(() => void pollOnce(), POLL_MS)
  console.log(`[github] poller started (every ${POLL_MS / 1000}s)`)
}
```

- [ ] **Step 8: Start the poller in `core/src/index.ts`** — after `await app.listen(…)`:

```ts
import { startGithubPoller } from './github.js'
// … after listen:
startGithubPoller()
```

- [ ] **Step 9: Typecheck + tests + manual check**

Run: `pnpm --filter @k/shared typecheck; pnpm --filter @k/core typecheck; pnpm --filter @k/core test` → all clean/pass.

Manual (requires `gh auth status` to be logged in and a registered project with a remote): start core, hit `GET /api/projects/:id/github` → `{ prs: [...], ci: [...], fetchedAt: <number> }` (or empty arrays + `fetchedAt: null` if no remote — both acceptable).

- [ ] **Step 10: Commit**

```bash
git add shared/src/types.ts core/src/github-parse.ts core/src/github.ts core/src/db.ts core/src/index.ts core/test/github-parse.test.ts
git commit -m "feat: GitHubProvider via gh CLI with SQLite cache and polling"
```

---

### Task 7: Web design tokens + flare layer

Replace the old palette with the bible §6 tokens, plus the flare layer: ambient aurora glow behind the stage, glow/pulse utilities, self-hosted fonts. Flare lives in CSS so components stay clean.

**Files:**
- Modify: `web/package.json` (fonts)
- Modify: `web/src/index.css` (full rewrite below)
- Modify: `web/src/main.tsx` (font imports)

- [ ] **Step 1: Install fonts**

Run: `pnpm --filter @k/web add @fontsource-variable/inter @fontsource/jetbrains-mono`

- [ ] **Step 2: Import in `web/src/main.tsx`** (top of file, before `./index.css`)

```ts
import '@fontsource-variable/inter'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
```

- [ ] **Step 3: Rewrite `web/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  /* precision-minimal tokens — bible §6 */
  --bg: #0a0a0f;
  --surface: #111116;
  --raised: #16161d;
  --border: #26262e;
  --text: #e7e7ea;
  --muted: #8b8b93;
  --accent: #6366f1;
  --accent-hover: #818cf8;
  --green: #22c55e;
  --amber: #eab308;
  --red: #ef4444;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}

* { box-sizing: border-box; }

html, body, #root {
  height: 100%;
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: 'Inter Variable', Inter, system-ui, sans-serif;
  font-size: 14px;
}

.mono { font-family: var(--font-mono); }

/* ── flare layer ──────────────────────────────────────────────────────────── */

/* Ambient aurora behind the stage — barely-there indigo drift. Pure decoration
   budget: this is the ONE decorative element; everything else must inform. */
.ambient {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(60rem 40rem at 70% -10%, rgba(99, 102, 241, 0.07), transparent 60%),
    radial-gradient(50rem 35rem at 10% 110%, rgba(99, 102, 241, 0.05), transparent 60%);
  animation: ambient-drift 24s ease-in-out infinite alternate;
}
@keyframes ambient-drift {
  from { transform: translateX(-2%) translateY(0); opacity: 0.8; }
  to   { transform: translateX(2%) translateY(1.5%); opacity: 1; }
}

/* Live-element glow: only things that are genuinely live may pulse */
.glow-live {
  box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5);
  animation: pulse-live 2.4s ease-out infinite;
}
@keyframes pulse-live {
  0%   { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.45); }
  70%  { box-shadow: 0 0 0 5px rgba(34, 197, 94, 0); }
  100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
}

/* Focused command bar gets a soft accent ring */
.glow-focus {
  box-shadow: 0 0 0 1px var(--accent), 0 0 24px -6px rgba(99, 102, 241, 0.45);
}

/* Card hover lift — 150ms, hairline turns accent-tinted */
.card-lift {
  transition: transform 150ms ease-out, border-color 150ms ease-out, box-shadow 150ms ease-out;
}
.card-lift:hover {
  transform: translateY(-1px);
  border-color: rgba(99, 102, 241, 0.4);
  box-shadow: 0 4px 24px -12px rgba(99, 102, 241, 0.35);
}

/* ── chrome ───────────────────────────────────────────────────────────────── */

::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #34343e; }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

@media (prefers-reduced-motion: reduce) {
  .ambient, .glow-live { animation: none; }
  * { transition-duration: 0.01ms !important; }
}
```

- [ ] **Step 4: Typecheck + visual smoke**

Run: `pnpm --filter @k/web typecheck` → clean (CSS-only change; old components still reference the renamed vars that survive: `--bg/--surface/--border/--text/--muted/--accent` all still exist).

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/src/index.css web/src/main.tsx pnpm-lock.yaml
git commit -m "feat(web): precision-minimal tokens, flare layer, self-hosted fonts"
```

---

### Task 8: Hash router + Shell frame

The Command Deck frame: icon sidebar · top bar · stage (with 250ms transitions) · activity strip. Hash-based routing keeps deep links without a router dependency.

**Files:**
- Create: `web/src/lib/route.ts`
- Create: `web/src/shell/Sidebar.tsx`
- Create: `web/src/shell/TopBar.tsx`
- Create: `web/src/shell/Shell.tsx`
- Modify: `web/src/App.tsx`
- Delete: `web/src/pages/Dashboard.tsx` (in Task 12, after pages exist)

- [ ] **Step 1: Create `web/src/lib/route.ts`**

```ts
import { useEffect, useState } from 'react'

export type Route = { view: string; param?: string }

function parse(): Route {
  const segs = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  return { view: segs[0] || 'home', param: segs[1] }
}

export function navigate(view: string, param?: string) {
  window.location.hash = param ? `/${view}/${param}` : `/${view}`
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parse)
  useEffect(() => {
    const onChange = () => setRoute(parse())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
```

- [ ] **Step 2: Create `web/src/shell/Sidebar.tsx`**

```tsx
import { cn } from '../lib/cn'
import { navigate } from '../lib/route'

export interface Destination {
  id: string
  icon: string
  label: string
  enabled: boolean
}

export const DESTINATIONS: Destination[] = [
  { id: 'home', icon: '⌂', label: 'Home', enabled: true },
  { id: 'projects', icon: '▦', label: 'Projects', enabled: true },
  { id: 'graph', icon: '◉', label: 'Fleet Graph · Phase 2', enabled: false },
  { id: 'runs', icon: '▶', label: 'Runs', enabled: true },
  { id: 'tasks', icon: '✓', label: 'Tasks · Phase 1', enabled: false },
  { id: 'skills', icon: '⚒', label: 'Skills · Phase 3', enabled: false },
  { id: 'metrics', icon: '∿', label: 'Metrics · Phase 1', enabled: false },
  { id: 'docs', icon: '▤', label: 'Docs', enabled: true },
]

export default function Sidebar({ active }: { active: string }) {
  return (
    <nav className="row-span-3 flex flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--surface)] py-3 z-10">
      <div className="mb-3 text-lg font-bold text-[var(--accent)]" title="Jarvis">⚡</div>
      {DESTINATIONS.map(d => (
        <button
          key={d.id}
          title={d.label}
          disabled={!d.enabled}
          onClick={() => navigate(d.id)}
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-lg text-base transition-colors duration-150',
            d.enabled ? 'text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]' : 'cursor-default text-[var(--border)]',
            active === d.id && 'bg-[var(--accent)]/20 text-[var(--accent-hover)]'
          )}
        >
          {d.icon}
        </button>
      ))}
      <button
        title="Settings · Phase 1"
        disabled
        className="mt-auto flex h-9 w-9 items-center justify-center rounded-lg text-base text-[var(--border)]"
      >
        ⚙
      </button>
    </nav>
  )
}
```

- [ ] **Step 3: Create `web/src/shell/TopBar.tsx`**

```tsx
import { DESTINATIONS } from './Sidebar'

interface Props {
  view: string
  connected: boolean
  onOpenCommand: () => void
}

export default function TopBar({ view, connected, onOpenCommand }: Props) {
  const dest = DESTINATIONS.find(d => d.id === view)
  return (
    <header className="z-10 flex items-center gap-4 border-b border-[var(--border)] px-4 py-2.5">
      <h1 className="text-sm font-semibold tracking-wide text-[var(--text)]">
        <span className="mr-2 text-[var(--accent)]">{dest?.icon ?? '⌂'}</span>
        {dest?.label.split(' ·')[0] ?? 'Home'}
      </h1>
      <button
        onClick={onOpenCommand}
        className="ml-auto flex w-80 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-left text-xs text-[var(--muted)] transition-colors duration-150 hover:border-[var(--accent)]/50 hover:text-[var(--text)]"
      >
        <kbd className="mono rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px]">⌘K</kbd>
        <span>Ask Jarvis or jump anywhere…</span>
      </button>
      <span
        title={connected ? 'core connected' : 'connecting…'}
        className={`h-2 w-2 rounded-full ${connected ? 'bg-[var(--green)] glow-live' : 'bg-[var(--amber)] animate-pulse'}`}
      />
    </header>
  )
}
```

- [ ] **Step 4: Create `web/src/shell/Shell.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import ActivityStrip from './ActivityStrip'
import CommandBar from './CommandBar'
import Home from '../pages/Home'
import RunsPage from '../pages/RunsPage'
import DocsPage from '../pages/DocsPage'
import ProjectsPage from '../pages/ProjectsPage'
import { useHashRoute } from '../lib/route'
import { connectWs, onWsMessage } from '../lib/ws'

export default function Shell() {
  const route = useHashRoute()
  const [connected, setConnected] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)

  useEffect(() => {
    connectWs()
    // any message proves the socket is alive; fall back to optimistic after 1.5s
    const t = setTimeout(() => setConnected(true), 1_500)
    const unsub = onWsMessage(() => setConnected(true))
    return () => { clearTimeout(t); unsub() }
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCommandOpen(o => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="grid h-screen grid-cols-[52px_1fr] grid-rows-[auto_1fr_auto] bg-[var(--bg)]">
      <div className="ambient" aria-hidden />
      <Sidebar active={route.view} />
      <TopBar view={route.view} connected={connected} onOpenCommand={() => setCommandOpen(true)} />

      <main className="relative z-10 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={route.view}
            className="h-full"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            {route.view === 'home' && <Home />}
            {route.view === 'runs' && <RunsPage runId={route.param} />}
            {route.view === 'docs' && <DocsPage slug={route.param} />}
            {route.view === 'projects' && <ProjectsPage />}
          </motion.div>
        </AnimatePresence>
      </main>

      <ActivityStrip />
      <CommandBar open={commandOpen} onClose={() => setCommandOpen(false)} />
    </div>
  )
}
```

- [ ] **Step 5: Rewire `web/src/App.tsx`**

```tsx
import Shell from './shell/Shell'

export default function App() {
  return <Shell />
}
```

- [ ] **Step 6: Typecheck** — will FAIL until Tasks 9–12 create CommandBar, ActivityStrip, and the four pages. That's expected mid-flight; if executing tasks strictly in order, create placeholder pages now and replace them in later tasks:

```tsx
// web/src/pages/Home.tsx (placeholder — replaced in Task 11)
export default function Home() { return <div className="p-6 text-[var(--muted)]">Home</div> }
```

```tsx
// web/src/pages/RunsPage.tsx (placeholder — replaced in Task 12)
export default function RunsPage({ runId }: { runId?: string }) { return <div className="p-6 text-[var(--muted)]">Runs {runId}</div> }
```

```tsx
// web/src/pages/DocsPage.tsx (placeholder — replaced in Task 13)
export default function DocsPage({ slug }: { slug?: string }) { return <div className="p-6 text-[var(--muted)]">Docs {slug}</div> }
```

```tsx
// web/src/pages/ProjectsPage.tsx (placeholder — replaced in Task 14)
export default function ProjectsPage() { return <div className="p-6 text-[var(--muted)]">Projects</div> }
```

```tsx
// web/src/shell/ActivityStrip.tsx (placeholder — replaced in Task 10)
export default function ActivityStrip() { return <footer className="z-10 border-t border-[var(--border)] px-4 py-1.5 text-xs text-[var(--muted)]">—</footer> }
```

```tsx
// web/src/shell/CommandBar.tsx (placeholder — replaced in Task 9)
export default function CommandBar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <div className="fixed inset-0 z-50" onClick={onClose} /> : null
}
```

Run: `pnpm --filter @k/web typecheck` → Expected: clean

- [ ] **Step 7: Visual check**

Run core + web (`pnpm dev`), open http://localhost:5173 → sidebar with 4 enabled icons, top bar, ambient glow visible, stage transitions when clicking sidebar icons, hash updates (#/runs etc.).

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat(web): Command Deck shell — sidebar, topbar, hash routing, stage transitions"
```

---

### Task 9: CommandBar — dispatch + navigate

⌘K does both jobs (bible §6): free text dispatches an agent run; typed queries fuzzy-match destinations and recent runs. One ranked list, arrow keys + Enter.

**Files:**
- Create: `web/src/shell/CommandBar.tsx` (replaces Task 8 placeholder)
- Delete: `web/src/components/PromptBar.tsx`

- [ ] **Step 1: Write `web/src/shell/CommandBar.tsx`**

```tsx
import { useState, useEffect, useRef, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import type { Run } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { navigate } from '../lib/route'
import { DESTINATIONS } from './Sidebar'

interface Props { open: boolean; onClose: () => void }

type Item =
  | { kind: 'dispatch'; label: string }
  | { kind: 'nav'; label: string; icon: string; view: string; param?: string }

export default function CommandBar({ open, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const { data: runs = [] } = useQuery<Run[]>({ queryKey: ['runs'], queryFn: api.runs.list, enabled: open })

  useEffect(() => {
    if (open) { setQuery(''); setSelected(0); setError(null); setTimeout(() => inputRef.current?.focus(), 50) }
  }, [open])

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase()
    const navs: Item[] = DESTINATIONS.filter(d => d.enabled)
      .filter(d => !q || d.label.toLowerCase().includes(q))
      .map(d => ({ kind: 'nav', label: d.label.split(' ·')[0], icon: d.icon, view: d.id }))
    const runItems: Item[] = runs
      .filter(r => q && r.prompt.toLowerCase().includes(q))
      .slice(0, 4)
      .map(r => ({ kind: 'nav', label: `▶ ${r.prompt.slice(0, 60)}`, icon: '·', view: 'runs', param: r.id }))
    const dispatch: Item[] = query.trim() ? [{ kind: 'dispatch', label: query.trim() }] : []
    return [...dispatch, ...navs, ...runItems]
  }, [query, runs])

  useEffect(() => { setSelected(0) }, [items.length])

  async function execute(item: Item) {
    if (item.kind === 'nav') {
      navigate(item.view, item.param)
      onClose()
      return
    }
    setBusy(true); setError(null)
    try {
      const run = await api.runs.start(item.label)
      onClose()
      navigate('runs', run.id)
    } catch (e) {
      setError(String(e))
    } finally { setBusy(false) }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, items.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
    if (e.key === 'Enter' && items[selected]) { e.preventDefault(); void execute(items[selected]) }
    if (e.key === 'Escape') onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-28"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            className="glow-focus relative w-full max-w-xl overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]"
            initial={{ opacity: 0, y: -16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask Jarvis — or type to jump…"
              className="w-full border-b border-[var(--border)] bg-transparent px-4 py-3.5 text-sm text-[var(--text)] placeholder-[var(--muted)] outline-none"
            />
            <ul className="max-h-72 overflow-y-auto py-1.5">
              {items.map((item, i) => (
                <li key={`${item.kind}-${item.label}-${i}`}>
                  <button
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => void execute(item)}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors duration-100',
                      i === selected ? 'bg-[var(--raised)] text-[var(--text)]' : 'text-[var(--muted)]'
                    )}
                  >
                    {item.kind === 'dispatch' ? (
                      <>
                        <span className="text-[var(--accent)]">⚡</span>
                        <span className="truncate">Dispatch agent: <span className="text-[var(--text)]">{item.label}</span></span>
                        <kbd className="mono ml-auto text-[10px] text-[var(--muted)]">↵</kbd>
                      </>
                    ) : (
                      <>
                        <span className="w-4 text-center opacity-70">{item.icon}</span>
                        <span className="truncate">{item.label}</span>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <div className="border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--muted)]">
              {busy ? '⏳ dispatching…' : error ? `⚠ ${error}` : '↑↓ select · ↵ run · esc close'}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
```

- [ ] **Step 2: Delete `web/src/components/PromptBar.tsx`**

Run: `git rm web/src/components/PromptBar.tsx` (Dashboard.tsx still imports it — that file dies in Task 12; until then typecheck via the new entry only. If `tsc` complains about Dashboard.tsx, delete `web/src/pages/Dashboard.tsx` now instead — nothing imports it after Task 8.)

Run: `git rm web/src/pages/Dashboard.tsx`

- [ ] **Step 3: Typecheck + visual**

Run: `pnpm --filter @k/web typecheck` → clean.
Visual: ⌘K opens with spring + glow ring; typing text shows "Dispatch agent: …" first, destinations filter beneath; Enter on a destination navigates; Enter on dispatch creates a run and lands on #/runs/:id.

- [ ] **Step 4: Commit**

```bash
git add -A web/src
git commit -m "feat(web): CommandBar — unified dispatch + fuzzy navigation"
```

---

### Task 10: ActivityStrip

Always-visible bottom strip: running agents with live pulses, last finished run, day totals from the metrics endpoint.

**Files:**
- Create: `web/src/shell/ActivityStrip.tsx` (replaces placeholder)
- Modify: `web/src/lib/api.ts` (+ metrics)

- [ ] **Step 1: Extend `web/src/lib/api.ts`**

Add to the import: `import type { Run, Artifact, MetricsSummary, Project, GithubStatus } from '@k/shared'` and add to the `api` object:

```ts
  metrics: {
    summary: () => req<MetricsSummary>('/metrics/summary'),
  },
  projects: {
    list: () => req<Project[]>('/projects'),
    register: (body: { name: string; localPath?: string; githubUrl?: string }) =>
      req<Project>('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    github: (id: string) => req<GithubStatus>(`/projects/${id}/github`),
  },
```

- [ ] **Step 2: Write `web/src/shell/ActivityStrip.tsx`**

```tsx
import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Run, MetricsSummary, WsMessage } from '@k/shared'
import { api } from '../lib/api'
import { onWsMessage } from '../lib/ws'
import { navigate } from '../lib/route'

export default function ActivityStrip() {
  const qc = useQueryClient()
  const { data: runs = [] } = useQuery<Run[]>({ queryKey: ['runs'], queryFn: api.runs.list, refetchInterval: 10_000 })
  const { data: metrics } = useQuery<MetricsSummary>({
    queryKey: ['metrics'],
    queryFn: api.metrics.summary,
    refetchInterval: 30_000,
  })

  useEffect(() => {
    return onWsMessage((msg: WsMessage) => {
      if (msg.type === 'run_update') {
        qc.invalidateQueries({ queryKey: ['runs'] })
        qc.invalidateQueries({ queryKey: ['metrics'] })
      }
    })
  }, [qc])

  const active = runs.filter(r => r.status === 'running' || r.status === 'queued')
  const lastDone = runs.find(r => r.status === 'done' || r.status === 'error' || r.status === 'killed')

  return (
    <footer className="z-10 flex items-center gap-5 overflow-x-auto whitespace-nowrap border-t border-[var(--border)] bg-[var(--surface)]/60 px-4 py-1.5 text-xs backdrop-blur">
      {active.length === 0 && (
        <span className="text-[var(--muted)]">idle — no agents running</span>
      )}
      {active.map(r => (
        <button
          key={r.id}
          onClick={() => navigate('runs', r.id)}
          className="flex items-center gap-2 text-[var(--text)] transition-colors duration-150 hover:text-[var(--accent-hover)]"
        >
          <span className="glow-live h-1.5 w-1.5 rounded-full bg-[var(--green)]" />
          <span className="max-w-72 truncate">{r.prompt}</span>
        </button>
      ))}
      {lastDone && (
        <button onClick={() => navigate('runs', lastDone.id)} className="text-[var(--muted)] transition-colors duration-150 hover:text-[var(--text)]">
          last: {lastDone.status === 'done' ? '✓' : '✗'} {lastDone.prompt.slice(0, 40)}
        </button>
      )}
      <span className="mono ml-auto text-[var(--muted)]">
        {metrics ? `${metrics.today.runs} runs today · $${metrics.today.costUsd.toFixed(2)} · ${(metrics.today.tokens / 1000).toFixed(0)}k tok` : '—'}
      </span>
    </footer>
  )
}
```

- [ ] **Step 3: Typecheck + visual**

Run: `pnpm --filter @k/web typecheck` → clean. Visual: strip shows idle state or pulsing live runs; right side shows day totals; clicking a run navigates to its console.

- [ ] **Step 4: Commit**

```bash
git add web/src/shell/ActivityStrip.tsx web/src/lib/api.ts
git commit -m "feat(web): live activity strip with day totals"
```

---

### Task 11: Home page — metrics row + project cards

**Files:**
- Create: `web/src/components/Sparkline.tsx`
- Create: `web/src/components/MetricCard.tsx`
- Create: `web/src/components/ProjectCard.tsx`
- Create: `web/src/pages/Home.tsx` (replaces placeholder)

- [ ] **Step 1: Create `web/src/components/Sparkline.tsx`**

```tsx
interface Props {
  values: number[]
  width?: number
  height?: number
  stroke?: string
}

export default function Sparkline({ values, width = 96, height = 24, stroke = 'var(--accent)' }: Props) {
  if (values.length < 2) return <svg width={width} height={height} />
  const max = Math.max(...values, 1)
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * width},${height - 2 - (v / max) * (height - 4)}`)
    .join(' ')
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" opacity="0.9" />
      <polyline points={`0,${height} ${pts} ${width},${height}`} fill={stroke} opacity="0.07" stroke="none" />
    </svg>
  )
}
```

- [ ] **Step 2: Create `web/src/components/MetricCard.tsx`** (animated numerals — the flare is the count-up, not decoration)

```tsx
import { useEffect, useRef, useState } from 'react'
import Sparkline from './Sparkline'

interface Props {
  label: string
  value: string
  spark?: number[]
  accent?: boolean
}

/** Animates numeric text changes by interpolating the leading number. */
function useTicker(target: string): string {
  const [display, setDisplay] = useState(target)
  const prev = useRef(target)
  useEffect(() => {
    const from = parseFloat(prev.current.replace(/[^\d.]/g, ''))
    const to = parseFloat(target.replace(/[^\d.]/g, ''))
    prev.current = target
    if (isNaN(from) || isNaN(to) || from === to) { setDisplay(target); return }
    const start = performance.now()
    let raf = 0
    const step = (t: number) => {
      const p = Math.min((t - start) / 400, 1)
      const eased = 1 - (1 - p) ** 3
      const current = from + (to - from) * eased
      setDisplay(target.replace(/[\d.,]+/, current.toFixed(to % 1 ? 2 : 0)))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target])
  return display
}

export default function MetricCard({ label, value, spark, accent }: Props) {
  const display = useTicker(value)
  return (
    <div className="card-lift flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">{label}</span>
      <div className="mt-0.5 flex items-end justify-between gap-2">
        <span className={`mono text-xl font-semibold ${accent ? 'text-[var(--accent-hover)]' : 'text-[var(--text)]'}`}>{display}</span>
        {spark && <Sparkline values={spark} />}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create `web/src/components/ProjectCard.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query'
import type { Project, GithubStatus } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'

function ciState(gh?: GithubStatus): 'passing' | 'failing' | 'unknown' {
  const latest = gh?.ci?.[0]
  if (!latest || !latest.conclusion) return 'unknown'
  return latest.conclusion === 'success' ? 'passing' : 'failing'
}

export default function ProjectCard({ project }: { project: Project }) {
  const { data: gh } = useQuery<GithubStatus>({
    queryKey: ['github', project.id],
    queryFn: () => api.projects.github(project.id),
    refetchInterval: 60_000,
  })
  const ci = ciState(gh)
  const openPrs = gh?.prs.filter(p => p.state === 'OPEN').length ?? 0
  const attention = ci === 'failing'

  return (
    <div
      className={cn(
        'card-lift rounded-lg border bg-[var(--surface)] p-4',
        attention ? 'border-[var(--amber)]/40' : 'border-[var(--border)]'
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn('h-2 w-2 rounded-full', {
            'bg-[var(--green)]': ci === 'passing',
            'bg-[var(--amber)] glow-live': ci === 'failing',
            'bg-[var(--muted)]': ci === 'unknown',
          })}
        />
        <span className="truncate text-sm font-semibold text-[var(--text)]">{project.name}</span>
        {project.healthScore != null && (
          <span className="mono ml-auto text-xs text-[var(--muted)]">{project.healthScore}/100</span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-[var(--muted)]">
        {project.githubRemote ? (
          <>
            <span className={ci === 'failing' ? 'text-[var(--amber)]' : ''}>
              CI {ci === 'passing' ? '✓' : ci === 'failing' ? '✗ failing' : '—'}
            </span>
            {' · '}{openPrs} open PR{openPrs === 1 ? '' : 's'}
          </>
        ) : (
          'no GitHub remote — registry invariant unmet'
        )}
      </p>
      <p className="mono mt-2 truncate text-[10px] text-[var(--muted)] opacity-60">{project.localPath}</p>
    </div>
  )
}
```

- [ ] **Step 4: Create `web/src/pages/Home.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query'
import type { MetricsSummary, Project } from '@k/shared'
import { api } from '../lib/api'
import MetricCard from '../components/MetricCard'
import ProjectCard from '../components/ProjectCard'
import { navigate } from '../lib/route'

export default function Home() {
  const { data: metrics } = useQuery<MetricsSummary>({
    queryKey: ['metrics'],
    queryFn: api.metrics.summary,
    refetchInterval: 30_000,
  })
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ['projects'], queryFn: api.projects.list })

  const spark = (pick: (d: MetricsSummary['daily'][number]) => number) =>
    metrics ? metrics.daily.map(pick) : undefined

  return (
    <div className="h-full overflow-y-auto p-5">
      {/* metrics row */}
      <div className="flex gap-3">
        <MetricCard
          label="Tokens today"
          value={metrics ? `${(metrics.today.tokens / 1000).toFixed(1)}k` : '—'}
          spark={spark(d => d.tokens)}
        />
        <MetricCard
          label="Cost today"
          value={metrics ? `$${metrics.today.costUsd.toFixed(2)}` : '—'}
          spark={spark(d => d.costUsd)}
        />
        <MetricCard label="Active runs" value={metrics ? String(metrics.activeRuns) : '—'} accent />
        <MetricCard label="Runs today" value={metrics ? String(metrics.today.runs) : '—'} spark={spark(d => d.runs)} />
        <MetricCard label="Total runs" value={metrics ? String(metrics.totalRuns) : '—'} />
      </div>

      {/* projects */}
      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Projects</h2>
        <button
          onClick={() => navigate('projects')}
          className="text-xs text-[var(--accent-hover)] transition-colors duration-150 hover:text-[var(--text)]"
        >
          manage →
        </button>
      </div>
      {projects.length === 0 ? (
        <button
          onClick={() => navigate('projects')}
          className="card-lift mt-3 flex w-full items-center justify-center rounded-lg border border-dashed border-[var(--border)] py-10 text-sm text-[var(--muted)]"
        >
          + register your first project
        </button>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-3">
          {projects.map(p => <ProjectCard key={p.id} project={p} />)}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Typecheck + visual**

Run: `pnpm --filter @k/web typecheck` → clean. Visual: metric numerals count up on load/refresh, sparklines render, project grid (or dashed empty state), card hover lift works.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Sparkline.tsx web/src/components/MetricCard.tsx web/src/components/ProjectCard.tsx web/src/pages/Home.tsx
git commit -m "feat(web): Home — animated metrics row + project cards"
```

---

### Task 12: Runs page (restyle existing console)

RunList + RunConsole survive with token updates; the page composes them and syncs selection to the hash route.

**Files:**
- Create: `web/src/pages/RunsPage.tsx` (replaces placeholder)
- Modify: `web/src/components/RunList.tsx` (token alignment only)
- Modify: `web/src/components/RunConsole.tsx` (token alignment only)

- [ ] **Step 1: Create `web/src/pages/RunsPage.tsx`**

```tsx
import RunList from '../components/RunList'
import RunConsole from '../components/RunConsole'
import { navigate } from '../lib/route'

export default function RunsPage({ runId }: { runId?: string }) {
  return (
    <div className="flex h-full">
      <aside className="w-72 flex-shrink-0 overflow-hidden border-r border-[var(--border)]">
        <RunList selectedId={runId ?? null} onSelect={id => navigate('runs', id)} />
      </aside>
      <main className="flex-1 overflow-hidden">
        {runId ? (
          <RunConsole runId={runId} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="text-4xl opacity-40">▶</div>
            <p className="text-sm text-[var(--muted)]">Select a run — or press <kbd className="mono rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px]">⌘K</kbd> to dispatch one.</p>
          </div>
        )}
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Restyle `RunList.tsx`** — replace the two color maps (keep everything else):

```ts
const STATUS_COLOR: Record<string, string> = {
  queued:  'bg-[var(--amber)]/15 text-[var(--amber)]',
  running: 'bg-[var(--accent)]/15 text-[var(--accent-hover)]',
  done:    'bg-[var(--green)]/15 text-[var(--green)]',
  error:   'bg-[var(--red)]/15 text-[var(--red)]',
  killed:  'bg-[var(--muted)]/15 text-[var(--muted)]',
}

const STATUS_DOT: Record<string, string> = {
  queued:  'bg-[var(--amber)]',
  running: 'bg-[var(--accent)] glow-live',
  done:    'bg-[var(--green)]',
  error:   'bg-[var(--red)]',
  killed:  'bg-[var(--muted)]',
}
```

Also make the cost + timestamp lines mono: add `mono` to the two `text-xs text-[var(--muted)]` spans showing `$…` and the time/model line.

- [ ] **Step 3: Restyle `RunConsole.tsx`** — replace the status badge class map inside the `cn(…)` call:

```ts
'bg-[var(--accent)]/15 text-[var(--accent-hover)] glow-live': run.status === 'running',
'bg-[var(--green)]/15 text-[var(--green)]': run.status === 'done',
'bg-[var(--red)]/15 text-[var(--red)]': run.status === 'error',
'bg-[var(--amber)]/15 text-[var(--amber)]': run.status === 'queued',
'bg-[var(--muted)]/15 text-[var(--muted)]': run.status === 'killed',
```

and update `EVENT_COLOR` to tokens:

```ts
const EVENT_COLOR: Record<string, string> = {
  system:    'text-[var(--muted)]',
  assistant: 'text-[var(--text)]',
  user:      'text-[var(--accent-hover)]',
  usage:     'text-[var(--green)]',
  error:     'text-[var(--red)]',
  status:    'text-[var(--amber)]',
}
```

- [ ] **Step 4: Typecheck + visual + commit**

Run: `pnpm --filter @k/web typecheck` → clean. Visual: #/runs shows the two-pane layout; dispatch a run via ⌘K and watch the live console stream with the pulsing running badge.

```bash
git add web/src/pages/RunsPage.tsx web/src/components/RunList.tsx web/src/components/RunConsole.tsx
git commit -m "feat(web): Runs page on Command Deck tokens"
```

---

### Task 13: Docs page — artifact rail + DocViewer

**Files:**
- Create: `web/src/pages/DocsPage.tsx` (replaces placeholder)
- Modify: `web/src/components/DocViewer.tsx` (default to html view — the compiled bible IS the rich view)

- [ ] **Step 1: Create `web/src/pages/DocsPage.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query'
import type { Artifact } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { navigate } from '../lib/route'
import DocViewer from '../components/DocViewer'

export default function DocsPage({ slug }: { slug?: string }) {
  const { data: artifacts = [] } = useQuery<Omit<Artifact, 'md' | 'html'>[]>({
    queryKey: ['artifacts'],
    queryFn: api.artifacts.list,
  })
  const active = slug ?? 'project-bible'

  return (
    <div className="flex h-full">
      <aside className="w-64 flex-shrink-0 overflow-y-auto border-r border-[var(--border)]">
        <div className="border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Artifacts</h2>
        </div>
        {artifacts.map(a => (
          <button
            key={a.slug}
            onClick={() => navigate('docs', a.slug)}
            className={cn(
              'block w-full border-b border-[var(--border)] px-4 py-2.5 text-left transition-colors duration-150 hover:bg-[var(--surface)]',
              active === a.slug && 'border-l-2 border-l-[var(--accent)] bg-[var(--surface)]'
            )}
          >
            <span className="block truncate text-sm text-[var(--text)]">{a.title}</span>
            <span className="mono text-[10px] text-[var(--muted)]">
              {new Date(a.updatedAt).toLocaleDateString()}
              {a.tags.includes('bible') && ' · 📖 bible'}
            </span>
          </button>
        ))}
      </aside>
      <main className="flex-1 overflow-hidden">
        <DocViewer slug={active} />
      </main>
    </div>
  )
}
```

- [ ] **Step 2: In `DocViewer.tsx`** change the initial state so the rich compiled view is the default:

```ts
const [view, setView] = useState<'md' | 'html'>('html')
```

- [ ] **Step 3: Typecheck + visual + commit**

Run: `pnpm --filter @k/web typecheck` → clean. Visual: #/docs lists artifacts, bible opens in the compiled HTML view (sidebar nav, progress bars) inside the iframe.

```bash
git add web/src/pages/DocsPage.tsx web/src/components/DocViewer.tsx
git commit -m "feat(web): Docs page with artifact rail; compiled bible as default view"
```

---

### Task 14: Projects page — register + GitHub status

**Files:**
- Create: `web/src/pages/ProjectsPage.tsx` (replaces placeholder)

- [ ] **Step 1: Create `web/src/pages/ProjectsPage.tsx`**

```tsx
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import type { Project } from '@k/shared'
import { api } from '../lib/api'
import ProjectCard from '../components/ProjectCard'

export default function ProjectsPage() {
  const qc = useQueryClient()
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ['projects'], queryFn: api.projects.list })
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const isUrl = /^(https:\/\/|git@)/.test(source.trim())

  const register = useMutation({
    mutationFn: () =>
      api.projects.register({
        name: name.trim(),
        ...(isUrl ? { githubUrl: source.trim() } : { localPath: source.trim() }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      setOpen(false); setName(''); setSource('')
    },
  })

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Fleet · {projects.length} project{projects.length === 1 ? '' : 's'}
        </h2>
        <button
          onClick={() => setOpen(true)}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity duration-150 hover:opacity-90"
        >
          + register project
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-3">
        {projects.map(p => <ProjectCard key={p.id} project={p} />)}
      </div>
      {projects.length === 0 && (
        <p className="mt-10 text-center text-sm text-[var(--muted)]">
          No projects yet. Register an existing local repo, or paste a GitHub URL to clone it into the workspace.
        </p>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
            <motion.div
              className="relative w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
              initial={{ y: 12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 12, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            >
              <h3 className="text-sm font-semibold text-[var(--text)]">Register project</h3>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Local path registers in place · GitHub URL clones into <span className="mono">workspace/</span>
              </p>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="name (e.g. gitnexus)"
                className="mt-4 w-full rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2 text-sm text-[var(--text)] placeholder-[var(--muted)] outline-none focus:border-[var(--accent)]"
              />
              <input
                value={source}
                onChange={e => setSource(e.target.value)}
                placeholder="C:\path\to\repo — or — https://github.com/owner/repo"
                className="mono mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2 text-xs text-[var(--text)] placeholder-[var(--muted)] outline-none focus:border-[var(--accent)]"
              />
              <div className="mt-4 flex items-center justify-between">
                <span className="text-[11px] text-[var(--muted)]">
                  {register.isError ? `⚠ ${String(register.error)}` : isUrl ? 'will clone via gh' : source ? 'will register path' : ''}
                </span>
                <button
                  onClick={() => register.mutate()}
                  disabled={!name.trim() || !source.trim() || register.isPending}
                  className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
                >
                  {register.isPending ? 'registering…' : 'Register →'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck + visual + commit**

Run: `pnpm --filter @k/web typecheck` → clean. Visual: register this repo (`jarvis-core`, `C:\Users\ckbra\desktop\k`) through the dialog → card appears; if `gh` is authenticated and the repo has a remote, CI/PR state fills in within a poll cycle.

```bash
git add web/src/pages/ProjectsPage.tsx
git commit -m "feat(web): Projects page — fleet grid + register dialog"
```

---

### Task 15: Keyboard chords + final polish

**Files:**
- Modify: `web/src/shell/Shell.tsx`

- [ ] **Step 1: Add `g`-chord navigation** to the keydown handler in Shell.tsx (bible §6: `g` then first letter). Replace the existing keydown `useEffect` with:

```tsx
  useEffect(() => {
    let chord = false
    let chordTimer: ReturnType<typeof setTimeout>
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCommandOpen(o => !o)
        return
      }
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey) {
        chord = true
        clearTimeout(chordTimer)
        chordTimer = setTimeout(() => { chord = false }, 800)
        return
      }
      if (chord) {
        const map: Record<string, string> = { h: 'home', p: 'projects', r: 'runs', d: 'docs' }
        if (map[e.key]) { e.preventDefault(); navigate(map[e.key]) }
        chord = false
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
```

with the import: `import { useHashRoute, navigate } from '../lib/route'`

- [ ] **Step 2: Polish checklist** (fix anything that fails):

- Tab through the sidebar: focus rings visible on every interactive element
- OS reduced-motion on → ambient stops drifting, pulses stop (CSS media query from Task 7)
- Narrow window (~900px): no horizontal overflow; metrics row wraps acceptably (add `flex-wrap` to the metrics row container in Home.tsx if it doesn't)
- Every numeral on screen is `mono`

- [ ] **Step 3: Typecheck + commit**

```bash
git add web/src/shell/Shell.tsx web/src/pages/Home.tsx
git commit -m "feat(web): g-chord navigation + a11y polish"
```

---

### Task 16: End-to-end verification pass (Phase 0 exit)

The Phase 0 completion gate. Run everything for real and check each behavior. Fix-and-recheck anything that fails before committing.

- [ ] **Step 1: Full test + typecheck sweep**

```bash
pnpm --filter @k/core test
pnpm --filter @k/shared typecheck; pnpm --filter @k/core typecheck; pnpm --filter @k/web typecheck
```

Expected: all tests pass, all typechecks clean.

- [ ] **Step 2: Boot both processes** — `pnpm dev` (or two terminals). Expected core log: bible compiled, server listening, `[github] poller started`.

- [ ] **Step 3: E2E checklist** (browser at http://localhost:5173)

| # | Check | Pass criteria |
|---|-------|---------------|
| 1 | Shell renders | sidebar, top bar, ambient glow, activity strip; no console errors |
| 2 | Connection dot | green with pulse within ~2s |
| 3 | ⌘K dispatch | type "create a file named hello.txt containing hello world" → Enter → lands on #/runs/:id, events stream live, status badge pulses while running |
| 4 | Run completes | status → done, cost/tokens non-zero in header, activity strip "last:" updates, metrics row counts up |
| 5 | Kill switch | dispatch a long prompt, press Kill → status killed within 5s |
| 6 | ⌘K navigate | typing "doc" surfaces Docs; Enter navigates |
| 7 | g-chords | `g h`/`g p`/`g r`/`g d` switch stages with 250ms transition |
| 8 | Docs | bible renders in compiled HTML view; section nav + progress bars work inside iframe |
| 9 | Projects | register `jarvis-core` with local path → card renders; with `gh` authed + remote, CI/PR state appears ≤ 60s |
| 10 | Metrics endpoint | `Invoke-RestMethod http://localhost:3001/api/metrics/summary -Headers @{Authorization='Bearer dev-token-change-me'}` → today/activeRuns/daily[14] |
| 11 | WS reconnect | restart core; web reconnects within ~3s, dot returns to green |
| 12 | Deep link | reload on #/runs/:id → same run console restored |

- [ ] **Step 4: Mark the run** — if any check fails, fix, re-run the failing check, and only then proceed.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: e2e verification pass fixes (Phase 0 exit)"
```

(Skip the commit if no fixes were needed.)

---

### Task 17: Documentation + bible update

The bible must reflect reality the moment the code does (bible §1 principle 3).

**Files:**
- Modify: `artifacts/bible/sections/07-roadmap.md`
- Modify: `artifacts/bible/sections/09-operations.md`
- Modify: `artifacts/bible/sections/02-architecture.md`

- [ ] **Step 1: Update `07-roadmap.md`**

Phase 0: check the two remaining boxes (`Fastify REST + WS gateway end-to-end verification pass`, `React dashboard skeleton…` — reword the latter to `React dashboard — Command Deck shell (sidebar · ⌘K · stage · activity strip)`).
Phase 1: check `Project registry API + onboarding skill` → split it: `- [x] Project registry API (register path / clone URL)` and `- [ ] Onboarding skill (scaffold bible + CI)`. Check `GitHubProvider via gh CLI — PR list/status, CI runs, polling + SQLite cache`. Add `- [x] Metrics summary endpoint + dashboard metrics row` if not present.
Bump frontmatter `updated:` to the completion date.

- [ ] **Step 2: Update `09-operations.md`** — in the Environment block add:

```
GITHUB_POLL_MS=60000                  # gh polling interval
ENABLE_GITHUB_POLL=true               # set false to disable
```

In Key files add `core/src/github.ts`, `core/src/projects.ts`, `core/src/metrics.ts` rows, and add a row to Data locations: `| Cloned workspaces | workspace/ | no |`. Bump `updated:`.

- [ ] **Step 3: Update `02-architecture.md`** — in the ASCII diagram, change `github.ts(→P1)` to `github.ts`, and `projects(→P1)` to `projects · metrics`. Bump `updated:`.

- [ ] **Step 4: Recompile + verify**

With core running: `Invoke-RestMethod -Uri http://localhost:3001/api/bible/compile -Method Post -Headers @{Authorization='Bearer dev-token-change-me'}`
Expected: `sections: 9`. Open `artifacts/project-bible.html` → roadmap bars reflect the new checkbox state; Phase 0 reads 100%.

- [ ] **Step 5: Commit**

```bash
git add artifacts/bible
git commit -m "docs: bible reflects Phase 0 completion + Phase 1 progress"
```

---

## Verification (whole plan)

1. `pnpm --filter @k/core test` — all unit tests green (bible-parse, events, metrics, projects, github-parse).
2. All three `typecheck`s clean.
3. Task 16 e2e checklist fully passed.
4. Compiled bible shows Phase 0 at 100% and accurate operations/architecture sections.
5. `git log --oneline` shows ~17 small commits, each leaving the tree green.

## Out of scope (next plans)

Fleet/project knowledge graphs (Phase 2, needs GitNexus), verify-project skill, onboarding skill (bible scaffolding), tasks/tickets, web terminal, token time-series charts page, auth hardening.


