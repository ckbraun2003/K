/**
 * Project registry — bible §3.
 * Two onboarding paths: register an existing local repo by path, or clone a
 * GitHub URL into the managed workspace (gh repo clone).
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execa } from 'execa'
import { v4 as uuid } from 'uuid'
import type { Project } from '@k/shared'
import { projectsDb } from './db.js'
import { isPathWithin } from './paths.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const WORKSPACE_DIR = path.join(__dirname, '../../workspace')

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

// A trustworthy "owner/repo": exactly two safe segments. Anchored so embedded
// metacharacters (`owner/repo;evil`) are rejected, and no segment may start with
// `-` so the value can never be misread as a `gh` CLI flag (option injection).
const SAFE_REMOTE_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/

/** True if `remote` is a safe "owner/repo" that cannot be parsed as a gh flag. */
export function isSafeRemote(remote: string): boolean {
  return SAFE_REMOTE_RE.test(remote)
}

/** Errors caused by bad client input — routes map these to 400. */
export class ClientError extends Error {}

/** A registration that conflicts with EXISTING registry state (e.g. the same repo
 *  path already registered) — routes map these to 409 Conflict, mirroring the
 *  duplicate-name (UNIQUE constraint) handling. Deliberately NOT a ClientError so
 *  the route's ClientError→400 branch never swallows it. */
export class ConflictError extends Error {}

/**
 * Canonical key for a filesystem path, for duplicate-registration detection.
 * `path.resolve` normalizes separators + `.`/`..` and drops trailing separators
 * (except a drive/filesystem root); on Windows (case-insensitive FS) we also
 * lower-case so `C:\X` and `c:\x\` collide. Applied identically to the incoming
 * path AND every stored `localPath` so the comparison is symmetric. (realpath /
 * symlink resolution is intentionally NOT used: stored rows were only resolve()'d,
 * so realpathing one side would produce a mismatch — resolve+casefold is the
 * consistent, FS-touch-free normalization.) */
export function normalizePathKey(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** The already-registered project managing `localPath` (normalized), or null. Used
 *  to reject a duplicate-path registration before a second row can manage one repo. */
export function findProjectByPath(localPath: string): Project | null {
  const key = normalizePathKey(localPath)
  return listProjects().find(p => normalizePathKey(p.localPath) === key) ?? null
}

export interface RegistrationBody {
  name: string
  localPath?: string
  githubUrl?: string
}

export function validateRegistration(b: RegistrationBody): { ok: true } | { ok: false; error: string } {
  if (!b.name?.trim()) return { ok: false, error: 'name is required' }
  const name = b.name.trim()
  if (!NAME_RE.test(name) || name.endsWith('.') || WINDOWS_RESERVED.test(name)) {
    return { ok: false, error: 'name must be a safe directory name (letters, digits, _ . -)' }
  }
  const sources = [b.localPath, b.githubUrl].filter(Boolean).length
  if (sources !== 1) return { ok: false, error: 'provide exactly one of localPath or githubUrl' }
  return { ok: true }
}

export function remoteFromUrl(url: string): string | null {
  const m = url.match(/(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)
  return m ? m[1] : null
}

function rowToProject(r: Record<string, unknown>): Project {
  // pathMissing is derived at read time (never persisted): true when localPath no
  // longer exists on disk, so the UI can badge the project and the GitHub poller
  // skips it. Spread-conditional so the key is INCLUDED only when missing —
  // payloads for healthy projects stay byte-identical to before.
  const pathMissing = !fs.existsSync(String(r.local_path))
  return {
    id: String(r.id),
    name: String(r.name),
    localPath: String(r.local_path),
    githubRemote: r.github_remote ? String(r.github_remote) : undefined,
    workspaceManaged: Boolean(r.workspace_managed),
    bibleDir: String(r.bible_dir),
    ...(r.default_branch == null ? {} : { defaultBranch: String(r.default_branch) }),
    healthScore: r.health_score == null ? undefined : Number(r.health_score),
    lastVerifiedAt: r.last_verified_at == null ? undefined : Number(r.last_verified_at),
    ...(pathMissing ? { pathMissing: true } : {}),
    createdAt: Number(r.created_at),
  }
}

export function listProjects(): Project[] {
  return (projectsDb.listProjects.all() as Array<Record<string, unknown>>).map(rowToProject)
}

export function getProject(id: string): Project | null {
  const row = projectsDb.getProject.get(id) as Record<string, unknown> | undefined
  return row ? rowToProject(row) : null
}

/** Look up a project by its (UNIQUE) name. Exact match first; falls back to a
 *  case-insensitive match only when it is unambiguous (the Chief's scope_projects
 *  names are free text). Null when nothing (or more than one) matches. */
export function getProjectByName(name: string): Project | null {
  const all = listProjects()
  const exact = all.find(p => p.name === name)
  if (exact) return exact
  const ci = all.filter(p => p.name.toLowerCase() === name.toLowerCase())
  return ci.length === 1 ? ci[0] : null
}

async function detectRemote(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath })
    const remote = remoteFromUrl(stdout.trim()) ?? undefined
    // Drop anything that isn't a safe owner/repo so an injectable value (e.g.
    // `-foo/bar`) is never persisted or later handed to the gh CLI.
    return remote && isSafeRemote(remote) ? remote : undefined
  } catch { return undefined }
}

/**
 * Detect a repo's real default branch, to persist on the Project row (W4 follow-up:
 * the PR-base default should prefer this over a fragile CI-branch heuristic).
 * Preference order:
 *  1. `origin/HEAD` (the remote's declared default) → strip the `origin/` prefix.
 *  2. the current branch (`git rev-parse --abbrev-ref HEAD`) when there is no
 *     origin/HEAD (a fresh local repo / no remote) and it isn't detached ('HEAD').
 *  3. 'main' as a last resort.
 * Never throws — any git failure falls through to the next option. */
export async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath })
    const ref = stdout.trim() // e.g. "origin/main"
    const branch = ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref
    if (branch) return branch
  } catch { /* no origin/HEAD — fall through to the current branch */ }
  try {
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath })
    const branch = stdout.trim()
    if (branch && branch !== 'HEAD') return branch
  } catch { /* detached / not a repo — fall through */ }
  return 'main'
}

/**
 * Remove a K-MANAGED clone directory on project delete (F-039). SAFETY: only ever
 * removes a clone the harness itself cloned into the workspace root — a
 * `workspaceManaged` project whose `localPath` is strictly UNDER WORKSPACE_DIR.
 * A registered-in-place project (workspaceManaged=false) or any path outside the
 * workspace is NEVER touched — the operator's own repo must survive a registry
 * delete. Returns true iff a dir was removed. Best-effort: a failed rmdir is
 * swallowed (the registry row is already gone; an orphaned dir is the lesser evil
 * than a thrown delete) and reported via the returned boolean for logging. */
export function removeManagedCloneDir(project: Pick<Project, 'workspaceManaged' | 'localPath'>): boolean {
  if (!project.workspaceManaged) return false
  // Defense in depth: even a managed flag can't authorize deleting outside the
  // workspace root (guards against a corrupted/hand-edited row).
  if (!isPathWithin(WORKSPACE_DIR, project.localPath)) return false
  try {
    fs.rmSync(project.localPath, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Log ONE warning per registered project whose localPath has vanished on disk
 * (F-033 / CLAIM-11-9: one warn/boot). pathMissing is derived in rowToProject, so a
 * plain listProjects() read carries the signal. Called once at boot. `projects`
 * defaults to the live registry; injectable for tests. */
export function warnStaleProjectPaths(projects: Project[] = listProjects()): void {
  for (const p of projects) {
    if (p.pathMissing) {
      console.warn(`[projects] localPath missing on disk for "${p.name}" (${p.localPath}) — workspace actions are disabled until it is restored or the project is removed`)
    }
  }
}

const inFlight = new Set<string>()

export async function registerProject(b: RegistrationBody): Promise<Project> {
  const name = b.name.trim()
  if (inFlight.has(name)) throw new ClientError(`registration already in progress for ${name}`)
  inFlight.add(name)
  try {
    let localPath: string
    let workspaceManaged = false
    let githubRemote: string | undefined

    if (b.githubUrl) {
      const remote = remoteFromUrl(b.githubUrl)
      if (!remote) throw new ClientError(`not a GitHub URL: ${b.githubUrl}`)
      if (!isSafeRemote(remote)) throw new ClientError(`unsafe GitHub remote: ${remote}`)
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
      localPath = path.join(WORKSPACE_DIR, name)
      if (!localPath.startsWith(WORKSPACE_DIR + path.sep)) {
        throw new ClientError(`invalid project name`)
      }
      if (!fs.existsSync(localPath)) {
        await execa('gh', ['repo', 'clone', remote, localPath])
      } else {
        const existing = await detectRemote(localPath)
        if (existing !== remote) {
          throw new ClientError(`workspace/${name} already exists but points at ${existing ?? 'no remote'}, not ${remote}`)
        }
      }
      workspaceManaged = true
      githubRemote = remote
    } else {
      localPath = path.resolve(b.localPath!)
      // F-037: distinguish "the path isn't there at all" from "the path is there but
      // isn't a git repository root" — both used to share one misleading message.
      if (!fs.existsSync(localPath)) {
        throw new ClientError(`path does not exist: ${localPath}`)
      }
      if (!fs.existsSync(path.join(localPath, '.git'))) {
        throw new ClientError(`path is not a git repository (no .git found — register the repository root): ${localPath}`)
      }
      githubRemote = await detectRemote(localPath)
    }

    // F-031: reject a duplicate localPath BEFORE inserting a second row for one repo
    // (the name is UNIQUE but the path was not, so two projects could manage — and
    // then collide onboarding/bible/verify on — the same working tree). Normalized
    // so C:\X and c:\x\ collide. 409 Conflict, mirroring the duplicate-name handling.
    const existing = findProjectByPath(localPath)
    if (existing) {
      throw new ConflictError(`localPath is already registered as project "${existing.name}": ${localPath}`)
    }

    // Detect + persist the repo's real default branch (W4 follow-up) so the PR-base
    // default prefers it over a heuristic. Never throws → 'main' fallback.
    const defaultBranch = await detectDefaultBranch(localPath)

    const project: Project = {
      id: uuid(),
      name,
      localPath,
      githubRemote,
      workspaceManaged,
      bibleDir: 'artifacts/bible',
      defaultBranch,
      createdAt: Date.now(),
    }
    // Atomic (MEDIUM-1): the row insert + its default_branch write land together, so a
    // crash between them can't strand a row with the detected branch lost.
    projectsDb.insertProjectWithDefaultBranch(
      {
        id: project.id,
        name: project.name,
        localPath: project.localPath,
        githubRemote: project.githubRemote ?? null,
        workspaceManaged: project.workspaceManaged ? 1 : 0,
        bibleDir: project.bibleDir,
        createdAt: project.createdAt,
      },
      defaultBranch,
    )
    return project
  } finally {
    inFlight.delete(name)
  }
}
