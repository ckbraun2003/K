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
  it('a dead core degrades to EMPTY_FEED (no phantom feed)', async () => {
    // ...Once (not the persistent mockRejectedValue): under vitest 1.6.1 a persistent
    // rejected module-mock consumed by a direct await leaks an unhandled rejection
    // (tinyspy 2.2.1 result-tracking); ...Once is the repo-wide reject idiom and
    // feedQueryFn is called exactly once here.
    mockList.mockRejectedValueOnce(new Error('offline'))
    expect(await feedQueryFn()).toEqual(EMPTY_FEED)
  })
})
