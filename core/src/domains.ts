/**
 * domains — the domain registry + attribution helpers (Continuous Agents C.1, D-125).
 *
 * Owns the canonical camelCase Domain shape over the raw snake_case rows the W0
 * domainsDb statements emit (the rowToNamedWorkflow convention — see the db.ts
 * header at the domains bundle). Three concerns live here:
 *
 *   1. CRUD over domainsDb (slug ids; name UNIQUE; created_at/id immutable).
 *   2. ATTRIBUTION: which domain does a profile / pipeline def / run belong to.
 *      Profiles resolve via agent_profiles.domain_id with a MANAGER FALLBACK
 *      (domains.manager_profile_id — the chief precedent: managers carry no
 *      domain_id of their own). Agent runs resolve DERIVED via their owning
 *      profile — runs/agent_runs have NO domain column at v16 (ledger-flagged
 *      deviation #1); pipeline runs are stamped PHYSICALLY at instantiation
 *      (pipeline-defs.ts) via domainIdForPipelineLaunch (def → owner precedence).
 *   3. BOOTSTRAP STAMPING (the W0-flagged fresh-install gap): migrate() seeds the
 *      engineering domain + stamps members, but on a FRESH install the profile/def
 *      rows are seeded LATER at bootstrap — so index.ts calls
 *      stampSeededDomainMemberships() after seedProfiles()/seedPipelineSpecs().
 *      Statements MIRROR the migration block byte-for-byte in semantics:
 *      INSERT OR IGNORE + `WHERE domain_id IS NULL AND id IN (seeded ids)` — the
 *      documented default-membership re-stamp posture; operator rows never match.
 */
import type { Domain } from '@k/shared'
import { db, domainsDb, agentRunsDb } from './db.js'

export class DomainConflictError extends Error {}

/** The exact seeded ids the v16 migration stamps (db.ts migrateSlow, v16 seed block).
 *  Kept in lockstep with profiles.ts SEED_PROFILES / pipeline-seeds.ts PIPELINE_SEEDS —
 *  domains.test.ts locks the coverage. */
export const SEEDED_DOMAIN_LEAD_IDS = [
  'lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network',
] as const
export const SEEDED_DOMAIN_DEF_IDS = [
  'code-wave', 'investigate', 'refactor', 'implementation-cycle',
  'deep-research', 'bug-triage', 'security-audit', 'quick-task',
] as const

// ── row mapper ────────────────────────────────────────────────────────────────

export function rowToDomain(r: Record<string, unknown>): Domain {
  return {
    id: String(r.id),
    name: String(r.name),
    description: r.description == null ? null : String(r.description),
    managerProfileId: r.manager_profile_id == null ? null : String(r.manager_profile_id),
    createdAt: Number(r.created_at),
  }
}

// ── local statements (the pipeline-scheduler private-statement precedent) ─────

const profileDomainIdRow = db.prepare(`SELECT domain_id FROM agent_profiles WHERE id = ?`)
const domainByManagerRow = db.prepare(
  `SELECT * FROM domains WHERE manager_profile_id = ? ORDER BY created_at ASC, id ASC LIMIT 1`,
)
const defDomainIdRow = db.prepare(`SELECT domain_id FROM workflow_definitions WHERE id = ?`)

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function listAllDomains(): Domain[] {
  return (domainsDb.list.all() as Record<string, unknown>[]).map(rowToDomain)
}

export function getDomainById(id: string): Domain | null {
  const row = domainsDb.get.get(id) as Record<string, unknown> | undefined
  return row ? rowToDomain(row) : null
}

/** Lowercase slug of a display name (id material): non-alphanumerics collapse to
 *  single hyphens, edges trimmed. '' = un-sluggable (caller rejects). */
export function slugifyDomainName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function createDomain(input: {
  name: string; description?: string | null; managerProfileId?: string | null
}): Domain {
  const name = input.name.trim()
  const id = slugifyDomainName(name)
  if (!id) throw new DomainConflictError('domain name must contain letters or digits')
  if (domainsDb.get.get(id)) throw new DomainConflictError(`domain "${id}" already exists`)
  // Pre-check the UNIQUE(name) too for a clean message (instead of a raw SQLITE_CONSTRAINT).
  if (listAllDomains().some(d => d.name.toLowerCase() === name.toLowerCase())) {
    throw new DomainConflictError(`domain name "${name}" already in use`)
  }
  domainsDb.create.run({
    id, name,
    description: input.description ?? null,
    managerProfileId: input.managerProfileId ?? null,
    createdAt: Date.now(),
  })
  return getDomainById(id) as Domain
}

/** Read-merge-write over the full mutable set (the updateSkillContent convention the
 *  W0 domainsDb.update statement documents). Returns null for unknown ids. A rename
 *  onto another domain's name (case-insensitive — stricter than SQLite's BINARY
 *  UNIQUE, matching createDomain's posture) throws DomainConflictError so the
 *  constraint never surfaces as a raw SqliteError (quality-review M1). */
export function updateDomainById(id: string, patch: {
  name?: string; description?: string | null; managerProfileId?: string | null
}): Domain | null {
  const current = getDomainById(id)
  if (!current) return null
  let nextName = current.name
  if (patch.name !== undefined) {
    nextName = patch.name.trim()
    if (!nextName) throw new DomainConflictError('domain name must contain letters or digits')
    if (listAllDomains().some(d => d.id !== id && d.name.toLowerCase() === nextName.toLowerCase())) {
      throw new DomainConflictError(`domain name "${nextName}" already in use`)
    }
  }
  domainsDb.update.run({
    id,
    name: nextName,
    description: patch.description !== undefined ? patch.description : current.description,
    managerProfileId: patch.managerProfileId !== undefined ? patch.managerProfileId : current.managerProfileId,
  })
  return getDomainById(id)
}

// ── attribution ───────────────────────────────────────────────────────────────

/** A profile's domain: its agent_profiles.domain_id, else (manager fallback) the
 *  domain it MANAGES — the chief precedent (managers carry no domain_id of their
 *  own; linkage is domains.manager_profile_id). Unknown/unattributed → null. */
export function domainForProfile(profileId: string): Domain | null {
  const row = profileDomainIdRow.get(profileId) as { domain_id?: string | null } | undefined
  if (!row) return null
  if (row.domain_id != null) return getDomainById(String(row.domain_id))
  return domainManagedBy(profileId)
}

/** The domain a profile MANAGES (strict manager linkage only — no domain_id read).
 *  C.5's manager-scope checks use this so a member profile can never pass as a manager. */
export function domainManagedBy(profileId: string): Domain | null {
  const row = domainByManagerRow.get(profileId) as Record<string, unknown> | undefined
  return row ? rowToDomain(row) : null
}

export function domainForPipelineDef(defId: string): Domain | null {
  const row = defDomainIdRow.get(defId) as { domain_id?: string | null } | undefined
  return row?.domain_id != null ? getDomainById(String(row.domain_id)) : null
}

/** Launch-time attribution for a pipeline run: the definition's domain wins, else the
 *  owning profile's (derived, incl. manager fallback), else null. pipeline-defs.ts
 *  stamps the result into pipeline_runs.domain_id at instantiation. */
export function domainIdForPipelineLaunch(
  definitionId: string | null, ownerProfileId: string | null,
): string | null {
  if (definitionId) {
    const row = defDomainIdRow.get(definitionId) as { domain_id?: string | null } | undefined
    if (row?.domain_id != null) return String(row.domain_id)
  }
  if (ownerProfileId) return domainForProfile(ownerProfileId)?.id ?? null
  return null
}

/** DERIVED run attribution (deviation #1): the run's owning agent_runs profile →
 *  its domain. Launch-time ≈ resolution-time because profile→domain membership is
 *  stable; the supervisor resolves events through this. */
export function domainForRun(runId: string): Domain | null {
  const owner = agentRunsDb.getAgentRunProfileByRunId.get(runId) as
    | { profile_id?: string } | undefined
  return owner?.profile_id ? domainForProfile(owner.profile_id) : null
}

// ── bootstrap stamping (the W0-flagged fresh-install gap) ─────────────────────

export function stampSeededDomainMemberships(): void {
  db.prepare(`
    INSERT OR IGNORE INTO domains (id, name, description, manager_profile_id, created_at)
    VALUES ('engineering', 'Engineering', NULL, 'chief', ?)
  `).run(Date.now())
  db.exec(`
    UPDATE agent_profiles SET domain_id = 'engineering'
    WHERE domain_id IS NULL AND id IN
      ('${SEEDED_DOMAIN_LEAD_IDS.join("','")}')
  `)
  db.exec(`
    UPDATE workflow_definitions SET domain_id = 'engineering'
    WHERE domain_id IS NULL AND id IN
      ('${SEEDED_DOMAIN_DEF_IDS.join("','")}')
  `)
}
