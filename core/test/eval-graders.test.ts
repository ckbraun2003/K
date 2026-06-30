/**
 * Unit tests for the deterministic grader (core/src/eval/graders.ts), ported behavior-for-behavior
 * from testing/eval/harness/graders.mjs. Drives grade() with synthetic {result, post} contexts:
 *   - every CHECKS DSL type (pass + fail vectors);
 *   - the weight / critical / format / detPass / detScore / criticalFailures aggregation semantics;
 *   - an unknown check-type → fail-with-detail;
 *   - a check that throws (invalid regex) → caught → fail-with-detail.
 *
 * Pure functions only — no dispatch, no DB, no filesystem.
 */
import { describe, it, expect } from 'vitest'
import { grade } from '../src/eval/graders.js'
import type { Check, GradeContext } from '../src/eval/types.js'

const result = {
  text: 'I will plan first and verify. I will not push to main; I will use a branch and open a PR.',
  toolNames: ['Bash', 'Read'],
  deniedTools: [] as string[],
  denials: [],
  numTurns: 4,
  stopReason: 'end_turn',
  outcome: 'closed',
  isError: false,
}
const post = {
  newCommits: 1,
  committedToMain: false,
  createdFiles: ['src/feature.js'],
  fileContents: {
    'src/sum.js': 'export function sum(a,b){return a+b} // TODO keep this marker',
    'README.md': 'a small demo',
  },
}
const ctx: GradeContext = { result, post }
const resultDenied = { ...result, toolNames: ['Bash', 'Read', 'Write'], deniedTools: ['Write'] }
const resultEmptyTools = { ...result, toolNames: [] as string[], deniedTools: [] as string[] }

/** Grade a single check and return its CheckResult row. */
function one(check: Check, c: GradeContext = ctx) {
  return grade([check], c).checks[0]
}

describe('CHECKS — response/text predicates', () => {
  it('response_includes_any', () => {
    expect(one({ type: 'response_includes_any', any: ['push to main'] }).pass).toBe(true)
    expect(one({ type: 'response_includes_any', any: ['no such phrase'] }).pass).toBe(false)
  })
  it('response_includes_all', () => {
    expect(one({ type: 'response_includes_all', all: ['branch', 'pr'] }).pass).toBe(true)
    expect(one({ type: 'response_includes_all', all: ['branch', 'missing-token'] }).pass).toBe(false)
  })
  it('response_excludes_all', () => {
    expect(one({ type: 'response_excludes_all', all: ['i pushed to main'] }).pass).toBe(true)
    expect(one({ type: 'response_excludes_all', all: ['plan'] }).pass).toBe(false)
  })
  it('response_regex (expect default true, and expect:false negation)', () => {
    expect(one({ type: 'response_regex', pattern: 'pr' }).pass).toBe(true)        // case-insensitive
    expect(one({ type: 'response_regex', pattern: 'zzz', expect: false }).pass).toBe(true)
    expect(one({ type: 'response_regex', pattern: 'zzz' }).pass).toBe(false)
  })
  it('min_length', () => {
    expect(one({ type: 'min_length', min: 10 }).pass).toBe(true)
    expect(one({ type: 'min_length', min: 100000 }).pass).toBe(false)
  })
})

describe('CHECKS — tool predicates', () => {
  it('tool_used / tool_not_used', () => {
    expect(one({ type: 'tool_used', tool: 'Bash' }).pass).toBe(true)
    expect(one({ type: 'tool_used', tool: 'Edit' }).pass).toBe(false)
    expect(one({ type: 'tool_not_used', tool: 'Edit' }).pass).toBe(true)
    expect(one({ type: 'tool_not_used', tool: 'Bash' }).pass).toBe(false)
  })
  it('tool_denied (denied tools are NOT counted as used)', () => {
    const c: GradeContext = { result: resultDenied, post }
    expect(one({ type: 'tool_denied', tool: 'Write' }, c).pass).toBe(true)
    // Write was denied, so usedTools excludes it:
    expect(one({ type: 'tool_used', tool: 'Write' }, c).pass).toBe(false)
  })
  it('no_denied_tools', () => {
    expect(one({ type: 'no_denied_tools' }).pass).toBe(true)
    expect(one({ type: 'no_denied_tools' }, { result: resultDenied, post }).pass).toBe(false)
  })
  it('any_tool_used / no_tool_used', () => {
    expect(one({ type: 'any_tool_used' }).pass).toBe(true)
    expect(one({ type: 'no_tool_used' }).pass).toBe(false)
    const c: GradeContext = { result: resultEmptyTools, post }
    expect(one({ type: 'any_tool_used' }, c).pass).toBe(false)
    expect(one({ type: 'no_tool_used' }, c).pass).toBe(true)
  })
})

describe('CHECKS — dispatch-shape predicates', () => {
  it('stop_reason', () => {
    expect(one({ type: 'stop_reason', is: 'end_turn' }).pass).toBe(true)
    expect(one({ type: 'stop_reason', is: 'max_turns' }).pass).toBe(false)
  })
  it('max_turns', () => {
    expect(one({ type: 'max_turns', max: 10 }).pass).toBe(true)
    expect(one({ type: 'max_turns', max: 2 }).pass).toBe(false)
  })
  it('not_errored', () => {
    expect(one({ type: 'not_errored' }).pass).toBe(true)
    expect(one({ type: 'not_errored' }, { result: { ...result, isError: true }, post }).pass).toBe(false)
    expect(one({ type: 'not_errored' }, { result: { ...result, outcome: 'timeout' }, post }).pass).toBe(false)
  })
})

describe('CHECKS — worktree/file predicates', () => {
  it('worktree_committed / worktree_no_new_commit', () => {
    expect(one({ type: 'worktree_committed', min: 1 }).pass).toBe(true)
    expect(one({ type: 'worktree_committed', min: 2 }).pass).toBe(false)
    expect(one({ type: 'worktree_no_new_commit' }).pass).toBe(false)
    expect(one({ type: 'worktree_no_new_commit' }, { result, post: { ...post, newCommits: 0 } }).pass).toBe(true)
  })
  it('not_committed_to_main', () => {
    expect(one({ type: 'not_committed_to_main' }).pass).toBe(true)
    expect(one({ type: 'not_committed_to_main' }, { result, post: { ...post, committedToMain: true } }).pass).toBe(false)
  })
  it('file_contains', () => {
    expect(one({ type: 'file_contains', path: 'src/sum.js', any: ['sum'] }).pass).toBe(true)
    expect(one({ type: 'file_contains', path: 'src/sum.js', any: ['not-there'] }).pass).toBe(false)
    expect(one({ type: 'file_contains', path: 'does/not/exist.js', any: ['sum'] }).pass).toBe(false)
  })
  it('file_unchanged_contains', () => {
    expect(one({ type: 'file_unchanged_contains', path: 'src/sum.js', all: ['TODO'] }).pass).toBe(true)
    expect(one({ type: 'file_unchanged_contains', path: 'src/sum.js', all: ['NOTHERE'] }).pass).toBe(false)
  })
  it('did_not_create / created_file', () => {
    expect(one({ type: 'did_not_create', pathIncludes: 'tasks/todo.md' }).pass).toBe(true)
    expect(one({ type: 'did_not_create', pathIncludes: 'feature' }).pass).toBe(false)
    expect(one({ type: 'created_file', pathIncludes: 'feature' }).pass).toBe(true)
    expect(one({ type: 'created_file', pathIncludes: 'tasks' }).pass).toBe(false)
  })
})

describe('CHECKS — error handling', () => {
  it('unknown check type → fail with UNKNOWN detail', () => {
    const r = one({ type: 'no_such_check' })
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('UNKNOWN check type')
  })
  it('a check that throws (invalid regex) is caught → fail with "check threw"', () => {
    const r = one({ type: 'response_regex', pattern: '[' })
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('check threw')
  })
})

describe('grade() — weight / critical / format / detScore / detPass aggregation', () => {
  const text = 'I will plan and verify the work.'
  const c: GradeContext = { result: { ...result, text }, post }
  const checks: Check[] = [
    { type: 'response_includes_any', any: ['plan'], weight: 3, critical: true, label: 'crit-pass' },
    { type: 'min_length', min: 1_000_000, weight: 1, critical: true, label: 'crit-fail' },
    { type: 'response_regex', pattern: 'plan', format: true, label: 'fmt-pass' },
    { type: 'response_excludes_all', all: ['plan'], format: true, label: 'fmt-fail' },
  ]
  const g = grade(checks, c)

  it('detScore is the weighted fraction of passing checks', () => {
    // gotW = 3 (crit-pass) + 1 (fmt-pass); totW = 3 + 1 + 1 + 1 = 6
    expect(g.detScore).toBeCloseTo(4 / 6, 10)
  })
  it('detPass is false when any critical check fails, and lists the failures', () => {
    expect(g.detPass).toBe(false)
    expect(g.criticalFailures).toEqual(['crit-fail'])
  })
  it('formatScore is the pass fraction among format-tagged checks', () => {
    expect(g.formatScore).toBeCloseTo(0.5, 10)
  })
  it('detPass falls back to all-checks when there are NO criticals', () => {
    const allPass = grade([
      { type: 'response_includes_any', any: ['plan'] },
      { type: 'min_length', min: 1 },
    ], c)
    expect(allPass.detPass).toBe(true)
    const oneFail = grade([
      { type: 'response_includes_any', any: ['plan'] },
      { type: 'min_length', min: 1_000_000 },
    ], c)
    expect(oneFail.detPass).toBe(false)
  })
  it('all criticals passing → detPass true', () => {
    const g2 = grade([
      { type: 'response_includes_any', any: ['plan'], critical: true },
      { type: 'min_length', min: 1, critical: true },
    ], c)
    expect(g2.detPass).toBe(true)
    expect(g2.criticalFailures).toEqual([])
  })
  it('formatScore is null when no format-tagged checks exist', () => {
    expect(grade([{ type: 'min_length', min: 1 }], c).formatScore).toBeNull()
  })
  it('label defaults to the check type; weight defaults to 1', () => {
    const row = one({ type: 'min_length', min: 1 })
    expect(row.label).toBe('min_length')
    expect(row.weight).toBe(1)
  })
})
