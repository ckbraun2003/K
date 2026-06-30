// Loads the systems-under-eval registry (systems.json) + each system's cases + rubric text, and
// resolves prompt/degraded files to absolute paths (ported from testing/eval/harness/systems.mjs).
// The registry is the single source of truth for what gets evaluated; cases are pure JSON data graded
// by graders.ts / judge.ts.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalCase, EvalSystem, SystemRegistry } from './types.js'

export function repoRoot(): string {
  // This module lives at <root>/core/src/eval (built to <root>/core/dist/eval); both are three
  // levels below the repo root, so the same traversal as the original harness resolves correctly.
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..')
}

export function loadSystems({ root, only }: { root?: string; only?: string[] | null } = {}): EvalSystem[] {
  const base = root || repoRoot()
  const regPath = path.join(base, 'testing', 'eval', 'systems.json')
  // narrow JSON boundary: the registry file is authored to the SystemRegistry shape
  const registry = JSON.parse(readFileSync(regPath, 'utf8')) as SystemRegistry
  const onlySet = only && only.length ? new Set(only) : null
  const out: EvalSystem[] = []
  for (const s of registry.systems) {
    if (onlySet && !onlySet.has(s.id)) continue
    const abs = (p: string) => path.isAbsolute(p) ? p : path.join(base, p)
    const promptFile = abs(s.promptFile)
    const degradedFile = s.degradedFile ? abs(s.degradedFile) : ''
    const rubricPath = abs(s.rubric)
    const casesPath = abs(s.casesFile)
    for (const [label, p] of [['promptFile', promptFile], ['rubric', rubricPath], ['casesFile', casesPath]]) {
      if (!existsSync(p)) throw new Error(`system ${s.id}: missing ${label} -> ${p}`)
    }
    if (degradedFile && !existsSync(degradedFile)) throw new Error(`system ${s.id}: missing degradedFile -> ${degradedFile}`)
    // narrow JSON boundary: a cases file is authored as an EvalCase[]
    const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as EvalCase[]
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
