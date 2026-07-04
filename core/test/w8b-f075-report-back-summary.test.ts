/**
 * W8b F-075 — lead report-back is a CONCISE summary, not a truncated PREFIX dump.
 *
 * Before: summarizeLeadOutcome / summarizeChiefLeadContinuation concatenated the FIRST ≤50
 * assistant events and truncated to 2000 chars — a raw transcript PREFIX that loses the
 * conclusion ("I'll start by loading the workflow status tools…" instead of "opened PR #9").
 * Now each: (1) PREFERS the lead's explicit mgmt `report` (report_list) when one was filed,
 * mirroring summarizeDelegatedOutcome; (2) otherwise uses the TAIL — the run's final
 * assistant message (its conclusion), not the opening turns.
 *
 * Pure summarizers reading the shared DB — no dispatch, no supervisor mock needed.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, mgmtDb } from '../src/db.js'
import { summarizeLeadOutcome } from '../src/chief-dispatch.js'
import { summarizeChiefLeadContinuation } from '../src/k-thread.js'

const PREFIX_LINE = "I'll start by loading the workflow status tools…"
const TAIL_LINE = 'Done — opened PR #9; CI green.'

function insertRun(id: string, status = 'done'): void {
  db.prepare(
    `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'lead', '.', ?, ?)`,
  ).run(id, status, Date.now())
}
function insertAssistant(runId: string, seq: number, text: string): void {
  db.prepare(
    `INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, ?, 'assistant', ?, ?)`,
  ).run(uuid(), runId, seq, Date.now(), text)
}
function fileReport(runId: string, body: string): void {
  mgmtDb.insertReport.run({ id: uuid(), runId, assignmentId: null, body, createdAt: Date.now() })
}
/** A lead run whose transcript opens with boilerplate and CONCLUDES with the real outcome. */
function seedPrefixThenTailRun(): string {
  const id = `f075-lead-${uuid().slice(0, 8)}`
  insertRun(id)
  insertAssistant(id, 1, PREFIX_LINE)
  insertAssistant(id, 2, 'Looking at the failing test…')
  insertAssistant(id, 3, TAIL_LINE)
  return id
}

afterEach(() => {
  db.prepare(`DELETE FROM mgmt_reports WHERE run_id LIKE 'f075-%'`).run()
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'f075-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'f075-%'`).run()
})

describe('summarizeLeadOutcome (lead → Chief report-back)', () => {
  it('uses the TAIL (final assistant message), not the opening-turns prefix', () => {
    const runId = seedPrefixThenTailRun()
    const s = summarizeLeadOutcome(runId, 'done', 'lead-backend')
    expect(s).toContain('opened PR #9')
    expect(s).not.toContain(PREFIX_LINE)
    expect(s).toContain('Lead lead-backend (delegation completed):')
  })

  it('PREFERS the lead\'s mgmt report over the transcript when one was filed', () => {
    const runId = seedPrefixThenTailRun()
    fileReport(runId, 'Shipped the auth refactor; PR #12 opened, CI green.')
    const s = summarizeLeadOutcome(runId, 'done', 'lead-frontend')
    expect(s).toContain('reported:')
    expect(s).toContain('Shipped the auth refactor')
    // The report wins — the raw transcript tail is not used.
    expect(s).not.toContain(TAIL_LINE)
  })

  it('falls back to a bare status line when there is neither report nor assistant text', () => {
    const runId = `f075-lead-${uuid().slice(0, 8)}`
    insertRun(runId, 'error')
    const s = summarizeLeadOutcome(runId, 'error', 'lead-systems')
    expect(s).toContain('no summary was produced')
    expect(s).toContain('error')
  })

  it('caps an oversize final message to ~2000 chars + ellipsis', () => {
    const runId = `f075-lead-${uuid().slice(0, 8)}`
    insertRun(runId)
    insertAssistant(runId, 1, 'z'.repeat(2_500))
    const s = summarizeLeadOutcome(runId, 'done', 'lead-backend')
    expect(s.endsWith('…')).toBe(true)
    const prefix = 'Lead lead-backend (delegation completed): '
    expect(s.length).toBe(prefix.length + 2_000 + 1)
  })
})

describe('summarizeChiefLeadContinuation (lead → K continuation)', () => {
  it('uses the TAIL (final assistant message), not the opening-turns prefix', () => {
    const runId = seedPrefixThenTailRun()
    const s = summarizeChiefLeadContinuation(runId, 'lead-backend', 'done')
    expect(s).toContain('opened PR #9')
    expect(s).not.toContain(PREFIX_LINE)
    expect(s).toContain('Chief (via lead-backend) completed:')
  })

  it('PREFERS the lead\'s mgmt report over the transcript when one was filed', () => {
    const runId = seedPrefixThenTailRun()
    fileReport(runId, 'Landed the migration; PR #21.')
    const s = summarizeChiefLeadContinuation(runId, 'lead-backend', 'done')
    expect(s).toContain('reported:')
    expect(s).toContain('Landed the migration')
    expect(s).not.toContain(TAIL_LINE)
  })
})
