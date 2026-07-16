/** FE-5 — ChangesLayout: dir-grouped tree + DiffViewer pane, unified/split
 *  persistence, j/k file nav, viewed marks, expand-context passthrough. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { DiffPayload } from '@k/shared'
import ChangesLayout from '../src/components/ChangesLayout'
import payload from './fixtures/impressive-wave/diff-payload.json'

const diff = payload as DiffPayload

// NOTE: the plan brief referenced a `src/lib/math.ts` fixture entry, but the
// real fixture (test/fixtures/impressive-wave/diff-payload.json, confirmed via
// Read) has no such file — its `src/lib` entry is `src/lib/format.ts`
// (+2/-1). Every reference below uses the real path/counts.

beforeEach(() => {
  // jsdom does not implement scrollIntoView (ChangesLayout's pickFile calls
  // it on the newly-selected file's section, same convention as
  // run-console-review-toggle.test.tsx).
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => cleanup())

describe('ChangesLayout', () => {
  it('renders the dir-grouped tree with per-file ± and the diff pane', () => {
    render(<ChangesLayout payload={diff} readOnly />)
    expect(screen.getByTestId('changes-tree')).toBeTruthy()
    expect(screen.getByText('src/lib')).toBeTruthy() // dir group
    expect(screen.getAllByText('+2').length).toBeGreaterThan(0)
    expect(screen.getByTestId('diff-viewer')).toBeTruthy()
  })

  it('persists the unified/split toggle', () => {
    localStorage.clear()
    render(<ChangesLayout payload={diff} readOnly />)
    // SegControl (the shared canonical control) renders `seg-${value}`
    // testids, not a caller-chosen string — confirmed via Read of
    // src/components/SegControl.tsx.
    fireEvent.click(screen.getByTestId('seg-unified'))
    expect(localStorage.getItem('k.diff.mode')).toBe('unified')
  })

  it('j/k walks the file selection', () => {
    render(<ChangesLayout payload={diff} readOnly />)
    fireEvent.keyDown(screen.getByTestId('changes-layout'), { key: 'j' })
    // The nav order is sourced from the rendered (dir-grouped, alphabetically
    // sorted) tree, not the raw payload's file order — otherwise j/k jumps
    // around visually. groupByDir on this fixture sorts dirs
    // assets < src/legacy < src/lib < src/pages, so the flattened order is
    // [assets/logo.png, src/legacy/old-report.ts, src/lib/format.ts,
    // src/pages/ReportPage.tsx, src/pages/InsightsPage.tsx]. One 'j' from an
    // unselected state (cur=-1) lands on index 0 of THAT order, which is also
    // DOM row 0 — not row 1.
    const rows = screen.getAllByTestId(/changes-file-/)
    expect(rows[0].getAttribute('aria-current')).toBe('true')
  })

  it('viewed toggle marks the tree row', () => {
    localStorage.clear()
    render(<ChangesLayout payload={diff} readOnly />)
    fireEvent.click(screen.getByTestId('diff-viewed-src/lib/format.ts'))
    expect(screen.getByTestId('changes-file-src/lib/format.ts').textContent).toContain('✓')
  })

  it('threads onExpandFile through to the file header', () => {
    const fn = vi.fn()
    render(<ChangesLayout payload={diff} readOnly onExpandFile={fn} />)
    fireEvent.click(screen.getByTestId('diff-expand-src/lib/format.ts'))
    expect(fn).toHaveBeenCalledWith('src/lib/format.ts')
  })
})
