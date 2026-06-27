import { describe, it, expect } from 'vitest'
import type { AgentEvent } from '@k/shared'
import {
  latestContextTokens,
  contextPressure,
  nextAutoCompact,
  CONTEXT_WARN_PCT,
  CONTEXT_DANGER_PCT,
  type AutoCompactInputs,
} from '../src/lib/context'

const MODEL = 'claude-opus-4-8' // 200_000 context window
const LIMIT = 200_000

let seq = 0
function ev(over: Partial<AgentEvent>): AgentEvent {
  return { id: `e${seq}`, runId: 'r', seq: seq++, type: 'assistant', ts: 0, ...over }
}

describe('latestContextTokens', () => {
  it('picks the context signal from the event with the highest seq (not array order)', () => {
    const events: AgentEvent[] = [
      { id: 'a', runId: 'r', seq: 5, type: 'assistant', ts: 0, contextTokens: 5000 },
      { id: 'b', runId: 'r', seq: 2, type: 'assistant', ts: 0, contextTokens: 2000 },
      { id: 'c', runId: 'r', seq: 9, type: 'assistant', ts: 0, contextTokens: 9000 },
    ]
    expect(latestContextTokens(events)).toBe(9000)
  })

  it('prefers contextTokens over tokensIn on the same event', () => {
    expect(latestContextTokens([ev({ seq: 1, contextTokens: 8000, tokensIn: 100 })])).toBe(8000)
  })

  it('on a seq tie the FIRST event wins (strictly-greater comparison)', () => {
    const events: AgentEvent[] = [
      { id: 'a', runId: 'r', seq: 4, type: 'assistant', ts: 0, contextTokens: 1000 },
      { id: 'b', runId: 'r', seq: 4, type: 'assistant', ts: 0, contextTokens: 2000 },
    ]
    expect(latestContextTokens(events)).toBe(1000)
  })

  it('falls back to tokensIn when contextTokens is absent', () => {
    expect(latestContextTokens([ev({ seq: 1, tokensIn: 1234 })])).toBe(1234)
  })

  it('ignores events with no context signal when finding the max seq', () => {
    const events: AgentEvent[] = [
      { id: 'a', runId: 'r', seq: 1, type: 'assistant', ts: 0, contextTokens: 3000 },
      // higher seq but no signal — must NOT zero out the result
      { id: 'b', runId: 'r', seq: 9, type: 'assistant', ts: 0, text: 'just talking' },
    ]
    expect(latestContextTokens(events)).toBe(3000)
  })

  it('returns 0 for an empty array', () => {
    expect(latestContextTokens([])).toBe(0)
  })

  it('never throws on malformed / partial events and defaults to 0', () => {
    const malformed = [
      undefined,
      null,
      { id: 'm1' },
      { id: 'm2', seq: 'nope', contextTokens: 'bad' },
      {},
    ] as unknown as AgentEvent[]
    expect(() => latestContextTokens(malformed)).not.toThrow()
    expect(latestContextTokens(malformed)).toBe(0)
  })

  it('tolerates a null/undefined events argument', () => {
    expect(latestContextTokens(undefined as unknown as AgentEvent[])).toBe(0)
  })
})

describe('contextPressure — known model bands', () => {
  it('69% → ok', () => {
    const p = contextPressure([ev({ seq: 1, contextTokens: 0.69 * LIMIT })], MODEL)
    expect(p.limit).toBe(LIMIT)
    expect(Math.round(p.percent!)).toBe(69)
    expect(p.band).toBe('ok')
  })

  it('exactly 70% → warn (boundary)', () => {
    const p = contextPressure([ev({ seq: 1, contextTokens: 0.7 * LIMIT })], MODEL)
    expect(p.percent).toBe(CONTEXT_WARN_PCT)
    expect(p.band).toBe('warn')
  })

  it('89% → warn', () => {
    const p = contextPressure([ev({ seq: 1, contextTokens: 0.89 * LIMIT })], MODEL)
    expect(p.band).toBe('warn')
  })

  it('exactly 90% → danger (boundary)', () => {
    const p = contextPressure([ev({ seq: 1, contextTokens: 0.9 * LIMIT })], MODEL)
    expect(p.percent).toBe(CONTEXT_DANGER_PCT)
    expect(p.band).toBe('danger')
  })

  it('clamps an over-limit context to 100%', () => {
    const p = contextPressure([ev({ seq: 1, contextTokens: LIMIT * 2 })], MODEL)
    expect(p.percent).toBe(100)
    expect(p.band).toBe('danger')
  })

  it('reports the raw token count alongside the percent', () => {
    const p = contextPressure([ev({ seq: 1, contextTokens: 142_000 })], MODEL)
    expect(p.tokens).toBe(142_000)
    expect(Math.round(p.percent!)).toBe(71)
  })
})

describe('contextPressure — unknown / local / missing model', () => {
  it('unknown model id → band unknown, limit + percent undefined', () => {
    const p = contextPressure([ev({ seq: 1, contextTokens: 9000 })], 'llama3.2')
    expect(p.band).toBe('unknown')
    expect(p.limit).toBeUndefined()
    expect(p.percent).toBeUndefined()
    expect(p.tokens).toBe(9000) // tokens still reported
  })

  it('undefined model → band unknown', () => {
    const p = contextPressure([ev({ seq: 1, contextTokens: 9000 })])
    expect(p.band).toBe('unknown')
    expect(p.limit).toBeUndefined()
  })

  it('empty events on a known model → 0 tokens, 0% ok', () => {
    const p = contextPressure([], MODEL)
    expect(p.tokens).toBe(0)
    expect(p.percent).toBe(0)
    expect(p.band).toBe('ok')
  })
})

describe('nextAutoCompact — guarded + debounced auto-compaction', () => {
  // A "ready to fire" input set: danger + parked + interactive, nobody in the way.
  function inputs(over: Partial<AutoCompactInputs> = {}): AutoCompactInputs {
    return { band: 'danger', awaiting: true, interactive: true, sending: false, operatorTyping: false, ...over }
  }

  it('fires once on the first danger episode while parked (armed → disarmed)', () => {
    const r = nextAutoCompact({ armed: true }, inputs())
    expect(r.fire).toBe(true)
    expect(r.state.armed).toBe(false)
  })

  it('does NOT re-fire while still in danger (armed stays false)', () => {
    const first = nextAutoCompact({ armed: true }, inputs())
    const second = nextAutoCompact(first.state, inputs())
    expect(second.fire).toBe(false)
    expect(second.state.armed).toBe(false)
  })

  it('re-arms after band returns to ok, then fires again on the next danger', () => {
    const first = nextAutoCompact({ armed: true }, inputs())
    expect(first.fire).toBe(true)
    const recovered = nextAutoCompact(first.state, inputs({ band: 'ok' }))
    expect(recovered.fire).toBe(false)
    expect(recovered.state.armed).toBe(true)
    const again = nextAutoCompact(recovered.state, inputs())
    expect(again.fire).toBe(true)
    expect(again.state.armed).toBe(false)
  })

  it('never fires when not awaiting input', () => {
    expect(nextAutoCompact({ armed: true }, inputs({ awaiting: false })).fire).toBe(false)
  })

  it('never fires when the run is not interactive', () => {
    expect(nextAutoCompact({ armed: true }, inputs({ interactive: false })).fire).toBe(false)
  })

  it('never fires while a send is already in flight', () => {
    expect(nextAutoCompact({ armed: true }, inputs({ sending: true })).fire).toBe(false)
  })

  it('never fires while the operator is mid-answer', () => {
    expect(nextAutoCompact({ armed: true }, inputs({ operatorTyping: true })).fire).toBe(false)
  })

  it('does not fire on warn / ok / unknown bands', () => {
    for (const band of ['warn', 'ok', 'unknown'] as const) {
      expect(nextAutoCompact({ armed: true }, inputs({ band })).fire).toBe(false)
    }
  })

  it('holds armed unchanged on a blocked danger (so it can still fire once unblocked)', () => {
    // typing blocks the fire but must NOT disarm — once they stop, it should fire.
    const blocked = nextAutoCompact({ armed: true }, inputs({ operatorTyping: true }))
    expect(blocked.fire).toBe(false)
    expect(blocked.state.armed).toBe(true)
    const unblocked = nextAutoCompact(blocked.state, inputs())
    expect(unblocked.fire).toBe(true)
  })

  it('warn does not re-arm a disarmed state (only ok re-arms)', () => {
    const afterFire = { armed: false }
    const r = nextAutoCompact(afterFire, inputs({ band: 'warn' }))
    expect(r.state.armed).toBe(false)
    expect(r.fire).toBe(false)
  })
})
