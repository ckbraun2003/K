/**
 * F-039 — deleting a project removes its K-MANAGED clone dir, but NEVER a user's own
 * in-place repo. removeManagedCloneDir is the guarded primitive: it only ever removes
 * a workspaceManaged project whose localPath is strictly UNDER the workspace root.
 *
 * These are the SAFETY tests: a non-managed project, and a managed project whose path
 * somehow points outside the workspace, must both survive untouched.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { removeManagedCloneDir, WORKSPACE_DIR } from '../src/projects.js'

const cleanup: string[] = []
afterAll(() => {
  for (const d of cleanup) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** A throwaway dir UNDER the real workspace root (where K clones live). */
function makeWorkspaceClone(): string {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
  const d = fs.mkdtempSync(path.join(WORKSPACE_DIR, 'k-f039-clone-'))
  cleanup.push(d)
  fs.writeFileSync(path.join(d, 'file.txt'), 'clone contents')
  return d
}

/** A throwaway dir OUTSIDE the workspace root (stands in for a user's own repo). */
function makeExternalDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-f039-ext-'))
  cleanup.push(d)
  fs.writeFileSync(path.join(d, 'file.txt'), 'user repo')
  return d
}

describe('removeManagedCloneDir', () => {
  it('removes a workspaceManaged clone that lives under the workspace root', () => {
    const localPath = makeWorkspaceClone()
    expect(fs.existsSync(localPath)).toBe(true)
    const removed = removeManagedCloneDir({ workspaceManaged: true, localPath })
    expect(removed).toBe(true)
    expect(fs.existsSync(localPath)).toBe(false)
  })

  it('NEVER touches an in-place (non-managed) project — the user\'s own repo survives', () => {
    const localPath = makeExternalDir()
    const removed = removeManagedCloneDir({ workspaceManaged: false, localPath })
    expect(removed).toBe(false)
    expect(fs.existsSync(localPath)).toBe(true) // untouched
  })

  it('refuses to remove even a MANAGED project whose path is outside the workspace root (guard)', () => {
    const localPath = makeExternalDir()
    // A corrupted/hand-edited row: managed flag set but path outside workspace.
    const removed = removeManagedCloneDir({ workspaceManaged: true, localPath })
    expect(removed).toBe(false)
    expect(fs.existsSync(localPath)).toBe(true) // guard held — nothing deleted
  })

  it('is best-effort: an already-missing managed clone dir does not throw', () => {
    const localPath = path.join(WORKSPACE_DIR, `k-f039-gone-${Date.now()}`)
    expect(() => removeManagedCloneDir({ workspaceManaged: true, localPath })).not.toThrow()
  })

  it('SAFETY: refuses when localPath === WORKSPACE_DIR exactly (never rm the workspace root)', () => {
    // isPathWithin(root, root) is inclusive:false, so the workspace root itself is
    // NOT "within" — the guard returns false and the root is never removed.
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
    const removed = removeManagedCloneDir({ workspaceManaged: true, localPath: WORKSPACE_DIR })
    expect(removed).toBe(false)
    expect(fs.existsSync(WORKSPACE_DIR)).toBe(true) // workspace root intact
  })
})
