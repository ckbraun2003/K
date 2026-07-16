/** FE-6 — the in-app user guide: HELP_PAGES content, HelpGuide dialog
 *  navigation (rail/next/prev/arrow-keys/Esc), Sidebar's Help entry opening it
 *  via the bus instead of navigating, and the first-run auto-open check. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HELP_PAGES } from '../src/help/pages'
import HelpGuide from '../src/help/HelpGuide'

afterEach(() => cleanup())

// ── Probe 1: HELP_PAGES content ─────────────────────────────────────────────
describe('HELP_PAGES', () => {
  it('has exactly 7 entries with unique ids and non-empty titles', () => {
    expect(HELP_PAGES).toHaveLength(7)
    expect(new Set(HELP_PAGES.map(p => p.id)).size).toBe(7)
    for (const p of HELP_PAGES) expect(p.title.length).toBeGreaterThan(0)
  })
})

// ── Probe 2: HelpGuide navigation ───────────────────────────────────────────
describe('HelpGuide', () => {
  it('opens on page 1, steps via next/prev and ArrowLeft/ArrowRight, closes on Esc', () => {
    const onOpenChange = vi.fn()
    render(<HelpGuide open onOpenChange={onOpenChange} />)

    const guide = screen.getByTestId('help-guide')
    expect(screen.getByTestId(`help-page-${HELP_PAGES[0].id}`).getAttribute('aria-current')).toBe('page')

    fireEvent.click(screen.getByTestId('help-next'))
    expect(screen.getByTestId(`help-page-${HELP_PAGES[1].id}`).getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId(`help-page-${HELP_PAGES[0].id}`).getAttribute('aria-current')).toBeNull()

    fireEvent.keyDown(guide, { key: 'ArrowRight' })
    expect(screen.getByTestId(`help-page-${HELP_PAGES[2].id}`).getAttribute('aria-current')).toBe('page')

    fireEvent.click(screen.getByTestId('help-prev'))
    expect(screen.getByTestId(`help-page-${HELP_PAGES[1].id}`).getAttribute('aria-current')).toBe('page')

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

// ── Probe 3: Sidebar's Help entry opens the guide, never navigates ─────────
const { mockOpenHelp, mockNavigate, runsRef } = vi.hoisted(() => ({
  mockOpenHelp: vi.fn(),
  mockNavigate: vi.fn(),
  runsRef: { current: [] as import('@k/shared').Run[] },
}))
vi.mock('../src/lib/help-bus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/help-bus')>()
  return { ...actual, openHelp: mockOpenHelp, onHelpOpen: vi.fn(() => () => {}) }
})
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))
vi.mock('../src/lib/runs-query', () => ({
  RUNS_LIST_KEY: ['runs', 'list', 'default'],
  runsListQueryFn: async () => runsRef.current,
  isActiveRun: (r: { status: string }) => r.status === 'running' || r.status === 'queued',
  isParkedRun: (r: { status: string }) => r.status === 'awaiting_input' || r.status === 'awaiting_plan',
}))

describe('Sidebar Help entry', () => {
  beforeEach(() => { mockOpenHelp.mockReset(); mockNavigate.mockReset(); runsRef.current = [] })

  it('clicking Help calls openHelp(), never navigate()', async () => {
    const { default: Sidebar } = await import('../src/shell/Sidebar')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <Sidebar active="home" collapsed={false} onToggleCollapse={vi.fn()} />
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Help' }))
    expect(mockOpenHelp).toHaveBeenCalledTimes(1)
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})

// ── Probe 4: first-run auto-open check. Shell has no render-test scaffolding
// in this codebase (mounting it needs WS/react-query/every routed page), so
// the brief's own fallback applies: `shouldAutoOpenHelp()` lives in help-bus.ts
// (a zero-dependency module, not Shell.tsx) precisely so it can be unit-tested
// without dragging in Shell's entire page-import graph — Shell's wiring
// (`useEffect(() => { if (shouldAutoOpenHelp()) setHelpOpen(true) }, [])`) is
// a one-line call verified by inspection. ───────────────────────────────────
describe('shouldAutoOpenHelp (Shell first-run wiring, FE-6)', () => {
  beforeEach(() => { localStorage.clear() })

  it('returns true and marks k.help.seen the first time; false every time after', async () => {
    const { shouldAutoOpenHelp } = await import('../src/lib/help-bus')
    expect(localStorage.getItem('k.help.seen')).toBeNull()
    expect(shouldAutoOpenHelp()).toBe(true)
    expect(localStorage.getItem('k.help.seen')).toBe('1')
    expect(shouldAutoOpenHelp()).toBe(false)
    expect(shouldAutoOpenHelp()).toBe(false)
  })
})
