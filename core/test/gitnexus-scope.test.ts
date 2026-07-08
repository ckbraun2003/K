/** P1 W0c — offline graph.json → changed-file scope mapping (E-04/E-07 shared leg). */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { isProjectIndexed, loadGraphJson, fileMatches, scopeForFiles, riskForScope, type ScopeGraph } from '../src/gitnexus-scope.js'

const GRAPH: ScopeGraph = {
  nodes: [
    { id: 'n1', name: 'startRun', type: 'Function', file: 'core/src/supervisor.ts' },
    { id: 'n2', name: 'kill', type: 'Function', file: 'core\\src\\supervisor.ts' },
    { id: 'n3', name: 'other', type: 'Function', file: 'core/src/db.ts' },
  ],
  links: [
    { source: 'n3', target: 'n1', type: 'CALLS' },
    { source: 'n2', target: 'n1', type: 'CALLS' },
    { source: 'n1', target: 'n3', type: 'CALLS' },
  ],
}

describe('gitnexus-scope', () => {
  it('fileMatches is separator- and case-tolerant, suffix both directions', () => {
    expect(fileMatches('core\\src\\supervisor.ts', 'core/src/supervisor.ts')).toBe(true)
    expect(fileMatches('C:/repo/core/src/supervisor.ts', 'core/src/supervisor.ts')).toBe(true)
    expect(fileMatches('core/src/db.ts', 'core/src/supervisor.ts')).toBe(false)
  })
  it('scopeForFiles counts inbound dependents per symbol, sorted desc', () => {
    const scopes = scopeForFiles(GRAPH, ['core/src/supervisor.ts'])
    expect(scopes).toHaveLength(1)
    expect(scopes[0].symbols.map(s => s.id)).toEqual(['n1', 'n2'])   // n1: 2 inbound, n2: 0
    expect(scopes[0].symbols[0].dependents).toBe(2)
  })
  it('riskForScope thresholds: null / low / medium / high', () => {
    expect(riskForScope([{ file: 'x', symbols: [] }])).toBeNull()
    expect(riskForScope([{ file: 'x', symbols: [{ id: 'a', name: 'a', type: null, dependents: 1 }] }])).toBe('low')
    expect(riskForScope([{ file: 'x', symbols: [
      { id: 'a', name: 'a', type: null, dependents: 2 },
      { id: 'b', name: 'b', type: null, dependents: 2 },
      { id: 'c', name: 'c', type: null, dependents: 2 },
    ] }])).toBe('medium')
    expect(riskForScope([{ file: 'x', symbols: [{ id: 'a', name: 'a', type: null, dependents: 10 }] }])).toBe('high')
  })
  it('loadGraphJson/isProjectIndexed degrade to null/false, tolerate garbage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-scope-'))
    try {
      expect(isProjectIndexed(dir)).toBe(false)
      expect(loadGraphJson(dir)).toBeNull()
      fs.mkdirSync(path.join(dir, '.gitnexus'))
      fs.writeFileSync(path.join(dir, '.gitnexus', 'meta.json'), '{}')
      fs.writeFileSync(path.join(dir, '.gitnexus', 'graph.json'), 'garbage')
      expect(isProjectIndexed(dir)).toBe(true)
      expect(loadGraphJson(dir)).toBeNull()
      fs.writeFileSync(path.join(dir, '.gitnexus', 'graph.json'),
        JSON.stringify({ nodes: [{ id: 'n1', file: 'a.ts' }, null, { noId: true }], links: [{ source: 'x', target: 'n1' }, null] }))
      const g = loadGraphJson(dir)!
      expect(g.nodes).toHaveLength(1)
      expect(g.links).toHaveLength(1)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
