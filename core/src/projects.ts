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

export interface RegistrationBody {
  name: string
  localPath?: string
  githubUrl?: string
}

export function validateRegistration(b: RegistrationBody): { ok: true } | { ok: false; error: string } {
  if (!b.name?.trim()) return { ok: false, error: 'name is required' }
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
    return remoteFromUrl(stdout.trim()) ?? undefined
  } catch { return undefined }
}

export async function registerProject(b: RegistrationBody): Promise<Project> {
  let localPath: string
  let workspaceManaged = false
  let githubRemote: string | undefined

  if (b.githubUrl) {
    const remote = remoteFromUrl(b.githubUrl)
    if (!remote) throw new Error(`not a GitHub URL: ${b.githubUrl}`)
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
    localPath = path.join(WORKSPACE_DIR, b.name)
    if (!fs.existsSync(localPath)) {
      await execa('gh', ['repo', 'clone', remote, localPath])
    }
    workspaceManaged = true
    githubRemote = remote
  } else {
    localPath = path.resolve(b.localPath!)
    if (!fs.existsSync(path.join(localPath, '.git'))) {
      throw new Error(`${localPath} is not a git repository`)
    }
    githubRemote = await detectRemote(localPath)
  }

  const project: Project = {
    id: uuid(),
    name: b.name.trim(),
    localPath,
    githubRemote,
    workspaceManaged,
    bibleDir: 'docs/bible',
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
}
