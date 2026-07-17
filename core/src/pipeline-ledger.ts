/**
 * Pipeline progress ledger writer (Orchestration Program Phase 2, Lane A / Task A.1).
 *
 * An append-only, per-pipeline-run feed (design §6.1). Every stage transition, retry, loop
 * iteration, gate decision, cost event, and free-text note the engine records lands here as one
 * PipelineLedgerEntry. It is the human- and agent-readable substrate the run monitor renders
 * (Lane C) and a future autonomous orchestrator reads to manage many pipelines.
 *
 * `seq` is a monotonic per-run cursor assigned atomically inside a single db.transaction
 * (MAX(seq)+1 per pipeline_run_id — pipelineLedgerDb.insertLedgerEntry) so two writers from
 * different stages can never race the UNIQUE(pipeline_run_id, seq) constraint. The assigned seq
 * is returned so a caller can stamp it into the pipeline_update WS delta's `ledgerSeq` cursor.
 */

import { randomUUID } from 'crypto'
import type { PipelineLedgerEntry, PipelineLedgerKind } from '@k/shared'
import { pipelineLedgerDb, rowToPipelineLedgerEntry } from './db.js'

/** The append surface. `stageKey` is null for run-level entries; `detail` is any JSON-serializable
 *  payload (persisted as TEXT, absent → the column stays NULL); `cost` is measured USD (null when
 *  not a cost event). Everything but `kind` is optional and defaults to null / absent. */
export interface AppendLedgerInput {
  stageKey?: string | null
  kind: PipelineLedgerKind
  actor?: string | null
  goal?: string | null
  detail?: unknown
  cost?: number | null
}

/**
 * Append one entry to a pipeline run's ledger. The per-run `seq` is assigned atomically (the
 * insert txn reads MAX(seq)+1) so concurrent-ish appends never collide. Returns the persisted
 * PipelineLedgerEntry (with its assigned `seq`) — mirroring what listLedger would read back.
 */
export function appendLedger(pipelineRunId: string, input: AppendLedgerInput): PipelineLedgerEntry {
  const id = randomUUID()
  const ts = Date.now()
  const stageKey = input.stageKey ?? null
  const actor = input.actor ?? null
  const goal = input.goal ?? null
  const cost = input.cost ?? null
  const seq = pipelineLedgerDb.insertLedgerEntry({
    id,
    pipelineRunId,
    stageKey,
    ts,
    kind: input.kind,
    actor,
    goal,
    // Bound already-stringified (or null) — the agent_profiles JSON-column convention.
    detail: input.detail === undefined ? null : JSON.stringify(input.detail),
    cost,
  })
  const entry: PipelineLedgerEntry = {
    id, pipelineRunId, stageKey, seq, ts, kind: input.kind, actor, goal, cost,
  }
  if (input.detail !== undefined) entry.detail = input.detail
  return entry
}

/** A pipeline run's full ledger, oldest first (ordered by seq). */
export function listLedger(pipelineRunId: string): PipelineLedgerEntry[] {
  return (pipelineLedgerDb.listLedgerByRun.all(pipelineRunId) as Record<string, unknown>[]).map(rowToPipelineLedgerEntry)
}

/** The highest `seq` assigned in a run's ledger (0 if empty). Stamped into the
 *  pipeline_update WS delta's `ledgerSeq` cursor so the client's ledger query
 *  refetches only when new entries exist (live-invalidate.ts). listLedgerByRun is
 *  seq-ordered, so the last row's seq is the max — no extra prepared statement. */
export function latestLedgerSeq(pipelineRunId: string): number {
  const rows = pipelineLedgerDb.listLedgerByRun.all(pipelineRunId) as Record<string, unknown>[]
  return rows.length ? Number(rows[rows.length - 1].seq) : 0
}
