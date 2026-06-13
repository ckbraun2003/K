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

export interface OnboardResult {
  created: string[]
  invariants: {
    githubRemote: boolean   // project.githubRemote is set
    bible: boolean          // docs/bible/ exists (after scaffolding)
    ci: boolean             // .github/workflows/ exists (after scaffolding)
  }
}

function dirExists(localPath: string, rel: string): boolean {
  return fs.existsSync(path.join(localPath, ...rel.split('/')))
}

/**
 * Ensure the three bible §3 invariants are satisfied for `project`.
 * Scaffolds bible + CI for whatever is missing; idempotent.
 */
export function onboardProject(project: Project): OnboardResult {
  const created: string[] = []
  const root = project.localPath

  // scaffoldBible hardcodes docs/bible — consistent with the default bibleDir
  if (!dirExists(root, 'docs/bible')) {
    created.push(...scaffoldBible(root))
  }

  if (!dirExists(root, '.github/workflows')) {
    created.push(...scaffoldCi(root))
  }

  return {
    created,
    invariants: {
      githubRemote: !!project.githubRemote,
      bible: dirExists(root, 'docs/bible'),
      ci: dirExists(root, '.github/workflows'),
    },
  }
}
