import { describe, it, expect } from 'vitest'
import { classifySource, isPathLike, isGithubUrl } from '../src/lib/source'

describe('isPathLike', () => {
  const paths = [
    'C:\\Users\\ckbra\\myrepo', // Windows drive, backslashes (the bug)
    'C:/Users/x/repo',          // Windows drive, forward slashes
    'D:\\repo',                 // another drive
    '\\\\server\\share',        // UNC
    '/home/x/repo',             // POSIX absolute
    '~/repo',                   // home
    './repo',                   // relative
    '../repo',                  // parent-relative
    'repo\\sub',                // bare relative, backslash
    'repo/sub',                 // bare relative, forward slash
  ]
  it('recognises every well-formed local path', () => {
    for (const p of paths) expect(isPathLike(p), p).toBe(true)
  })

  it('does not treat URLs or garbage as paths', () => {
    for (const s of ['https://github.com/owner/repo', 'git@github.com:owner/repo.git', 'myrepo', '!!!', '']) {
      expect(isPathLike(s), s).toBe(false)
    }
  })

  it('the compiled regex literal contains BOTH separators', () => {
    // Guards the escaping bug: in a regex literal `[/\\]` matches `/` and `\`.
    expect(/^[a-zA-Z]:[/\\]/.source).toContain('\\\\')
    expect(/^[a-zA-Z]:[/\\]/.source).toContain('/')
  })
})

describe('isGithubUrl', () => {
  it('recognises VCS URLs', () => {
    for (const u of [
      'https://github.com/owner/repo',
      'http://example.com/repo',
      'git@github.com:owner/repo.git',
      'https://gitlab.com/x/y.git',
    ]) {
      expect(isGithubUrl(u), u).toBe(true)
    }
  })

  it('rejects local paths and garbage', () => {
    for (const s of ['C:\\Users\\ckbra\\myrepo', './repo', 'myrepo', '']) {
      expect(isGithubUrl(s), s).toBe(false)
    }
  })
})

describe('classifySource', () => {
  it('classifies paths as path-like', () => {
    expect(classifySource('C:\\Users\\ckbra\\myrepo')).toBe('path')
    expect(classifySource('C:/Users/x/repo')).toBe('path')
    expect(classifySource('D:\\repo')).toBe('path')
    expect(classifySource('\\\\server\\share')).toBe('path')
    expect(classifySource('/home/x/repo')).toBe('path')
    expect(classifySource('~/repo')).toBe('path')
    expect(classifySource('./repo')).toBe('path')
    expect(classifySource('../repo')).toBe('path')
    expect(classifySource('repo\\sub')).toBe('path')
  })

  it('classifies VCS URLs as url', () => {
    expect(classifySource('https://github.com/owner/repo')).toBe('url')
    expect(classifySource('git@github.com:owner/repo.git')).toBe('url')
  })

  it('classifies genuine garbage as invalid', () => {
    expect(classifySource('myrepo')).toBe('invalid')
    expect(classifySource('!!!')).toBe('invalid')
    expect(classifySource('')).toBe('invalid')
    expect(classifySource('   ')).toBe('invalid')
  })
})
