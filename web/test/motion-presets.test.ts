import { describe, it, expect } from 'vitest'
import { chartDraw, successSweep, stageTransition, staggerContainer, staggerItem } from '../src/lib/motion'

describe('motion v2 presets (impressive-wave W0.7)', () => {
  it('chartDraw draws paths on mount (hidden → visible)', () => {
    expect(chartDraw.hidden).toMatchObject({ pathLength: 0, opacity: 0 })
    expect(chartDraw.visible).toMatchObject({ pathLength: 1, opacity: 1 })
  })
  it('successSweep is a one-shot keyframe glow (idle → sweep)', () => {
    expect(successSweep.idle).toBeTruthy()
    const sweep = successSweep.sweep as unknown as { boxShadow: string[] }
    expect(Array.isArray(sweep.boxShadow)).toBe(true)
    expect(sweep.boxShadow.length).toBe(3)
  })
  it('the existing stage/stagger presets stay exported for the FE lane', () => {
    for (const v of [stageTransition, staggerContainer, staggerItem]) expect(v).toBeTruthy()
  })
})
