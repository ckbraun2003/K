import { describe, it, expect } from 'vitest'
import { DELEGATION_WORKFLOW } from '@k/shared'

describe('DELEGATION_WORKFLOW', () => {
  it('has unique role ids', () => {
    const ids = DELEGATION_WORKFLOW.roles.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('includes the four expected roles', () => {
    const ids = new Set(DELEGATION_WORKFLOW.roles.map(r => r.id))
    for (const id of ['controller', 'implementer', 'spec-review', 'quality-review']) {
      expect(ids.has(id), `missing role "${id}"`).toBe(true)
    }
  })

  it('every role has a non-empty label and description', () => {
    for (const role of DELEGATION_WORKFLOW.roles) {
      expect(role.label.length).toBeGreaterThan(0)
      expect(role.description.length).toBeGreaterThan(0)
    }
  })

  it('every edge references existing role ids', () => {
    const ids = new Set(DELEGATION_WORKFLOW.roles.map(r => r.id))
    for (const edge of DELEGATION_WORKFLOW.edges) {
      expect(ids.has(edge.from), `edge.from "${edge.from}" is not a role`).toBe(true)
      expect(ids.has(edge.to), `edge.to "${edge.to}" is not a role`).toBe(true)
    }
  })

  it('forms the loop: both reviews report back to the controller', () => {
    const backToController = DELEGATION_WORKFLOW.edges.filter(e => e.to === 'controller').map(e => e.from)
    expect(backToController).toContain('spec-review')
    expect(backToController).toContain('quality-review')
  })

  it('has EXACTLY the expected edge topology', () => {
    // WorkflowDiagram lays its connectors out by hand and does NOT read
    // `edges`, so changing the topology here would silently diverge from the
    // diagram. Pin the exact (from→to) set so any change trips this test and
    // forces a diagram review. (Order-independent; labels are not pinned.)
    const expected = [
      'controller->implementer',
      'implementer->spec-review',
      'implementer->quality-review',
      'spec-review->controller',
      'quality-review->controller',
    ].sort()
    const actual = DELEGATION_WORKFLOW.edges.map(e => `${e.from}->${e.to}`).sort()
    expect(actual).toEqual(expected)
  })
})
