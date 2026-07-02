import type { Run } from '@k/shared'
import { api } from './api'

/**
 * The ONE shared default-runs-list query (wave C1). Its consumers (ActivityStrip,
 * RunList, CommandBar, KHome, and the Sidebar badge) previously shared the bare
 * ['runs'] key with separately-written queryFns — the fns could silently drift
 * under one cache entry. Scoping the key to its limit and exporting a single
 * queryFn makes the pair impossible to desynchronise.
 *
 * Rules:
 *  - a FILTERED or non-default-limit list must use its own scoped key, never this one
 *  - invalidations keep using the ['runs'] PREFIX (react-query prefix matching), so
 *    they hit this key and any future scoped siblings alike
 *  - live WS patches (RunList's setQueryData) must write to EXACTLY this key.
 */
export const RUNS_LIST_LIMIT = 100

export const RUNS_LIST_KEY = ['runs', { limit: RUNS_LIST_LIMIT }] as const

export const runsListQueryFn = (): Promise<Run[]> => api.runs.list({ limit: RUNS_LIST_LIMIT })
