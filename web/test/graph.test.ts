import { describe, it, expect, vi, afterEach } from 'vitest'
import type { GraphDispatchBody, WsMessage } from '@k/shared'
import {
  GRAPH_COLORS,
  GRAPH_LEGEND,
  DISPATCH_ACTIONS,
  hasFailingFindings,
  nodeColor,
  makeGraphUpdateHandler,
  type GraphNode,
} from '../src/lib/graph'
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
