/**
 * SettingsNav (sticky section nav) — the sidebar items must be buttons that scroll
 * to their target section, never anchors that touch location.hash. The app is
 * hash-routed, so an `<a href="#id">` click sets `location.hash` and the router
 * navigates away from Settings to a 404 — this guards against that regression.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import SettingsNav from '../src/pages/SettingsNav'

const ITEMS = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
]

// The nav's click handler looks up `document.getElementById(item.id)` — render
// stub target sections alongside it, the way SettingsPage's real <section id=…>
// elements sit alongside the real nav.
function renderNav() {
  return render(
    <div>
      <SettingsNav items={ITEMS} />
      <div id="a">Section A</div>
      <div id="b">Section B</div>
    </div>,
  )
}

class MockIntersectionObserver {
  callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  // jsdom has neither — polyfill both before each render.
  // @ts-expect-error — test polyfill, not a full IntersectionObserver implementation.
  window.IntersectionObserver = MockIntersectionObserver
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SettingsNav', () => {
  it('renders items as buttons, not anchors', () => {
    renderNav()
    expect(screen.getByRole('button', { name: 'A' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'B' })).toBeTruthy()

    const anchors = document.querySelectorAll('a[href^="#"]')
    expect(anchors.length).toBe(0)
  })

  it('scrolls to the section on click without touching location.hash', async () => {
    const user = userEvent.setup()
    renderNav()

    const hashBefore = window.location.hash
    await user.click(screen.getByRole('button', { name: 'A' }))

    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled()
    expect(window.location.hash).toBe(hashBefore)
  })
})
