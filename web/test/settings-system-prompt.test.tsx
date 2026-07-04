/**
 * SettingsPage / SystemPromptSection — F-048:
 *   - copy: the endpoint serves agent-config/base-operating-prompt.md, not repo-root
 *     CLAUDE.md — the label must not claim CLAUDE.md anymore.
 *   - unsaved-changes guard: while the editor is dirty, a beforeunload prompt is armed
 *     so a reload/close/navigate can't silently discard the edit.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })
  }
})

const { mockGet, mockSave } = vi.hoisted(() => ({ mockGet: vi.fn(), mockSave: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { systemPrompt: { get: mockGet, save: mockSave } } }))

import { SystemPromptSection } from '../src/pages/SettingsPage'

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SystemPromptSection />
    </QueryClientProvider>,
  )
}

beforeEach(() => { mockGet.mockReset(); mockSave.mockReset(); mockGet.mockResolvedValue({ md: 'seed prompt' }) })
afterEach(() => cleanup())

describe('SystemPromptSection — F-048', () => {
  it('the copy references the base operating prompt, not CLAUDE.md', async () => {
    const { container } = renderSection()
    await screen.findByText(/base-operating-prompt\.md/)
    expect(container.textContent).not.toContain('CLAUDE.md')
  })

  it('arms a beforeunload guard only while the draft is dirty', async () => {
    renderSection()
    const editor = (await screen.findByTestId('system-prompt-editor')) as HTMLTextAreaElement
    await waitFor(() => expect(editor.value).toBe('seed prompt'))

    // Not dirty yet → beforeunload is not prevented.
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)

    // Make it dirty → the guard arms and prevents the unload.
    fireEvent.change(editor, { target: { value: 'edited prompt' } })
    await waitFor(() => {
      const dirtyEvt = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(dirtyEvt)
      expect(dirtyEvt.defaultPrevented).toBe(true)
    })
  })
})
