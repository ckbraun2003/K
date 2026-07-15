import { describe, it, expect } from 'vitest'
import { groupFeedByDay } from '../src/lib/feed-query'

const at = (iso: string) => ({ id: iso, ts: Date.parse(iso) })

describe('groupFeedByDay', () => {
  it('buckets by local calendar day, newest group first, labels Today/Yesterday', () => {
    const now = new Date(); now.setHours(12, 0, 0, 0)
    const today = { id: 'a', ts: now.getTime() }
    const yesterday = { id: 'b', ts: now.getTime() - 24 * 3600_000 }
    const older = at('2026-07-01T10:00:00Z')
    const groups = groupFeedByDay([today, yesterday, older], now.getTime())
    expect(groups.map(g => g.label)).toEqual(['Today', 'Yesterday', groups[2].label])
    expect(groups[2].label).toMatch(/\w/) // locale date string for older days
    expect(groups[0].items[0].id).toBe('a')
  })
})
