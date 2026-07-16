/**
 * Task 11 Step 1 — pure geometry/banding helpers behind RunTimeline's role
 * bands, gap-duration bars, and tool-call span grouping.
 */
import { describe, it, expect } from 'vitest'
import { gapBarWidth, EVENT_BAND, groupToolSpans } from '../src/components/RunTimeline'

describe('timeline bands', () => {
  it('gapBarWidth scales into 2..48px and handles zero/negative gaps', () => {
    expect(gapBarWidth(0, 1000)).toBe(2)
    expect(gapBarWidth(-5, 1000)).toBe(2)
    expect(gapBarWidth(1000, 1000)).toBe(48)
    expect(gapBarWidth(500, 1000)).toBeGreaterThan(2)
  })
  it('EVENT_BAND maps every event type to a border token class', () => {
    for (const t of ['system', 'assistant', 'user', 'usage', 'error', 'status', 'checkpoint']) {
      expect(EVENT_BAND[t], t).toMatch(/^border-l-/)
    }
  })
  it('groupToolSpans finds consecutive tool_use/tool_result runs of length ≥2', () => {
    const ev = (i: number, type: string, tool?: string) => ({ id: String(i), seq: i, ts: i * 1000, type, tool } as never)
    const events = [ev(0, 'status'), ev(1, 'assistant', 'Read'), ev(2, 'user'), ev(3, 'assistant', 'Edit'), ev(4, 'user'), ev(5, 'assistant')]
    expect(groupToolSpans(events)).toEqual([{ start: 1, end: 4, count: 2 }])
  })
})
