import { describe, it, expect } from 'vitest'
import { parsePrList, parseCiRuns, parseIssueList } from '../src/github-parse.js'

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

  it('reports passing when all checks succeed', () => {
    const prs = parsePrList([{ number: 1, title: 't', state: 'OPEN', url: 'u', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'success' }] }])
    expect(prs[0].checks).toBe('passing')
  })

  it('treats SKIPPED and NEUTRAL as passing', () => {
    const prs = parsePrList([{ number: 1, title: 't', state: 'OPEN', url: 'u', statusCheckRollup: [{ conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' }] }])
    expect(prs[0].checks).toBe('passing')
  })

  it('prefers failing over pending', () => {
    const prs = parsePrList([{ number: 1, title: 't', state: 'OPEN', url: 'u', statusCheckRollup: [{ conclusion: null }, { conclusion: 'FAILURE' }] }])
    expect(prs[0].checks).toBe('failing')
  })
})

// P2 E-06 — the rollup now also reads StatusContext rows, which carry `state`
// (SUCCESS | PENDING | EXPECTED | FAILURE | ERROR) rather than a CheckRun's
// `conclusion`. K's own k/verify commit status is a StatusContext. The CheckRun
// row below was captured live (ckbraun2003/KAT PR#2, `gh pr view 2 --json
// statusCheckRollup`); the StatusContext shape is the documented GraphQL
// StatusContext union member (a live write to capture one was sandbox-blocked as
// an external mutation — this documented shape is the sanctioned fallback).
describe('parsePrList — StatusContext rollup (P2 E-06)', () => {
  // REAL CheckRun row (captured live from ckbraun2003/KAT PR#2).
  const checkRunOk = { __typename: 'CheckRun', name: 'Engine + Tests', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'Terminal Build CI' }
  const statusCtx = (state: string) => ({ __typename: 'StatusContext', context: 'k/verify', state })
  const rollup = (entries: unknown[]) =>
    parsePrList([{ number: 1, title: 't', state: 'OPEN', url: 'u', statusCheckRollup: entries }])[0].checks

  it('CheckRun SUCCESS + StatusContext k/verify SUCCESS → passing', () => {
    expect(rollup([checkRunOk, statusCtx('SUCCESS')])).toBe('passing')
  })
  it('a PENDING StatusContext → pending', () => {
    expect(rollup([checkRunOk, statusCtx('PENDING')])).toBe('pending')
  })
  it('an EXPECTED StatusContext → pending', () => {
    expect(rollup([checkRunOk, statusCtx('EXPECTED')])).toBe('pending')
  })
  it('a FAILURE StatusContext → failing', () => {
    expect(rollup([checkRunOk, statusCtx('FAILURE')])).toBe('failing')
  })
  it('an ERROR StatusContext → failing', () => {
    expect(rollup([checkRunOk, statusCtx('ERROR')])).toBe('failing')
  })
})

describe('parsePrList — headRefName mapping (P2 E-06)', () => {
  it('maps a string headRefName; absent/non-string → undefined', () => {
    const prs = parsePrList([
      { number: 1, title: 'linked', state: 'OPEN', url: 'u', headRefName: 'k-review/abcdef01' },
      { number: 2, title: 'no-ref', state: 'OPEN', url: 'u' },
      { number: 3, title: 'bad-ref', state: 'OPEN', url: 'u', headRefName: 42 },
    ])
    expect(prs[0].headRefName).toBe('k-review/abcdef01')
    expect(prs[1].headRefName).toBeUndefined()
    expect(prs[2].headRefName).toBeUndefined()
  })
})

describe('parseIssueList', () => {
  it('maps gh issue list --json output', () => {
    const gh = [
      { number: 7, title: 'Bug: crash', state: 'OPEN', url: 'https://github.com/o/r/issues/7' },
      { number: 5, title: 'Done thing', state: 'CLOSED', url: 'https://github.com/o/r/issues/5' },
    ]
    expect(parseIssueList(gh)).toEqual([
      { number: 7, title: 'Bug: crash', state: 'OPEN', url: 'https://github.com/o/r/issues/7' },
      { number: 5, title: 'Done thing', state: 'CLOSED', url: 'https://github.com/o/r/issues/5' },
    ])
  })

  it('defaults missing state/url and tolerates garbage input', () => {
    expect(parseIssueList(null)).toEqual([])
    expect(parseIssueList('nope')).toEqual([])
    // per-row guard drops malformed rows (missing number / non-string title)
    expect(parseIssueList([{ bogus: true }, { number: 1 }, { number: 'x', title: 't' }])).toEqual([])
    expect(parseIssueList([{ number: 3, title: 'no state' }])).toEqual([
      { number: 3, title: 'no state', state: 'OPEN', url: '' },
    ])
  })

  it('drops non-http(s) url schemes at the ingest boundary (XSS-href defense)', () => {
    const out = parseIssueList([
      { number: 1, title: 'evil', state: 'OPEN', url: 'javascript:alert(1)' },
      { number: 2, title: 'evil2', state: 'OPEN', url: 'data:text/html,<script>x</script>' },
      { number: 3, title: 'ok', state: 'OPEN', url: 'https://github.com/o/r/issues/3' },
    ])
    expect(out.map(i => i.url)).toEqual(['', '', 'https://github.com/o/r/issues/3'])
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

  // INT.2 FE IN-2 — durationMs = updatedAt - createdAt, COMPLETED runs only.
  it('computes durationMs for a completed run carrying updatedAt', () => {
    const gh = [{
      databaseId: 9, workflowName: 'CI', headBranch: 'main', status: 'completed',
      conclusion: 'success', createdAt: '2026-06-10T10:00:00Z', updatedAt: '2026-06-10T10:03:12Z',
    }]
    expect(parseCiRuns(gh)[0].durationMs).toBe(192_000)
  })
  it('omits durationMs while a run is still in_progress/queued, even if updatedAt is present', () => {
    const gh = [{
      databaseId: 10, workflowName: 'CI', headBranch: 'main', status: 'in_progress',
      conclusion: null, createdAt: '2026-06-10T10:00:00Z', updatedAt: '2026-06-10T10:01:00Z',
    }]
    expect(parseCiRuns(gh)[0].durationMs).toBeUndefined()
  })
  it('omits durationMs for a completed run missing updatedAt (never fabricated)', () => {
    const gh = [{
      databaseId: 11, workflowName: 'CI', headBranch: 'main', status: 'completed',
      conclusion: 'success', createdAt: '2026-06-10T10:00:00Z',
    }]
    expect(parseCiRuns(gh)[0].durationMs).toBeUndefined()
  })
})
