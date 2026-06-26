import { describe, it, expect, vi } from 'vitest'
import {
  collideRadius,
  configureGraphForces,
  GRAPH_LINK_DISTANCE,
  GRAPH_CHARGE_STRENGTH,
} from '../src/lib/graph'

describe('collideRadius', () => {
  it('adds the default label pad of 4 to the node size', () => {
    expect(collideRadius(5)).toBe(9)
  })

  it('honours a custom pad', () => {
    expect(collideRadius(7, 2)).toBe(9)
  })

  it('is always strictly greater than the node size (circles never touch)', () => {
    for (const size of [1, 5, 7, 12, 30]) {
      expect(collideRadius(size)).toBeGreaterThan(size)
    }
  })
})

describe('configureGraphForces', () => {
  // A fake ForceGraph2D ref: d3Force returns a chainable spy for the link/charge
  // forces and records every call so we can assert what was configured.
  function makeFakeFg() {
    const link = { distance: vi.fn().mockReturnThis(), strength: vi.fn().mockReturnThis() }
    const charge = { distance: vi.fn().mockReturnThis(), strength: vi.fn().mockReturnThis() }
    const d3Force = vi.fn((name: string, force?: unknown) => {
      if (force !== undefined) return undefined // setter form (name, force)
      if (name === 'link') return link
      if (name === 'charge') return charge
      return undefined
    })
    const d3ReheatSimulation = vi.fn()
    return { fg: { d3Force, d3ReheatSimulation }, link, charge, d3Force, d3ReheatSimulation }
  }

  it('registers a collide force (2-arg d3Force setter call)', () => {
    const { fg, d3Force } = makeFakeFg()
    configureGraphForces(fg, { nodeSize: 5 })
    const collideCall = d3Force.mock.calls.find(c => c[0] === 'collide')
    expect(collideCall).toBeDefined()
    expect(collideCall!.length).toBe(2) // (name, force) — the setter form
    expect(collideCall![1]).toBeDefined()
  })

  it('tunes link distance and charge strength to the exported constants', () => {
    const { fg, link, charge } = makeFakeFg()
    configureGraphForces(fg)
    expect(link.distance).toHaveBeenCalledWith(GRAPH_LINK_DISTANCE)
    expect(charge.strength).toHaveBeenCalledWith(GRAPH_CHARGE_STRENGTH)
  })

  it('does NOT reheat the simulation (regression: 3D tick-on-undefined crash)', () => {
    // In the 3D three-forcegraph engine, reheating before the first graphData digest
    // sets engineRunning=true while state.layout is still undefined → tick() crash +
    // black canvas. The graphData digest reheats (alpha=1) with our forces already
    // registered, so an explicit reheat is unnecessary and must not happen here.
    const { fg, d3ReheatSimulation } = makeFakeFg()
    configureGraphForces(fg)
    expect(d3ReheatSimulation).not.toHaveBeenCalled()
  })

  it('is a no-op (does not throw) when given null or undefined', () => {
    expect(() => configureGraphForces(null)).not.toThrow()
    expect(() => configureGraphForces(undefined)).not.toThrow()
  })

  it('does not throw when the link/charge forces are absent (getter returns undefined)', () => {
    const fg = { d3Force: vi.fn().mockReturnValue(undefined), d3ReheatSimulation: vi.fn() }
    expect(() => configureGraphForces(fg)).not.toThrow()
    expect(fg.d3ReheatSimulation).not.toHaveBeenCalled()
  })
})
