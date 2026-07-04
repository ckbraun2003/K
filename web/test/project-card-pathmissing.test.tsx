/**
 * ProjectCard — F-033: a project whose localPath has vanished on disk (pathMissing)
 * must look DIFFERENT from a healthy one — a clear "path missing" banner — and its
 * workspace action (Run verification) must be disabled so it can't act on a gone path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { Project } from '@k/shared'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('../src/lib/route', () => ({ navigate }))
import ProjectCard from '../src/components/ProjectCard'

const healthy: Project = { id: 'p1', name: 'P', localPath: '/p', githubRemote: 'o/r', workspaceManaged: false, bibleDir: 'docs/bible', createdAt: 0 }
const missing: Project = { ...healthy, pathMissing: true }

afterEach(() => { cleanup(); navigate.mockReset() })

describe('ProjectCard — F-033 path missing', () => {
  it('renders a path-missing banner when pathMissing is set', () => {
    render(<ProjectCard project={missing} />)
    const banner = screen.getByTestId('project-card-pathmissing-p1')
    expect(banner.textContent).toMatch(/path missing/i)
  })

  it('does NOT render the banner for a healthy project', () => {
    render(<ProjectCard project={healthy} />)
    expect(screen.queryByTestId('project-card-pathmissing-p1')).toBeNull()
  })

  it('disables Run verification and never fires the verify action when pathMissing', () => {
    render(<ProjectCard project={missing} />)
    const btn = screen.getByTestId('project-verify-btn-p1') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    // A disabled button's own handler never runs, so the verify route is never taken.
    // (A click may still bubble to the card → workspace view, which is allowed — the
    // workspace shows the path-missing banner + disabled actions.)
    expect(navigate).not.toHaveBeenCalledWith('verify', 'p1')
  })

  it('keeps Run verification enabled for a healthy project', () => {
    render(<ProjectCard project={healthy} />)
    const btn = screen.getByTestId('project-verify-btn-p1') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })
})
