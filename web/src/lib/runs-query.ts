import type { Run } from '@k/shared'
import { api } from './api'

/**
 * The ONE shared default-runs-list query (wave C1). Its consumers (ActivityStrip,
 * RunList, KHome, and the Sidebar badge) previously shared the bare
 * ['runs'] key with separately-written queryFns — the fns could silently drift
 * under one cache entry. Scoping the key to its limit and exporting a single
 * queryFn makes the pair impossible to desynchronise.
 *
 * Rules:
 *  - a FILTERED or non-default-limit list must use its own scoped key, never this one
 *    (A.3/D-127: RunList's kind-scoped list does exactly that — see runListKey in
 *    RunList.tsx)
 *  - invalidations keep using the ['runs'] PREFIX (react-query prefix matching), so
 *    they hit this key and any scoped siblings alike
 *  - live WS patches (RunList's setQueryData) must write to EXACTLY this key (RunList
 *    additionally patches its own kind-scoped sibling with the same exactness).
 */
export const RUNS_LIST_LIMIT = 100

export const RUNS_LIST_KEY = ['runs', { limit: RUNS_LIST_LIMIT }] as const

export const runsListQueryFn = (): Promise<Run[]> => api.runs.list({ limit: RUNS_LIST_LIMIT })

/**
 * Run classification shared by every active surface (ActivityStrip, Sidebar
 * badge, RunList "active" filter) so they can't drift (F-055).
 *
 * - `isActiveRun`: the agent is doing work right now (running / queued).
 * - `isParkedRun`: the run is parked on a HUMAN — `awaiting_input` (a LIVE CLI
 *   process holding a turn open on stdin) or `awaiting_plan` (a process-dead plan
 *   awaiting operator review, P2 E-02). Parked runs are non-terminal and need
 *   attention, so they must read as "needs input", never as idle.
 */
export const isActiveRun = (r: Run): boolean => r.status === 'running' || r.status === 'queued'
// Parked = waiting on a HUMAN: awaiting_input (live process on stdin) or
// awaiting_plan (process-dead plan park, P2 E-02). One predicate feeds the
// Sidebar badge, the ActivityStrip attention strip, and RunList's 'active' filter.
export const isParkedRun = (r: Run): boolean => r.status === 'awaiting_input' || r.status === 'awaiting_plan'
