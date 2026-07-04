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

/**
 * Run classification shared by every active surface (ActivityStrip, Sidebar
 * badge, RunList "active" filter) so they can't drift (F-055).
 *
 * - `isActiveRun`: the agent is doing work right now (running / queued).
 * - `isParkedRun`: the run is parked at `awaiting_input` — a LIVE CLI process
 *   holding a turn open, waiting on the operator. Parked runs are non-terminal
 *   and hold real resources, so they must read as "needs input / attention",
 *   never as "nothing happening" / idle.
 */
export const isActiveRun = (r: Run): boolean => r.status === 'running' || r.status === 'queued'
export const isParkedRun = (r: Run): boolean => r.status === 'awaiting_input'
