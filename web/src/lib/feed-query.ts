/**
 * P3 E-09 — the ONE shared feed query fn/module for the TWO historical surfaces:
 * K-home recent (keys ['feed'], default 100) and the timeline view (keys
 * ['feed', 500]). ActivityStrip is NOT a consumer — it stays on the runs query.
 * The queryFn treats fetch errors as an empty feed (the inbox-query.ts pattern):
 * a dead core must not render a phantom timeline.
 */
import type { FeedPayload, FeedKind } from '@k/shared'
import { api } from './api'

export const FEED_KEY = ['feed'] as const

const ZERO_COUNTS: Record<FeedKind, number> = {
  dispatch: 0, park: 0, plan_gate: 0, review_ready: 0, pr: 0,
  merge: 0, verify_pass: 0, verify_fail: 0, failure: 0, done: 0,
}

export const EMPTY_FEED: FeedPayload = { items: [], counts: { ...ZERO_COUNTS }, total: 0 }

export const feedQueryFn = async (): Promise<FeedPayload> => {
  try { return await api.feed.list() } catch { return EMPTY_FEED }
}

/**
 * The timeline view wants MORE history than K-home's default 100 (it has no
 * ActivityStrip-style correctness constraint), so it keys ['feed', 500] with this
 * larger-limit fn. Same error tolerance as feedQueryFn (dead core -> EMPTY_FEED).
 */
export function feedQueryFnLimited(limit: number): () => Promise<FeedPayload> {
  return async () => {
    try { return await api.feed.list({ limit }) } catch { return EMPTY_FEED }
  }
}

/** Iconographic glyph per milestone kind (git-log-like feed). Written as \u escapes
 *  to keep this source ASCII-safe (the glyphs render fine — JS decodes them). */
export const FEED_ICON: Record<FeedKind, string> = {
  dispatch: '\u25B8', park: '\u23F8', plan_gate: '\u2387', review_ready: '\u2691', pr: '\u21E1',
  merge: '\u2325', verify_pass: '\u2713', verify_fail: '\u2717', failure: '\u2717', done: '\u25CF',
}

export interface DayGroup<T extends { ts: number }> { key: string; label: string; items: T[] }

/** Local-calendar-day grouping for feed rows (FE-4 #3 Recent Activity). Input
 *  is assumed ts-DESC (the feed contract); groups preserve that order. */
export function groupFeedByDay<T extends { ts: number }>(items: T[], now = Date.now()): DayGroup<T>[] {
  const dayKey = (ts: number) => new Date(ts).toDateString()
  const todayKey = dayKey(now)
  const yesterdayKey = dayKey(now - 24 * 3600_000)
  const groups: DayGroup<T>[] = []
  for (const item of items) {
    const key = dayKey(item.ts)
    const last = groups[groups.length - 1]
    if (last?.key === key) { last.items.push(item); continue }
    groups.push({
      key,
      label: key === todayKey ? 'Today' : key === yesterdayKey ? 'Yesterday' : new Date(item.ts).toLocaleDateString(),
      items: [item],
    })
  }
  return groups
}
