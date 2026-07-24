// @vitest-environment jsdom
import { it, expect, beforeEach, vi } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

it('stores, notifies, and persists selection', async () => {
  const { selectThread, getSelectedThread, subscribeSelectedThread } = await import('../src/lib/thread-select')
  const seen: Array<string | null> = []
  const un = subscribeSelectedThread(id => seen.push(id))
  selectThread('kt-1')
  expect(getSelectedThread()).toBe('kt-1')
  selectThread(null)
  expect(seen).toEqual(['kt-1', null])
  un()
})

// UI Adjustments Task C1 — the boot default is ALWAYS a new-chat draft, even
// when a previous session left a thread selected in localStorage.
it('boots to a new-chat draft (null) even when localStorage holds a prior selection', async () => {
  localStorage.setItem('k.chat.selected', 'kt-9')
  const { getSelectedThread, selectThread } = await import('../src/lib/thread-select')

  // The module-level seed ignores the stale localStorage value...
  expect(getSelectedThread()).toBe(null)

  // ...but in-session selection still write-through persists (unchanged behavior).
  selectThread('kt-3')
  expect(getSelectedThread()).toBe('kt-3')
  expect(localStorage.getItem('k.chat.selected')).toBe('kt-3')
})
