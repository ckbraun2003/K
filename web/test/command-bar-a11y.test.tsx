/**
 * CommandBar a11y + empty-state (Wave 3):
 *   F-005 — the `@` project picker shows a hint instead of a blank list when there
 *           are no projects to complete.
 *   F-006 — the results list has listbox/option semantics + aria-selected.
 *   F-007 — the footer mode chip stays on one line (nowrap).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Project, Status } from '@k/shared'

const statusValue: Status = {
  claude: { available: true },
  ollama: { enabled: false, reachable: false, baseUrl: '', model: '' },
  github: { authenticated: false },
  auth: { tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false, credentialPosture: 'managed' },
  voice: { enabled: false, reachable: false, baseUrl: '', model: '' },
}

const { projectsRef } = vi.hoisted(() => ({ projectsRef: { current: [] as Project[] } }))

vi.mock('../src/lib/api', () => ({
  api: {
    k: { ask: vi.fn() },
    runs: { list: async () => [], kill: async () => ({ killed: true }) },
    projects: { list: async () => projectsRef.current },
    claudeModel: { get: async () => ({ model: 'm', options: [] }) },
    status: async () => statusValue,
    voice: { transcribe: async () => ({ text: '' }) },
  },
}))
vi.mock('../src/lib/route', () => ({
  navigate: vi.fn(),
  KNOWN_VIEWS: new Set<string>(),
  isKnownView: () => true,
  useHashRoute: () => ({ view: 'home' }),
}))

import CommandBar from '../src/shell/CommandBar'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  projectsRef.current = []
})
afterEach(() => cleanup())

function renderBar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CommandBar open onClose={() => {}} />
    </QueryClientProvider>,
  )
}

const type = (v: string) =>
  fireEvent.change(screen.getByTestId('cmdk-input') as HTMLInputElement, { target: { value: v } })

describe('CommandBar @ empty-state (F-005)', () => {
  it('typing @ with zero projects shows a hint, not a blank list', async () => {
    renderBar()
    type('@')
    const empty = await screen.findByTestId('cmdk-empty')
    expect(empty.textContent).toMatch(/no projects yet/i)
  })
})

describe('CommandBar listbox semantics (F-006)', () => {
  it('the results list is a listbox and rows are options with aria-selected', async () => {
    renderBar()
    // UI Simplification Task 10: the 6-rail DESTINATIONS content changed (home's
    // label is now 'K', and the old 'Memory'/'Home' labels are gone) — 's' is the
    // letter that still matches several current nav labels (Personal/Agents/Runs/
    // Insights/Projects/Settings) + the ask-k row, preserving this test's intent.
    type('s') // matches several nav labels + the ask-k row
    await screen.findByRole('listbox')
    // Wait for the async queries (projects/runs/status) to settle — each can
    // re-fire CommandBar's "reset selection to 0" effect, so assert the resting
    // state: exactly one option selected, and it's the first (default) row.
    await waitFor(() => {
      const opts = screen.getAllByRole('option')
      expect(opts.length).toBeGreaterThan(1)
      expect(opts.filter(o => o.getAttribute('aria-selected') === 'true')).toHaveLength(1)
      expect(opts[0].getAttribute('aria-selected')).toBe('true')
    })

    // aria-selected FOLLOWS the highlight: hovering the second row selects it
    // (queries have settled, so nothing resets it back).
    fireEvent.mouseEnter(screen.getAllByRole('option')[1])
    await waitFor(() => {
      const opts = screen.getAllByRole('option')
      expect(opts[1].getAttribute('aria-selected')).toBe('true')
      expect(opts[0].getAttribute('aria-selected')).toBe('false')
    })
  })
})

describe('CommandBar mode chip nowrap (F-007)', () => {
  it('the ↵ mode chip is nowrap so it cannot break onto two lines', async () => {
    renderBar()
    type('zzz') // a plain query → the enter-mode chip renders
    const chip = await screen.findByTestId('enter-mode-toggle')
    expect(chip.className).toContain('whitespace-nowrap')
  })
})
