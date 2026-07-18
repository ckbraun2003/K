/**
 * LoginScreen (F-085/F-087): the submitted token is validated against an
 * authenticated endpoint BEFORE entering the app. A 401 shows an inline error and
 * keeps the typed value (no silent blank-form retry loop); a 200 enters the app.
 * The pre-auth copy must not disclose the on-disk token path.
 *
 * These are COMPONENT tests (api mocked) — under `pnpm dev` the Vite proxy injects
 * the Bearer unconditionally, so the gate is only reachable in a production build.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const { mockStatus } = vi.hoisted(() => ({ mockStatus: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { status: mockStatus } }))

import LoginScreen from '../src/shell/LoginScreen'

beforeEach(() => {
  mockStatus.mockReset()
  try { sessionStorage.clear() } catch { /* ignore */ }
})
afterEach(() => cleanup())

function submit(value: string) {
  const input = screen.getByPlaceholderText('HARNESS_TOKEN') as HTMLInputElement
  fireEvent.change(input, { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: /connect/i }))
  return input
}

describe('LoginScreen', () => {
  it('a rejected token shows an inline error and keeps the entered value (F-085)', async () => {
    mockStatus.mockRejectedValue(new Error('401 Unauthorized'))
    const onAuthed = vi.fn()
    render(<LoginScreen onAuthed={onAuthed} />)

    const input = submit('wrong-token')
    await screen.findByTestId('login-error')
    expect(screen.getByTestId('login-error').textContent).toMatch(/invalid token/i)
    expect(onAuthed).not.toHaveBeenCalled()
    expect(input.value).toBe('wrong-token') // value retained
    expect(mockStatus).toHaveBeenCalledTimes(1)
  })

  it('a valid token validates then enters the app (F-085)', async () => {
    mockStatus.mockResolvedValue({})
    const onAuthed = vi.fn()
    render(<LoginScreen onAuthed={onAuthed} />)

    submit('good-token')
    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('login-error')).toBeNull()
  })

  it('renders a post-rejection initialError (bounced back out of a session)', () => {
    render(<LoginScreen onAuthed={vi.fn()} initialError="Your session ended — enter your token to reconnect." />)
    expect(screen.getByTestId('login-error').textContent).toMatch(/session ended/i)
  })

  it('the pre-auth copy does not disclose the on-disk token path (F-087)', () => {
    const { container } = render(<LoginScreen onAuthed={vi.fn()} />)
    expect(container.textContent).not.toContain('auth-token')
    expect(container.textContent).not.toContain('data/')
  })

  it('renders the static gradient backdrop (wallpaper UI — Ambient retired)', () => {
    const { container } = render(<LoginScreen onAuthed={vi.fn()} />)
    const backdrop = screen.getByTestId('login-backdrop')
    expect(backdrop).toBeTruthy()
    expect(backdrop.getAttribute('aria-hidden')).toBe('true')
    expect(backdrop.className).toContain('bg-gradient-aurora')
    // No canvas/animation loop left in the pre-auth screen.
    expect(container.querySelector('canvas')).toBeNull()
  })
})
