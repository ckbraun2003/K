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
  return {
    id: String(r.id),
    name: String(r.name),
    localPath: String(r.local_path),
    githubRemote: r.github_remote ? String(r.github_remote) : undefined,
    workspaceManaged: Boolean(r.workspace_managed),
    bibleDir: String(r.bible_dir),
    healthScore: r.health_score == null ? undefined : Number(r.health_score),
    lastVerifiedAt: r.last_verified_at == null ? undefined : Number(r.last_verified_at),
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

async function detectRemote(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath })
    const remote = remoteFromUrl(stdout.trim()) ?? undefined
    // Drop anything that isn't a safe owner/repo so an injectable value (e.g.
    // `-foo/bar`) is never persisted or later handed to the gh CLI.
    return remote && isSafeRemote(remote) ? remote : undefined
  } catch { return undefined }
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
      if (!fs.existsSync(path.join(localPath, '.git'))) {
        throw new ClientError('localPath is not a git repository')
      }
      githubRemote = await detectRemote(localPath)
    }

    const project: Project = {
      id: uuid(),
      name,
      localPath,
      githubRemote,
      workspaceManaged,
      bibleDir: 'artifacts/bible',
      createdAt: Date.now(),
    }
    projectsDb.insertProject.run({
      id: project.id,
      name: project.name,
      localPath: project.localPath,
      githubRemote: project.githubRemote ?? null,
      workspaceManaged: project.workspaceManaged ? 1 : 0,
      bibleDir: project.bibleDir,
      createdAt: project.createdAt,
    })
    return project
  } finally {
    inFlight.delete(name)
  }
}
