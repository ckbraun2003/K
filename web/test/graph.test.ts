import { describe, it, expect, vi, afterEach } from 'vitest'
import type { GraphDispatchBody, WsMessage } from '@k/shared'
import {
  GRAPH_COLORS,
  GRAPH_LEGEND,
  GRAPH_BG,
  GRAPH_LINK_COLOR,
  DISPATCH_ACTIONS,
  hasFailingFindings,
  nodeColor,
  makeGraphUpdateHandler,
  configureGraphForces,
  applyGraphLod,
  type GraphNode,
} from '../src/lib/graph'
import { readToken } from '../src/lib/tokens'
import { api } from '../src/lib/api'

function node(over: Partial<GraphNode> = {}): GraphNode {
  return { id: 'n1', ...over }
}

describe('nodeColor', () => {
  it('dims nodes that do not match the active filter (filter wins over status)', () => {
    const n = node({ label: 'foo', type: 'error' })
    expect(nodeColor(n, 'zzz')).toBe(GRAPH_COLORS.dim)
  })

  it('still colours a matching node by its status', () => {
    expect(nodeColor(node({ label: 'foo', type: 'error' }), 'fo')).toBe(GRAPH_COLORS.failing)
  })

  it('failing: type==error, group==failing, or a critical finding', () => {
    expect(nodeColor(node({ type: 'error' }), '')).toBe(GRAPH_COLORS.failing)
    expect(nodeColor(node({ group: 'failing' }), '')).toBe(GRAPH_COLORS.failing)
    expect(
      nodeColor(node({ enrichment: { findings: [{ severity: 'critical', area: 'ci', message: 'x' }] } }), ''),
    ).toBe(GRAPH_COLORS.failing)
  })

  it('untested: group==untested, or enriched with a run absent', () => {
    expect(nodeColor(node({ group: 'untested' }), '')).toBe(GRAPH_COLORS.untested)
    expect(nodeColor(node({ enrichment: { inBible: true } }), '')).toBe(GRAPH_COLORS.untested)
  })

  it('healthy accent for a bare node and for an enriched node with a run', () => {
    expect(nodeColor(node(), '')).toBe(GRAPH_COLORS.ok)
    expect(
      nodeColor(node({ enrichment: { lastRun: { runId: 'r', status: 'success', createdAt: 1 } } }), ''),
    ).toBe(GRAPH_COLORS.ok)
  })

  it('a non-critical finding alone does not turn the node red', () => {
    const n = node({ enrichment: { findings: [{ severity: 'warn', area: 'tests', message: 'x' }] } })
    expect(hasFailingFindings(n)).toBe(false)
    // enriched + no lastRun ⇒ untested amber
    expect(nodeColor(n, '')).toBe(GRAPH_COLORS.untested)
  })
})

describe('legend / dispatch action config', () => {
  it('legend covers failing/untested/healthy with the canonical colours', () => {
    expect(GRAPH_LEGEND.map(l => l.color)).toEqual([
      GRAPH_COLORS.failing,
      GRAPH_COLORS.untested,
      GRAPH_COLORS.ok,
    ])
  })

  it('exposes the three dispatch actions in order', () => {
    expect(DISPATCH_ACTIONS.map(a => a.action)).toEqual(['investigate', 'fix', 'explain'])
  })
})

describe('D4 — neutral palette (ui-adjustments)', () => {
  it('GRAPH_BG rides a dedicated --graph-bg token, decoupled from the app --bg', () => {
    expect(GRAPH_BG).toBe(readToken('--graph-bg'))
    expect(GRAPH_BG).not.toBe(readToken('--bg'))
  })

  it('dim status colour rides --muted (graphite), not a chart/accent token', () => {
    expect(GRAPH_COLORS.dim).toBe(readToken('--muted'))
  })

  it('link colour is a low-alpha --muted, not the old sky-blue accent-hover', () => {
    expect(GRAPH_LINK_COLOR).not.toContain('56, 189, 248') // old sky-blue rgb
    expect(GRAPH_LINK_COLOR).toMatch(/^rgba\(\d+, \d+, \d+, 0\.4\)$/)
  })
})

describe('graph_update WS handler', () => {
  const projectId = '00000000-0000-0000-0000-0000000000aa'
  const meta = {
    projectId,
    status: 'ready' as const,
    builtAt: 1,
    lastCommit: 'abc',
    nodeCount: 1,
    edgeCount: 0,
    error: null,
  }

  it('invalidates [graph, projectId] for a matching project update', () => {
    const invalidateQueries = vi.fn()
    makeGraphUpdateHandler(projectId, { invalidateQueries })({ type: 'graph_update', projectId, meta })
    expect(invalidateQueries).toHaveBeenCalledTimes(1)
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['graph', projectId] })
  })

  it('ignores updates for a different project', () => {
    const invalidateQueries = vi.fn()
    makeGraphUpdateHandler(projectId, { invalidateQueries })({
      type: 'graph_update',
      projectId: '00000000-0000-0000-0000-0000000000bb',
      meta: { ...meta, projectId: '00000000-0000-0000-0000-0000000000bb' },
    })
    expect(invalidateQueries).not.toHaveBeenCalled()
  })

  it('ignores non-graph messages', () => {
    const invalidateQueries = vi.fn()
    makeGraphUpdateHandler(projectId, { invalidateQueries })({ type: 'ping' } as WsMessage)
    expect(invalidateQueries).not.toHaveBeenCalled()
  })
})

describe('configureGraphForces', () => {
  function fakeForceGraph() {
    const link = { distance: vi.fn(), strength: vi.fn() }
    const charge = { distance: vi.fn(), strength: vi.fn() }
    const d3Force = vi.fn((name: string) => {
      // One-arg getter form returns a tunable force object.
      if (name === 'link') return link
      if (name === 'charge') return charge
      return undefined
    })
    return { d3Force, d3ReheatSimulation: vi.fn(), link, charge }
  }

  it('registers a collision force and tunes the link/charge forces', () => {
    const fg = fakeForceGraph()
    configureGraphForces(fg, { nodeSize: 7 })
    // collide is registered (2-arg setter form: name + a force fn).
    expect(fg.d3Force).toHaveBeenCalledWith('collide', expect.anything())
    // link/charge getters used, then their tuners applied.
    expect(fg.d3Force).toHaveBeenCalledWith('link')
    expect(fg.d3Force).toHaveBeenCalledWith('charge')
    expect(fg.link.distance).toHaveBeenCalled()
    expect(fg.charge.strength).toHaveBeenCalled()
  })

  it('does NOT reheat the simulation (regression: 3D tick-on-undefined crash)', () => {
    const fg = fakeForceGraph()
    configureGraphForces(fg, { nodeSize: 7 })
    expect(fg.d3ReheatSimulation).not.toHaveBeenCalled()
  })

  it('is a no-op for a null/undefined ref', () => {
    expect(() => configureGraphForces(null)).not.toThrow()
    expect(() => configureGraphForces(undefined)).not.toThrow()
  })
})

describe('applyGraphLod — large-graph level-of-detail guardrail', () => {
  it('returns the graph unchanged (same refs) below the cap', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }]
    const links = [{ source: 'a', target: 'b' }]
    const r = applyGraphLod(nodes, links, 10)
    expect(r.capped).toBe(false)
    expect(r.nodes).toBe(nodes)
    expect(r.links).toBe(links)
    expect(r.total).toBe(2)
    expect(r.shown).toBe(2)
  })

  it('caps to the top-N most-connected nodes and drops dangling links', () => {
    // 'h' is a hub (degree 4); 'lonely' has degree 0.
    const nodes = [{ id: 'h' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'lonely' }]
    const links = [
      { source: 'h', target: 'a' },
      { source: 'h', target: 'b' },
      { source: 'h', target: 'c' },
      { source: 'h', target: 'd' },
    ]
    const r = applyGraphLod(nodes, links, 3)
    expect(r.capped).toBe(true)
    expect(r.total).toBe(6)
    expect(r.shown).toBe(3)
    const ids = r.nodes.map(n => n.id)
    expect(ids).toContain('h') // highest degree survives
    expect(ids).not.toContain('lonely') // degree-0 dropped
    // every surviving link has BOTH endpoints in the kept set
    const kept = new Set(ids)
    for (const l of r.links) {
      expect(kept.has(l.source as string)).toBe(true)
      expect(kept.has(l.target as string)).toBe(true)
    }
  })

  it('breaks equal-degree ties on original order (deterministic)', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const r = applyGraphLod(nodes, [], 2)
    expect(r.nodes.map(n => n.id)).toEqual(['a', 'b'])
  })

  it('resolves object endpoints ({id}) when computing degree', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const links = [{ source: { id: 'a' }, target: { id: 'b' } }]
    const r = applyGraphLod(nodes, links, 2)
    expect(r.shown).toBe(2)
    expect(r.nodes.map(n => n.id).sort()).toEqual(['a', 'b']) // c (degree 0) dropped
  })
})

describe('api.projects graph methods', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubFetch(body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('graphBuild POSTs to /api/projects/:id/graph/build', async () => {
    const fetchMock = stubFetch({ projectId: 'p1', status: 'building' })
    await api.projects.graphBuild('p1')
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/graph/build', { method: 'POST' })
  })

  it('graphDispatch POSTs the body as JSON to /graph/dispatch', async () => {
    const fetchMock = stubFetch({ id: 'run1' })
    const body: GraphDispatchBody = { nodeId: 'svc:foo', file: 'src/foo.ts', action: 'fix' }
    await api.projects.graphDispatch('p1', body)
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/graph/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  })

  it('graph GETs /api/projects/:id/graph', async () => {
    const fetchMock = stubFetch({ nodes: [], links: [], stale: false, status: 'ready', builtAt: 1, nodeCount: 0, edgeCount: 0, error: null })
    await api.projects.graph('p1')
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/graph', undefined)
  })
})
