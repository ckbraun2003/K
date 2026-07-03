/**
 * Project onboarding — bible §3 invariant enforcement.
 * Checks whether a registered project has a GitHub remote, artifacts/bible/, and
 * .github/workflows/. Scaffolds whatever is missing and reports the result.
 * Also ensures the project's .gitignore ignores the COMPILED artifacts (artifacts/*.html)
 * + the K-system tasks/ dir — while keeping the bible SOURCES (artifacts/bible/**) tracked.
 *
 * No DB calls here: callers fetch the project and pass it in.
 *
 * Deferred follow-ups (NOT implemented here):
 *   (a) Seeding the gitignored tasks/ dir into worktree runs (so per-run agents
 *       get a fresh tasks/todo.md + lessons.md scaffold).
 *   (b) Migrating tasks/todo.md + lessons.md and the bible into K's DB-backed
 *       work_items / agent_memory store (Phase 5).
 */

import fs from 'fs'
import path from 'path'
import type { Project } from '@k/shared'
import { scaffoldBible, scaffoldCi } from './scaffold.js'
import { hasWorkflowFile } from './verify.js'
import { isPathWithin } from './paths.js'

export interface OnboardResult {
  created: string[]
  invariants: {
    githubRemote: boolean   // project.githubRemote is set
    bible: boolean          // artifacts/bible/manifest.json present (a real bible, not just an empty dir)
    ci: boolean             // ≥1 .yml/.yaml file under .github/workflows/ (an empty dir does NOT count)
  }
}

function exists(localPath: string, rel: string): boolean {
  return fs.existsSync(path.join(localPath, ...rel.split('/')))
}

// onboard + scaffoldBible both key on artifacts/bible (the only value registerProject
// produces today). Threading a custom project.bibleDir is deferred until a
// registration path can set one.
const BIBLE_SENTINEL = 'artifacts/bible/manifest.json'

// K-system gitignore entries every managed project gets — mirroring K's OWN
// .gitignore policy exactly:
//   - `artifacts/*.html`  → the COMPILED bible/ui-demo output is generated +
//     overwritten on boot, so it stays out of the repo…
//   - …but the bible SOURCES (`artifacts/bible/**` — manifest.json + sections/)
//     are the living spec and MUST stay git-TRACKED (a blanket `artifacts/`
//     would ignore them, making an authored project bible uncommittable).
//   - `tasks/`            → per-run K working dir (todo.md/lessons.md), never committed.
const GITIGNORE_ENTRIES = ['artifacts/*.html', 'tasks/']

// K-managed entries SUPERSEDED by GITIGNORE_ENTRIES. A project onboarded by an
// OLDER K got a blanket `artifacts/` line, which ignores the now-tracked bible
// sources — and because ensure only *appends* missing entries, re-onboarding would
// leave that stale line in place and silently defeat the fix. We prune it on ensure
// (exact trimmed match only) so an existing project self-heals to the finer policy.
const SUPERSEDED_ENTRIES = new Set(['artifacts/'])

/**
 * Ensure <localPath>/.gitignore contains `artifacts/*.html` and `tasks/`, and that
 * any SUPERSEDED legacy K entry (blanket `artifacts/`) is pruned. Idempotent:
 * creates the file with both lines if absent; otherwise appends only the missing
 * entries (a line equals an entry when trimmed) and removes superseded lines. Never
 * duplicates. Returns ['.gitignore'] if it created or modified the file, else [].
 * Path-guarded: the write target stays strictly under localPath.
 */
export function ensureGitignore(localPath: string): string[] {
  const root = path.resolve(localPath)
  const abs = path.join(root, '.gitignore')
  // Path-guard: mirror scaffold.ts writeIfAbsent — target must stay inside root.
  if (!isPathWithin(root, abs)) {
    throw new Error(`ensureGitignore: path escapes localPath — abs="${abs}", root="${root}"`)
  }

  if (!fs.existsSync(abs)) {
    fs.writeFileSync(abs, GITIGNORE_ENTRIES.join('\n') + '\n', 'utf8')
    return ['.gitignore']
  }

  const existing = fs.readFileSync(abs, 'utf8')
  const lines = existing.split('\n')
  // Prune superseded legacy entries (exact trimmed match).
  const kept = lines.filter(l => !SUPERSEDED_ENTRIES.has(l.trim()))
  const pruned = kept.length !== lines.length

  const present = new Set(kept.map(l => l.trim()))
  const missing = GITIGNORE_ENTRIES.filter(e => !present.has(e))

  // Nothing to prune and nothing missing → already satisfied.
  if (!pruned && missing.length === 0) return []

  let body = kept.join('\n')
  if (missing.length > 0) {
    const prefix = body.length === 0 || body.endsWith('\n') ? '' : '\n'
    body = body + prefix + missing.join('\n') + '\n'
  } else if (body.length > 0 && !body.endsWith('\n')) {
    body = body + '\n'
  }
  fs.writeFileSync(abs, body, 'utf8')
  return ['.gitignore']
}

/**
 * Ensure the three bible §3 invariants are satisfied for `project`.
 * Scaffolds bible + CI for whatever is missing; idempotent. An empty artifacts/bible
 * dir does NOT count — the bible invariant requires a real manifest.json. Likewise
 * the CI invariant requires an actual workflow FILE (via verify.ts hasWorkflowFile),
 * not merely the .github/workflows/ dir — so onboard and verify agree.
 */
export function onboardProject(project: Project): OnboardResult {
  const created: string[] = []
  const root = project.localPath

  if (!exists(root, BIBLE_SENTINEL)) {
    created.push(...scaffoldBible(root))
  }
  if (!hasWorkflowFile(root)) {
    created.push(...scaffoldCi(root))
  }
  // Ignore compiled artifacts (artifacts/*.html) + the tasks/ dir in this project's
  // .gitignore — while keeping the bible sources (artifacts/bible/**) tracked.
  created.push(...ensureGitignore(root))

  return {
    created,
    invariants: {
      githubRemote: !!project.githubRemote,
      bible: exists(root, BIBLE_SENTINEL),
      ci: hasWorkflowFile(root),
    },
  }
}
