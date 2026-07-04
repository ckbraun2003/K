/**
 * ProjectCard — F-065: a fleet card showed verification + remote warnings but never
 * any last-run info. With a lastRun it must render the run's status + when.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { Project, Run } from '@k/shared'

vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))
import ProjectCard from '../src/components/ProjectCard'

const project: Project = { id: 'p1', name: 'P', localPath: '/p', githubRemote: 'o/r', workspaceManaged: false, bibleDir: 'docs/bible', createdAt: 0 }
const lastRun: Run = {
  id: 'run-1', prompt: 'do it', cwd: '/p', status: 'done', provider: 'claude', model: 'm',
  tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: 'p1', createdAt: Date.now() - 5 * 60_000,
}

afterEach(() => cleanup())

describe('ProjectCard — F-065 last-run info', () => {
  it('renders the last run status + relative time when a lastRun is given', () => {
    render(<ProjectCard project={project} lastRun={lastRun} />)
    const line = screen.getByTestId('project-card-lastrun-p1')
    expect(line.textContent).toContain('last run done')
    expect(line.textContent).toMatch(/ago/)
  })

  it('renders no last-run line when there is no run', () => {
    render(<ProjectCard project={project} lastRun={null} />)
    expect(screen.queryByTestId('project-card-lastrun-p1')).toBeNull()
  })
})
