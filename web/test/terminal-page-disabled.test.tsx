/**
 * TerminalPage disabled state (F-008): a `disabled` gate frame must show a single,
 * user-facing message (no operator env-var jargon), and the inert xterm input must
 * drop out of the tab order. Driven through a fake WebSocket + real xterm (jsdom
 * canvas is stubbed away — the DOM renderer only warns).
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { errorReason } from '../src/lib/terminal'

let lastWs: FakeWS | null = null
let origWebSocket: unknown
class FakeWS {
  static OPEN = 1
  readyState = 0
  onopen: ((e?: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e?: unknown) => void) | null = null
  onclose: ((e?: unknown) => void) | null = null
  constructor() { lastWs = this }
  send() {}
  close() {}
}

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for xterm
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
  if (!(window as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
    ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  }
  origWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS
})
// Restore the real WebSocket so FakeWS can't leak into other test files sharing
// this worker (a stray global override would silently break their WS wiring).
afterAll(() => { (globalThis as unknown as { WebSocket: unknown }).WebSocket = origWebSocket })
afterEach(() => { cleanup(); lastWs = null })

import TerminalPage from '../src/pages/TerminalPage'

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

describe('TerminalPage disabled state', () => {
  it('shows the disabled reason once + a short pill, and de-focuses the inert input', () => {
    const { container, getByTestId } = render(<TerminalPage />)
    expect(lastWs).not.toBeNull()

    act(() => {
      lastWs!.onmessage!({ data: JSON.stringify({ type: 'error', code: 'disabled' }) })
    })

    const full = errorReason('disabled')
    // The full message renders exactly ONCE (in the overlay) — not echoed to the
    // header pill or the xterm buffer.
    expect(count(container.textContent ?? '', 'turned off')).toBe(1)
    expect(getByTestId('terminal-overlay').textContent).toContain(full)
    // Header pill is a short status word, NOT the full sentence.
    const pill = getByTestId('terminal-status').textContent ?? ''
    expect(pill).toBe('Off')
    expect(pill).not.toContain('turned off')

    // No operator env-var jargon anywhere.
    expect(container.textContent ?? '').not.toContain('ENABLE_TERMINAL')

    // The inert xterm helper textarea is out of the tab order.
    const ta = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    expect(ta).not.toBeNull()
    expect(ta!.getAttribute('tabindex')).toBe('-1')
  })
})
