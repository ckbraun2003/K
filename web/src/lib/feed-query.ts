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
