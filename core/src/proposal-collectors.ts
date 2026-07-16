/**
 * E-14 Chief proposals — DETERMINISTIC, ZERO-TOKEN collectors that turn known signals
 * (failing verification, failing CI, open GitHub issues, stale bible) into proposal
 * work_items (org-scoped, status 'blocked' = awaiting approval). Deduped by source_key
 * (partial-unique index) and open-capped. No LLM here — the optional Chief prioritization
 * pass (chief-wake) is the only paid step. Gated by autonomySettings.enabled && proposals.
 *
 * ── Partial-unique-index decision (idx_work_items_source_key, WHERE source_key IS NOT
 * NULL — one row EVER per key across ALL statuses) ───────────────────────────────────
 * Dismissal stickiness is now WINDOWED (P5-FU-3): dismissProposal (db.ts) flips status
 * to 'cancelled' (never nulls source_key) and stamps updated_at = the dismissal time.
 * A dismissed key whose signal RECURS within RENAG_AFTER_MS stays sticky ("don't nag
 * again"); once the window has passed, a recurring signal flips the SAME row back to
 * 'blocked' (renagDismissedProposal — the partial-unique index still allows only one
 * row per key). 'done' rows (approved + resolved) remain PERMANENTLY sticky — the
 * source_key is `<source>:<projectId>` with NO run/date discriminator, so a GENUINE
 * later recurrence of a RESOLVED signal is still not re-surfaced (honest limitation;
 * a tracked follow-up may scope that dedupe to live statuses). insertProposal is never
 * reached for an existing key, so the partial-unique index can only ever throw on a
 * genuine concurrent-insert race between the dedupe check and the insert —
 * persistProposals below swallows that specific race (unique-constraint) rather than
 * crashing the collector tick.
 */
import { randomUUID } from 'crypto'
import { schedule as cronSchedule } from 'node-cron'
import type { ProposalSource } from '@k/shared'
import { proposalsDb, db } from './db.js'
import { listProjects } from './projects.js'
import { autonomySettings } from './config-store.js'
import { eventBus } from './events.js'
import { runVerification, classifyCi, bibleFreshnessDays, bibleFreshFromDays, hasBibleDir, hasWorkflowFile } from './verify.js'
import { getGithubStatus } from './github.js'

export interface ProposalCandidate {
  source: ProposalSource
  sourceKey: string
  title: string
  body: string | null
  projectId: string | null
}

export const OPEN_PROPOSAL_CAP = 20

/** P5-FU-3 re-nag window: a dismissed proposal whose signal recurs at least this long
 *  after its dismissal re-surfaces (flips back to 'blocked'). */
export const RENAG_AFTER_MS = 7 * 86_400_000

/** Insert candidates as 'blocked' org proposals, skipping any whose source_key already
 *  exists (except stale dismissals — see RENAG_AFTER_MS), stopping at OPEN_PROPOSAL_CAP
 *  live proposals. Broadcasts proposal_update once if anything landed. Returns the
 *  number inserted/re-surfaced. */
export function persistProposals(cands: ProposalCandidate[], now = Date.now()): number {
  let inserted = 0
  for (const c of cands) {
    if ((proposalsDb.countOpenProposals.get() as { n: number }).n >= OPEN_PROPOSAL_CAP) break
    const existing = proposalsDb.getProposalBySourceKey.get(c.sourceKey) as
      | { status?: string; updated_at?: number } | undefined
    if (existing) {
      // P5-FU-3: a DISMISSED key whose signal recurs after the window re-surfaces
      // (same row flips back to 'blocked' — the partial-unique index allows only one
      // row per key). Everything else stays sticky: open/blocked (already live),
      // done (resolved; documented follow-up), and fresh dismissals.
      if (existing.status === 'cancelled' && (existing.updated_at ?? now) <= now - RENAG_AFTER_MS) {
        const r = proposalsDb.renagDismissedProposal.run({ sourceKey: c.sourceKey, now, cutoff: now - RENAG_AFTER_MS })
        if (r.changes > 0) inserted++
      }
      continue
    }
    try {
      proposalsDb.insertProposal.run({
        id: randomUUID(), title: c.title.slice(0, 200), body: c.body,
        projectId: c.projectId, source: c.source, sourceKey: c.sourceKey, createdAt: now,
      })
      inserted++
    } catch (e) {
      // Unique-index race (a concurrent insert of the same source_key) — skip, don't crash.
      if (!/unique/i.test(String(e))) throw e
    }
  }
  if (inserted > 0) eventBus.broadcast({ type: 'proposal_update' })
  return inserted
}

/** Verification findings (EXCLUDING ci/bible — those are their own collectors, so no double
 *  proposal): run the deterministic project verifier; a project with any 'critical' non-ci/bible
 *  finding → one proposal keyed by project. `listProjects()` yields the camelCase `Project` the
 *  verifier requires. */
export function collectVerifyFindings(): ProposalCandidate[] {
  const out: ProposalCandidate[] = []
  for (const p of listProjects()) {
    if (p.pathMissing) continue
    const report = runVerification(p)
    const fails = report.findings.filter(f => f.severity === 'critical' && f.area !== 'ci' && f.area !== 'bible')
    if (fails.length > 0) {
      out.push({ source: 'verify_finding', sourceKey: `verify_finding:${p.id}`, projectId: p.id,
        title: `Fix ${fails.length} verification finding(s) in ${p.name}`,
        body: fails.map(f => `- [${f.area}] ${f.message}`).join('\n') })
    }
  }
  return out
}

/** CI failing: classify the project's CI via the SAME pipeline runVerification uses
 *  (getGithubStatus reads the cache + parses); propose on 'failing'. */
export function collectCiFailed(): ProposalCandidate[] {
  const out: ProposalCandidate[] = []
  for (const p of listProjects()) {
    if (p.pathMissing) continue
    if (classifyCi(getGithubStatus(p.id), hasWorkflowFile(p.localPath)) === 'failing') {
      out.push({ source: 'ci_failed', sourceKey: `ci_failed:${p.id}`, projectId: p.id,
        title: `CI is failing in ${p.name}`, body: null })
    }
  }
  return out
}

/** Open GitHub issues mirrored into work_items → propose staffing them. Keyed by issue. */
export function collectOpenIssues(): ProposalCandidate[] {
  const rows = db.prepare(
    `SELECT title, project_id, issue_number FROM work_items
     WHERE scope='project' AND issue_state='open' AND issue_number IS NOT NULL`).all() as Array<Record<string, unknown>>
  return rows.map(r => ({
    source: 'open_issue' as const,
    sourceKey: `open_issue:${String(r.project_id)}:${String(r.issue_number)}`,
    projectId: r.project_id != null ? String(r.project_id) : null,
    title: `Address issue #${String(r.issue_number)}: ${String(r.title)}`, body: null,
  }))
}

/** Stale bible: a project's authored bible older than the freshness threshold. Uses the
 *  project's OWN `bibleDir` (there is NO exported BIBLE_DIR constant). */
export function collectStaleBible(): ProposalCandidate[] {
  const out: ProposalCandidate[] = []
  for (const p of listProjects()) {
    if (p.pathMissing) continue
    const hasBible = hasBibleDir(p.localPath, p.bibleDir)
    if (!hasBible) continue
    const freshDays = bibleFreshnessDays(p.localPath, p.bibleDir)
    if (!bibleFreshFromDays(freshDays, hasBible)) {
      out.push({ source: 'stale_bible', sourceKey: `stale_bible:${p.id}`, projectId: p.id,
        title: `Bible is stale in ${p.name}`, body: freshDays != null ? `Last authored ${freshDays}d ago.` : null })
    }
  }
  return out
}

/** Run all four collectors and persist. Gated: no-op unless enabled && proposals. */
export function runCollectors(now = Date.now()): number {
  const s = autonomySettings()
  if (!s.enabled || !s.proposals) return 0
  const cands = [
    ...collectVerifyFindings(), ...collectCiFailed(), ...collectOpenIssues(), ...collectStaleBible(),
  ]
  return persistProposals(cands, now)
}

export function startProposalCollectors(opts?: { cron?: string }): () => void {
  if (process.env.PROPOSAL_COLLECTORS === '0') return () => { /* disabled */ }
  const task = cronSchedule(opts?.cron ?? '*/15 * * * *', () => { try { runCollectors() } catch (e) { console.warn('[collectors]', e) } })
  return () => task.stop()
}
