/**
 * Project onboarding — bible §3 invariant enforcement.
 * Checks whether a registered project has a GitHub remote, docs/bible/, and
 * .github/workflows/. Scaffolds whatever is missing and reports the result.
 *
 * No DB calls here: callers fetch the project and pass it in.
 */

import fs from 'fs'
import path from 'path'
import type { Project } from '@k/shared'
import { scaffoldBible, scaffoldCi } from './scaffold.js'
import { hasWorkflowFile } from './verify.js'

export interface OnboardResult {
  created: string[]
  invariants: {
    githubRemote: boolean   // project.githubRemote is set
    bible: boolean          // docs/bible/manifest.json present (a real bible, not just an empty dir)
    ci: boolean             // ≥1 .yml/.yaml file under .github/workflows/ (an empty dir does NOT count)
  }
}

function exists(localPath: string, rel: string): boolean {
  return fs.existsSync(path.join(localPath, ...rel.split('/')))
}

// onboard + scaffoldBible both key on docs/bible (the only value registerProject
// produces today). Threading a custom project.bibleDir is deferred until a
// registration path can set one.
const BIBLE_SENTINEL = 'docs/bible/manifest.json'

/**
 * Ensure the three bible §3 invariants are satisfied for `project`.
 * Scaffolds bible + CI for whatever is missing; idempotent. An empty docs/bible
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

  return {
    created,
    invariants: {
      githubRemote: !!project.githubRemote,
      bible: exists(root, BIBLE_SENTINEL),
      ci: hasWorkflowFile(root),
    },
  }
}
