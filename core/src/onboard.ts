/**
 * Project onboarding — bible §3 invariant enforcement.
 * Checks whether a registered project has a GitHub remote, artifacts/bible/, and
 * .github/workflows/. Scaffolds whatever is missing and reports the result.
 * Also ensures the project's .gitignore hides the K-system artifacts/ + tasks/ dirs.
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

// K-system dirs that every project hides + never commits (same name everywhere).
const GITIGNORE_ENTRIES = ['artifacts/', 'tasks/']

/**
 * Ensure <localPath>/.gitignore contains both `artifacts/` and `tasks/`.
 * Idempotent: creates the file with both lines if absent; otherwise appends only
 * the missing entries (a line equals an entry when trimmed). Never duplicates.
 * Returns ['.gitignore'] if it created or modified the file, else [].
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
  const present = new Set(existing.split('\n').map(l => l.trim()))
  const missing = GITIGNORE_ENTRIES.filter(e => !present.has(e))
  if (missing.length === 0) return []

  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  fs.writeFileSync(abs, existing + prefix + missing.join('\n') + '\n', 'utf8')
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
  // Hide the K-system artifacts/ + tasks/ dirs in this project's .gitignore.
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
