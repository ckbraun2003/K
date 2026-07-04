/**
 * F-033 (core) — boot logs ONE warning per registered project whose localPath has
 * vanished on disk (CLAIM-11-9: one warn/boot). pathMissing is derived in
 * rowToProject, so warnStaleProjectPaths just reads the flag; here we inject a
 * synthetic list to assert the warn contract deterministically (no DB/FS dependency).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Project } from '@k/shared'
import { warnStaleProjectPaths } from '../src/projects.js'

function project(name: string, localPath: string, pathMissing?: boolean): Project {
  return {
    id: `id-${name}`,
    name,
    localPath,
    workspaceManaged: false,
    bibleDir: 'artifacts/bible',
    createdAt: Date.now(),
    ...(pathMissing ? { pathMissing: true } : {}),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('warnStaleProjectPaths', () => {
  it('warns exactly once per missing-path project, naming its path; healthy projects are silent', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnStaleProjectPaths([
      project('alpha', '/gone/alpha', true),
      project('beta', '/exists/beta', false),
      project('gamma', '/gone/gamma', true),
    ])
    // one warn per missing project (2), none for the healthy one.
    expect(spy).toHaveBeenCalledTimes(2)
    const messages = spy.mock.calls.map(c => String(c[0]))
    expect(messages.some(m => m.includes('alpha') && m.includes('/gone/alpha'))).toBe(true)
    expect(messages.some(m => m.includes('gamma') && m.includes('/gone/gamma'))).toBe(true)
    expect(messages.some(m => m.includes('beta'))).toBe(false)
  })

  it('is silent when every project path exists', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnStaleProjectPaths([project('a', '/x/a', false), project('b', '/x/b', false)])
    expect(spy).not.toHaveBeenCalled()
  })
})
