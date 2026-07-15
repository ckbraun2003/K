/**
 * Artifact filesystem scan (D-117) — syncs loose top-level *.html files into the
 * artifacts registry as origin='scanned' rows, so a project's Artifacts tab shows
 * everything its agents produced, not just the compiled bible.
 *
 * Rules (spec BE-1, frozen):
 *  - top-level `<localPath>/artifacts/*.html` only (no recursion), isPathWithin-guarded;
 *  - slug `project-<id>-<basename-slug>` conforming to SLUG_RE (truncated to 80);
 *  - a file whose resolved path already backs an existing row's html_path — or whose
 *    basename IS an existing slug served from ARTIFACTS_DIR/<slug>.html — is SKIPPED
 *    (prevents re-registering the compiled bible / ui-demo as scanned duplicates);
 *  - idempotent: an unchanged already-registered file counts as skipped on re-scan;
 *  - scanned rows whose file vanished are DELETED; compiled rows are NEVER touched;
 *  - harness scope: the same sweep over ARTIFACTS_DIR loose HTML, projectId NULL.
 * Serving posture unchanged: getArtifact stays html_path-preferring; the sandboxed
 * DocViewer iframe (no allow-same-origin) renders the file.
 */
import fs from 'fs'
import path from 'path'
import { artifactsDb, runsDb } from './db.js'
import { ARTIFACTS_DIR } from './artifacts.js'
import { isPathWithin } from './paths.js'
import { getProject } from './projects.js'
import { eventBus } from './events.js'
import { isTerminalRunStatus } from './run-lifecycle.js'

export interface ScanResult { added: number; removed: number; skipped: number }

/** Resolve a directory entry under `root`, or null when the resolution escapes it
 *  (defense-in-depth; readdir can't emit `..`, but symlinked entries can point out).
 *  Exported for the escape unit test. */
export function resolveScannedFile(root: string, name: string): string | null {
  const rootAbs = path.resolve(root)
  let abs = path.resolve(rootAbs, name)
  try { abs = fs.realpathSync(abs) } catch { /* keep the lexical resolution */ }
  return isPathWithin(rootAbs, abs) ? abs : null
}

/** basename (no .html) → SLUG_RE-safe fragment. */
function slugifyBase(base: string): string {
  let s = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (s === '' || !/^[a-z0-9]/.test(s)) s = `f-${s}`
  return s
}

function titleFrom(file: string, fallback: string): string {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 65536)
    const m = /<title[^>]*>([^<]*)<\/title>/i.exec(head)
    const t = m?.[1]?.trim()
    return t ? t.slice(0, 200) : fallback
  } catch { return fallback }
}

/** All resolved paths + slugs that already back a row (explicit html_path sources
 *  plus every slug's implicit ARTIFACTS_DIR/<slug>.html fallback). */
function backingIndex(): { paths: Set<string>; slugs: Set<string> } {
  const paths = new Set<string>()
  const slugs = new Set<string>()
  for (const r of artifactsDb.listArtifacts.all() as Array<{ slug: string }>) slugs.add(String(r.slug))
  for (const r of artifactsDb.listArtifactHtmlPaths.all() as Array<{ slug: string; html_path: string }>) {
    paths.add(path.resolve(String(r.html_path)))
  }
  return { paths, slugs }
}

function sweep(dir: string, projectId: string | null, slugFor: (base: string) => string): ScanResult {
  const out: ScanResult = { added: 0, removed: 0, skipped: 0 }
  const seenSlugs = new Set<string>()
  if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    const { paths: backedPaths, slugs: existingSlugs } = backingIndex()
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.html')) continue
      const abs = resolveScannedFile(dir, ent.name)
      if (abs === null) { out.skipped++; continue } // escape attempt — never register
      const base = ent.name.replace(/\.html$/i, '')
      const slug = slugFor(base)
      if (seenSlugs.has(slug)) { out.skipped++; continue } // two files → one slug: first wins
      const ownRow = artifactsDb.getArtifact.get(slug) as { origin?: string } | undefined
      const rescanOfOwnRow = ownRow?.origin === 'scanned'
      // Skip anything already backed by a NON-scanned row: explicit html_path match,
      // an existing compiled row under this slug, or a basename that names an existing
      // slug (the ARTIFACTS_DIR/<slug>.html fallback-serving convention).
      if (!rescanOfOwnRow && (backedPaths.has(abs) || (ownRow !== undefined) || existingSlugs.has(base))) {
        out.skipped++
        continue
      }
      seenSlugs.add(slug)
      artifactsDb.upsertScannedArtifact.run({
        slug,
        title: titleFrom(abs, base),
        tags: JSON.stringify(['scanned']),
        updatedAt: Math.round(fs.statSync(abs).mtimeMs),
        md: `_Scanned artifact — served from_ \`${ent.name}\``,
        htmlPath: abs,
        projectId,
      })
      if (rescanOfOwnRow) out.skipped++
      else out.added++
    }
  }
  // Vanish-cleanup for THIS scope: scanned rows whose file is gone (or whose dir is).
  const rows = artifactsDb.listScannedArtifacts.all({ projectId }) as Array<{ slug: string; html_path: string | null }>
  for (const r of rows) {
    const p = r.html_path ? path.resolve(r.html_path) : null
    if (p === null || !fs.existsSync(p)) {
      artifactsDb.deleteScannedArtifact.run(r.slug)
      out.removed++
    }
  }
  return out
}

/** Sweep a registered project's `<localPath>/artifacts/*.html`. Unknown/path-missing
 *  project → pure vanish-cleanup of its scanned rows (dir treated as absent). */
export function scanProjectArtifacts(projectId: string): ScanResult {
  const project = getProject(projectId)
  const dir = project ? path.join(project.localPath, 'artifacts') : ''
  const prefix = `project-${projectId}-`
  return sweep(dir, projectId, base => (prefix + slugifyBase(base)).slice(0, 80))
}

/** Sweep the harness's own ARTIFACTS_DIR loose HTML (projectId NULL). `dir` is
 *  parameterized for tests only. */
export function scanHarnessArtifacts(dir: string = ARTIFACTS_DIR): ScanResult {
  return sweep(dir, null, base => slugifyBase(base).slice(0, 80))
}

/** Boot-wired: re-scan a project's artifacts when one of its runs reaches terminal
 *  (agents drop reports/demos into <localPath>/artifacts). Reads project_id from the
 *  runs row (the bus Run envelope may omit it). Returns the unsubscribe teardown. */
export function startArtifactScanOnRunTerminal(): () => void {
  return eventBus.onRunUpdate(r => {
    if (!isTerminalRunStatus(r.status)) return
    try {
      const row = runsDb.getRun.get(r.id) as { project_id?: string | null } | undefined
      if (row?.project_id) scanProjectArtifacts(String(row.project_id))
    } catch (e) { console.warn('[artifact-scan] run-terminal sweep failed:', e) }
  })
}
