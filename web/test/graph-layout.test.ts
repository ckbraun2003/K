/**
 * computeGraphLayout — the pure, off-main-thread force layout (D-134). This is the
 * testable core the Web Worker (and the synchronous jsdom/SSR fallback) both run:
 * given a fixed {nodes,links}, it returns one finite {x,y,z} per node id, and is
 * DETERMINISTIC (d3-force-3d seeds a fixed LCG + deterministic phyllotaxis init — no
 * Math.random), so the same input always yields the same positions.
 */
import { describe, it, expect } from 'vitest'
import { computeGraphLayout } from '../src/lib/graph-layout'

const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
const links = [
  { source: 'a', target: 'b' },
  { source: 'b', target: 'c' },
  { source: 'c', target: 'd' },
]

describe('computeGraphLayout', () => {
  it('returns one finite {x,y,z} position per node id', () => {
    const pos = computeGraphLayout(nodes, links, { ticks: 60 })
    expect(pos.map(p => p.id).sort()).toEqual(['a', 'b', 'c', 'd'])
    for (const p of pos) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
      expect(Number.isFinite(p.z)).toBe(true)
    }
  })

  it('is deterministic — identical input yields identical positions', () => {
    const a = computeGraphLayout(nodes, links, { ticks: 60 })
    const b = computeGraphLayout(nodes, links, { ticks: 60 })
    expect(b).toEqual(a)
  })

  it('is PURE — never mutates the caller nodes/links', () => {
    const n = [{ id: 'x' }, { id: 'y' }]
    const l = [{ source: 'x', target: 'y' }]
    computeGraphLayout(n, l, { ticks: 10 })
    expect(n).toEqual([{ id: 'x' }, { id: 'y' }])
    expect(l).toEqual([{ source: 'x', target: 'y' }])
  })

  it('drops links referencing a missing node instead of throwing', () => {
    expect(() =>
      computeGraphLayout([{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'ghost' }], { ticks: 5 }),
    ).not.toThrow()
    const pos = computeGraphLayout([{ id: 'a' }], [{ source: 'a', target: 'nope' }], { ticks: 5 })
    expect(pos).toHaveLength(1)
    expect(pos[0].id).toBe('a')
  })

  it('accepts links whose endpoints are node objects ({id})', () => {
    const pos = computeGraphLayout(
      [{ id: 'a' }, { id: 'b' }],
      [{ source: { id: 'a' }, target: { id: 'b' } }],
      { ticks: 20 },
    )
    expect(pos.map(p => p.id).sort()).toEqual(['a', 'b'])
  })

  it('spreads disconnected nodes apart (charge repulsion applied)', () => {
    const pos = computeGraphLayout([{ id: 'a' }, { id: 'b' }], [], { ticks: 150 })
    const [a, b] = pos
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThan(0)
  })

  it('handles an empty graph without error', () => {
    expect(computeGraphLayout([], [], { ticks: 5 })).toEqual([])
  })
})
