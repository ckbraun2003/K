import { it, expect } from 'vitest'
import { selectThread, getSelectedThread, subscribeSelectedThread } from '../src/lib/thread-select'

it('stores, notifies, and persists selection', () => {
  const seen: Array<string | null> = []
  const un = subscribeSelectedThread(id => seen.push(id))
  selectThread('kt-1')
  expect(getSelectedThread()).toBe('kt-1')
  selectThread(null)
  expect(seen).toEqual(['kt-1', null])
  un()
})
