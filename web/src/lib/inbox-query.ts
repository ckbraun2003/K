/**
 * P2 E-05 — the ONE shared inbox query (rail badge + InboxPage + invalidators all
 * key off this, so the badge adds zero extra fetches — the runs-query.ts pattern).
 * The queryFn treats fetch errors as an empty inbox (VerifyChip absence idiom):
 * a dead core must not render a phantom badge.
 */
import type { InboxPayload } from '@k/shared'
import { api } from './api'

export const INBOX_KEY = ['inbox'] as const

export const EMPTY_INBOX: InboxPayload = {
  items: [],
  counts: { plan_pending: 0, input_needed: 0, lesson_pending: 0, mcp_trust: 0, review_ready: 0, proposal: 0 },
  total: 0,
}

export const inboxQueryFn = async (): Promise<InboxPayload> => {
  try { return await api.inbox.list() } catch { return EMPTY_INBOX }
}
