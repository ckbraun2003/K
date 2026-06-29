// Loads the systems-under-eval registry (systems.json) + each system's cases + rubric text, and
// resolves prompt/degraded files to absolute paths. The registry is the single source of truth for
// what gets evaluated; cases are pure JSON data graded by graders.mjs / judge.mjs.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function repoRoot() {
  // harness lives at <root>/testing/eval/harness
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..')
}

export function loadSystems({ root, only } = {}) {
  const base = root || repoRoot()
  const regPath = path.join(base, 'testing', 'eval', 'systems.json')
  const registry = JSON.parse(readFileSync(regPath, 'utf8'))
  const onlySet = only && only.length ? new Set(only) : null
  const out = []
  for (const s of registry.systems) {
    if (onlySet && !onlySet.has(s.id)) continue
    const abs = (p) => path.isAbsolute(p) ? p : path.join(base, p)
    const promptFile = abs(s.promptFile)
    const degradedFile = s.degradedFile ? abs(s.degradedFile) : ''
    const rubricPath = abs(s.rubric)
    const casesPath = abs(s.casesFile)
    for (const [label, p] of [['promptFile', promptFile], ['rubric', rubricPath], ['casesFile', casesPath]]) {
      if (!existsSync(p)) throw new Error(`system ${s.id}: missing ${label} -> ${p}`)
    }
    if (degradedFile && !existsSync(degradedFile)) throw new Error(`system ${s.id}: missing degradedFile -> ${degradedFile}`)
    const cases = JSON.parse(readFileSync(casesPath, 'utf8'))
    out.push({
      id: s.id,
      title: s.title,
      job: s.job ?? s.title,
      promptFile,
      degradedFile,
      allowedTools: s.allowedTools ?? ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'],
      disallowedTools: s.disallowedTools ?? ['Task'],
      maxTurns: s.maxTurns ?? 14,
      rubricText: readFileSync(rubricPath, 'utf8'),
      cases,
    })
  }
  return out
}
