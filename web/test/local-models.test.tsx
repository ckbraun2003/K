/**
 * Settings model-management sections (P5.5) — render + live pull progress.
 *
 * api + ws are mocked so no network/socket is needed. The captured onWsMessage
 * handler lets the test drive an `ollama_pull` event and assert the live progress
 * bar renders (the EventBus→WS wire the panel consumes).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { WsMessage } from '@k/shared'
import type { OllamaModelsResponse, OllamaCatalogResponse } from '../src/lib/ollama'

// ── mock the ws wire: capture the handler so the test can emit events ───────────
let wsHandler: ((m: WsMessage) => void) | null = null
vi.mock('../src/lib/ws', () => ({
  onWsMessage: (h: (m: WsMessage) => void) => {
    wsHandler = h
    return () => { wsHandler = null }
  },
}))

// ── mock the api client ─────────────────────────────────────────────────────────
const modelsData: OllamaModelsResponse = {
  active: 'llama3.2',
  installed: [
    { name: 'llama3.2', sizeBytes: 2 * 1024 ** 3 },
    { name: 'mistral:7b', sizeBytes: Math.round(4.1 * 1024 ** 3) },
  ],
}
const catalogData: OllamaCatalogResponse = {
  freeDiskBytes: 50 * 1024 ** 3,
  items: [
    { name: 'qwen2.5:0.5b', label: 'Qwen 2.5 0.5B', sizeBytes: 400 * 1024 ** 2, blurb: 'tiny', paramSize: '0.5B', installed: false, fitsOnDisk: true },
    { name: 'phi4', label: 'Phi-4', sizeBytes: 9 * 1024 ** 3, blurb: 'big', installed: false, fitsOnDisk: false },
    { name: 'llama3.2', label: 'Llama 3.2 3B', sizeBytes: 2 * 1024 ** 3, blurb: 'balanced', paramSize: '3B', installed: true, fitsOnDisk: true },
  ],
}
const pullSpy = vi.fn(async () => ({ name: 'qwen2.5:0.5b', queued: true }))
const cancelPullSpy = vi.fn(async (n: string) => ({ cancelled: n }))
const setActiveSpy = vi.fn(async (m: string) => ({ active: m }))
vi.mock('../src/lib/api', () => ({
  api: {
    ollama: {
      models: vi.fn(async () => modelsData),
      catalog: vi.fn(async () => catalogData),
      pull: (n: string) => pullSpy(n),
      cancelPull: (n: string) => cancelPullSpy(n),
      setActive: (m: string) => setActiveSpy(m),
      remove: vi.fn(),
    },
    claudeModel: {
      get: vi.fn(async () => ({
        model: 'claude-sonnet-4-6',
        options: [
          { id: 'claude-opus-4-8', label: 'Opus 4.8' },
          { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
        ],
      })),
      set: vi.fn(async (m: string) => ({ model: m })),
    },
  },
}))

import { LocalModelsSection, ClaudeModelSection } from '../src/pages/SettingsModels'

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => { wsHandler = null; pullSpy.mockClear(); cancelPullSpy.mockClear(); setActiveSpy.mockClear() })
afterEach(() => cleanup())

describe('ClaudeModelSection', () => {
  it('renders the model picker seeded with the live default + options', async () => {
    renderWithQuery(<ClaudeModelSection />)
    const select = await screen.findByTestId('claude-model-select') as HTMLSelectElement
    expect(select.value).toBe('claude-sonnet-4-6')
    expect(screen.getByRole('option', { name: 'Opus 4.8' })).toBeTruthy()
  })
})

describe('LocalModelsSection', () => {
  it('lists installed models with an active badge + the active selector', async () => {
    renderWithQuery(<LocalModelsSection />)
    const activeSelect = await screen.findByTestId('ollama-active-select') as HTMLSelectElement
    expect(activeSelect.value).toBe('llama3.2')
    const installed = screen.getByTestId('ollama-installed')
    expect(installed.textContent).toContain('llama3.2')
    expect(installed.textContent).toContain('mistral:7b')
    expect(installed.textContent).toContain('active')
  })

  it('annotates the catalog with disk-fit and disables Pull for a too-big model', async () => {
    renderWithQuery(<LocalModelsSection />)
    const tooBig = await screen.findByTestId('ollama-pull-phi4') as HTMLButtonElement
    expect(tooBig.disabled).toBe(true)
    // installed catalog entry → button shows Installed and is disabled
    const installedBtn = screen.getByTestId('ollama-pull-llama3.2') as HTMLButtonElement
    expect(installedBtn.disabled).toBe(true)
    expect(installedBtn.textContent).toContain('Installed')
    // a fitting, uninstalled model is pullable
    const pullable = screen.getByTestId('ollama-pull-qwen2.5:0.5b') as HTMLButtonElement
    expect(pullable.disabled).toBe(false)
  })

  it('shows live pull progress from an ollama_pull WS event', async () => {
    renderWithQuery(<LocalModelsSection />)
    const pullable = await screen.findByTestId('ollama-pull-qwen2.5:0.5b')
    fireEvent.click(pullable)
    await waitFor(() => expect(pullSpy).toHaveBeenCalledWith('qwen2.5:0.5b'))
    // Drive a progress event over the captured ws handler.
    act(() => {
      wsHandler?.({ type: 'ollama_pull', name: 'qwen2.5:0.5b', status: 'downloading', completed: 40, total: 100, percent: 40, done: false })
    })
    const progress = await screen.findByTestId('ollama-pull-progress')
    expect(progress.textContent).toContain('downloading')
    expect(progress.textContent).toContain('40%')
  })

  it('shows a Cancel button for an in-flight pull that calls api.ollama.cancelPull', async () => {
    renderWithQuery(<LocalModelsSection />)
    const pullable = await screen.findByTestId('ollama-pull-qwen2.5:0.5b')

    // No cancel affordance before a pull is started.
    expect(screen.queryByTestId('ollama-pull-cancel-qwen2.5:0.5b')).toBeNull()

    fireEvent.click(pullable)
    await waitFor(() => expect(pullSpy).toHaveBeenCalledWith('qwen2.5:0.5b'))
    // Drive a live progress event so the row is mid-flight on the WS wire.
    act(() => {
      wsHandler?.({ type: 'ollama_pull', name: 'qwen2.5:0.5b', status: 'downloading', completed: 40, total: 100, percent: 40, done: false })
    })

    const cancel = await screen.findByTestId('ollama-pull-cancel-qwen2.5:0.5b')
    fireEvent.click(cancel)
    await waitFor(() => expect(cancelPullSpy).toHaveBeenCalledWith('qwen2.5:0.5b'))
    expect(cancelPullSpy).toHaveBeenCalledTimes(1)
  })

  it('renders a cancelled pull neutrally, not as an error', async () => {
    renderWithQuery(<LocalModelsSection />)
    await screen.findByTestId('ollama-pull-qwen2.5:0.5b')
    // The route sets `error` on a cancel too; the panel must key off `status`.
    act(() => {
      wsHandler?.({ type: 'ollama_pull', name: 'qwen2.5:0.5b', status: 'cancelled', done: true, error: 'The operation was aborted' })
    })
    const progress = await screen.findByTestId('ollama-pull-progress')
    expect(progress.textContent).toContain('cancelled')
    expect(progress.textContent).not.toContain('error:')
  })

  it('renders a completed pull without a duplicate "done"', async () => {
    renderWithQuery(<LocalModelsSection />)
    await screen.findByTestId('ollama-pull-qwen2.5:0.5b')
    act(() => {
      wsHandler?.({ type: 'ollama_pull', name: 'qwen2.5:0.5b', status: 'done', done: true })
    })
    const progress = await screen.findByTestId('ollama-pull-progress')
    expect(progress.textContent).not.toContain('done · done')
  })
})
