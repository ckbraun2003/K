import { describe, it, expect } from 'vitest'
import { matchProjectByCwd, type ProjectPathRow } from '../src/project-match.js'

const projects: ProjectPathRow[] = [
  { id: 'proj-a', local_path: '/home/user/repo' },
  { id: 'proj-b', local_path: '/home/user/repo-other' },
  { id: 'proj-c', local_path: '/home/user/repo/nested' },
]

describe('matchProjectByCwd', () => {
  it('exact match', () => {
    expect(matchProjectByCwd('/home/user/repo', projects)).toBe('proj-a')
  })

  it('subdirectory match', () => {
    // /home/user/repo/src/components is a subdir of proj-a (/home/user/repo)
    expect(matchProjectByCwd('/home/user/repo/src/components', projects)).toBe('proj-a')
    // /home/user/repo/nested/src is a subdir of proj-c (/home/user/repo/nested)
    expect(matchProjectByCwd('/home/user/repo/nested/src', projects)).toBe('proj-c')
  })

  it('case-insensitive matching', () => {
    expect(matchProjectByCwd('/HOME/USER/REPO', projects)).toBe('proj-a')
  })

  it('backslash-vs-slash mixing (Windows paths)', () => {
    const winProjects: ProjectPathRow[] = [
      { id: 'win-proj', local_path: 'C:\\Users\\user\\repo' },
    ]
    expect(matchProjectByCwd('C:/Users/user/repo/src', winProjects)).toBe('win-proj')
    expect(matchProjectByCwd('C:\\Users\\user\\repo\\src', winProjects)).toBe('win-proj')
  })

  it('trailing-slash tolerance on cwd', () => {
    expect(matchProjectByCwd('/home/user/repo/', projects)).toBe('proj-a')
  })

  it('trailing-slash tolerance on local_path', () => {
    const trailingProjects: ProjectPathRow[] = [
      { id: 'trail', local_path: '/home/user/repo/' },
    ]
    expect(matchProjectByCwd('/home/user/repo/src', trailingProjects)).toBe('trail')
  })

  it('no match returns null', () => {
    expect(matchProjectByCwd('/home/other/project', projects)).toBeNull()
  })

  it('nested projects — deepest (longest) root wins', () => {
    // /home/user/repo/nested is deeper than /home/user/repo
    expect(matchProjectByCwd('/home/user/repo/nested/src', projects)).toBe('proj-c')
  })

  it('C:/repo2 cwd does NOT match project at C:/repo', () => {
    const repoProjects: ProjectPathRow[] = [
      { id: 'repo', local_path: 'C:/repo' },
    ]
    expect(matchProjectByCwd('C:/repo2', repoProjects)).toBeNull()
    expect(matchProjectByCwd('C:/repo2/src', repoProjects)).toBeNull()
  })

  it('empty projects array returns null', () => {
    expect(matchProjectByCwd('/home/user/repo', [])).toBeNull()
  })
})
