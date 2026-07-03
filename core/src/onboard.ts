/**
 * Project onboarding — bible §3 invariant enforcement.
 * Checks whether a registered project has a GitHub remote, artifacts/bible/, and
 * .github/workflows/. Scaffolds whatever is missing and reports the result.
 * Also ensures the project's .gitignore ignores only the K-system tasks/ dir —
 * keeping ALL of artifacts/ tracked (bible sources AND the composed project-bible.html,
 * the project's own deliverables).
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

// K-system gitignore entries every managed project gets:
//   - `tasks/` → per-run K working dir (todo.md/lessons.md), never committed.
// Everything under `artifacts/` stays git-TRACKED — both the bible SOURCES
// (`artifacts/bible/**` — manifest.json + sections/, the living spec) AND the
// composed `artifacts/project-bible.html`. A registered project's bible is
// recompiled ON REQUEST / on merge (not on every harness boot), so the tracked
// composition doesn't churn, and it's the project's own deliverable — K never
// copies it into its own artifacts/ dir.
const GITIGNORE_ENTRIES = ['tasks/']

// K-managed entries SUPERSEDED by GITIGNORE_ENTRIES — pruned on ensure (exact
// trimmed match) so a project onboarded by an OLDER K self-heals to the current
// policy. Because ensure only *appends* missing entries, a stale ignore line would
// otherwise persist and silently keep the wrong files ignored:
//   - `artifacts/`      → a blanket ignore from the earliest K; hid the bible sources.
//   - `artifacts/*.html`→ an intermediate K; hid the now-tracked composed bible.
const SUPERSEDED_ENTRIES = new Set(['artifacts/', 'artifacts/*.html'])

/**
 * Ensure <localPath>/.gitignore contains `tasks/`, and that
 * any SUPERSEDED legacy K entry (blanket `artifacts/`) is pruned. Idempotent:
 * creates the file with the entry if absent; otherwise appends only the missing
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
  // Ignore only the tasks/ dir — keep everything under artifacts/ tracked (bible
  // sources + the composed project-bible.html, the project's own deliverable).
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
