import { describe, it, expect } from 'vitest'
import { validateRegistration, remoteFromUrl, isSafeRemote } from '../src/projects.js'

describe('validateRegistration', () => {
  it('accepts a localPath registration', () => {
    expect(validateRegistration({ name: 'x', localPath: 'C:/repo' }).ok).toBe(true)
  })
  it('accepts a githubUrl registration', () => {
    expect(validateRegistration({ name: 'x', githubUrl: 'https://github.com/o/r' }).ok).toBe(true)
  })
  it('rejects neither or both sources', () => {
    expect(validateRegistration({ name: 'x' }).ok).toBe(false)
    expect(validateRegistration({ name: 'x', localPath: 'a', githubUrl: 'b' }).ok).toBe(false)
  })
  it('rejects empty name', () => {
    expect(validateRegistration({ name: ' ', localPath: 'a' }).ok).toBe(false)
  })
  it('rejects unsafe directory names', () => {
    for (const name of ['../../evil', 'foo/bar', 'foo\\bar', '.', '..', '.git', 'con', 'nul.txt', 'foo.']) {
      expect(validateRegistration({ name, localPath: 'a' }).ok).toBe(false)
    }
    expect(validateRegistration({ name: 'my-repo_2.0', localPath: 'a' }).ok).toBe(true)
  })
})

describe('remoteFromUrl', () => {
  it('extracts owner/repo from https and ssh urls', () => {
    expect(remoteFromUrl('https://github.com/foo/bar')).toBe('foo/bar')
    expect(remoteFromUrl('https://github.com/foo/bar.git')).toBe('foo/bar')
    expect(remoteFromUrl('git@github.com:foo/bar.git')).toBe('foo/bar')
  })
  it('returns null for non-github urls', () => {
    expect(remoteFromUrl('https://gitlab.com/foo/bar')).toBeNull()
  })
})

// A5 — githubRemote option-injection hardening
describe('isSafeRemote', () => {
  it('accepts a plain owner/repo', () => {
    expect(isSafeRemote('owner/repo')).toBe(true)
    expect(isSafeRemote('my-org/my.repo_2')).toBe(true)
  })
  it('rejects a leading dash (gh flag injection)', () => {
    expect(isSafeRemote('-foo/bar')).toBe(false)
    expect(isSafeRemote('owner/-evil')).toBe(false)
  })
  it('rejects embedded shell/metacharacters and extra segments', () => {
    for (const r of ['owner/repo;evil', 'owner/repo evil', 'owner/repo/extra', 'owner', 'a/b/c', '']) {
      expect(isSafeRemote(r), r).toBe(false)
    }
  })
})
