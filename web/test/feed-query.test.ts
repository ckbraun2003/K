/** P3 W0b — the ONE shared feed query: empty sentinel + fetch-error tolerance. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FEED_KEY, EMPTY_FEED, feedQueryFn } from '../src/lib/feed-query'

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { feed: { list: mockList } } }))

beforeEach(() => mockList.mockReset())

describe('feed-query', () => {
  it('FEED_KEY is the stable [feed] key and EMPTY_FEED has all-zero counts', () => {
    expect(FEED_KEY).toEqual(['feed'])
    expect(EMPTY_FEED.total).toBe(0)
    expect(EMPTY_FEED.items).toEqual([])
    expect(EMPTY_FEED.counts.dispatch).toBe(0)
  })
  it('returns the payload on success', async () => {
    mockList.mockResolvedValue({ items: [{ id: 'x', kind: 'dispatch', ts: 1, runId: null, runStatus: null, projectId: null, projectName: null, title: 't', detail: null }], counts: { ...EMPTY_FEED.counts, dispatch: 1 }, total: 1 })
    expect((await feedQueryFn()).total).toBe(1)
  })
  // INT.2 FE IN-1: costUsd is an optional pass-through on FeedItem (round-trips whether
  // present or absent — the field is never fabricated for non-run rows).
  it('round-trips FeedItem.costUsd when present, and omits it cleanly when absent', async () => {
    mockList.mockResolvedValue({
      items: [
        { id: 'run1', kind: 'done', ts: 1, runId: 'r1', runStatus: 'done', projectId: null, projectName: null, title: 't', detail: null, costUsd: 1.23 },
        { id: 'pr1', kind: 'pr', ts: 2, runId: null, runStatus: null, projectId: null, projectName: null, title: 'pr', detail: '#1' },
      ],
      counts: { ...EMPTY_FEED.counts, done: 1, pr: 1 }, total: 2,
    })
    const payload = await feedQueryFn()
    expect(payload.items[0].costUsd).toBe(1.23)
    expect(payload.items[1].costUsd).toBeUndefined()
  })
  it('a dead core degrades to EMPTY_FEED (no phantom feed)', async () => {
    // ...Once (not the persistent mockRejectedValue): under vitest 1.6.1 a persistent
    // rejected module-mock consumed by a direct await leaks an unhandled rejection
    // (tinyspy 2.2.1 result-tracking); ...Once is the repo-wide reject idiom and
    // feedQueryFn is called exactly once here.
    mockList.mockRejectedValueOnce(new Error('offline'))
    expect(await feedQueryFn()).toEqual(EMPTY_FEED)
  })
})
