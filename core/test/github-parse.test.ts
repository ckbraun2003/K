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
