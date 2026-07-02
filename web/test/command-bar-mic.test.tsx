/**
 * CommandBar mic wiring — the gate assertion: a transcript lands in cmdk-input,
 * and the mic is disabled when voice is not enabled. api + useVoiceRecorder mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Status } from '@k/shared'

// Mutable status the mocked api.status() returns (reset per test).
const statusValue: Status = {
  claude: { available: true },
  ollama: { enabled: false, reachable: false, baseUrl: '', model: '' },
  github: { authenticated: false },
  auth: { tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false },
  voice: { enabled: true, reachable: true, baseUrl: 'x', model: 'm' },
}

vi.mock('../src/lib/api', () => ({
  api: {
    runs: { list: async () => [] },
    projects: { list: async () => [] },
    status: async () => statusValue,
    voice: { transcribe: async () => ({ text: 'refactor auth' }) },
  },
}))

const startSpy = vi.fn(async () => {})
const stopSpy = vi.fn(async () => new Blob(['x'], { type: 'audio/webm' }))
vi.mock('../src/lib/useVoiceRecorder', () => ({
  useVoiceRecorder: () => ({ supported: true, recording: false, error: null, start: startSpy, stop: stopSpy }),
}))

import CommandBar from '../src/shell/CommandBar'

function renderBar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CommandBar open onClose={() => {}} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  // jsdom does not implement scrollIntoView (CommandBar calls it on selection).
  Element.prototype.scrollIntoView = vi.fn()
  startSpy.mockClear()
  stopSpy.mockClear()
  statusValue.voice = { enabled: true, reachable: true, baseUrl: 'x', model: 'm' }
})
afterEach(() => cleanup())

describe('CommandBar mic wiring', () => {
  it('a transcript lands in the command-bar input', async () => {
    renderBar()
    const mic = await screen.findByTestId('mic-button') as HTMLButtonElement
    // Wait until status loads and enables the mic (proves the enabled path).
    await waitFor(() => expect(mic.disabled).toBe(false))

    fireEvent.pointerDown(mic)
    fireEvent.pointerUp(mic)

    const input = screen.getByTestId('cmdk-input') as HTMLInputElement
    await waitFor(() => expect(input.value).toContain('refactor auth'))
  })

  it('mic is disabled when voice is not enabled', async () => {
    statusValue.voice = { enabled: false, reachable: false, baseUrl: '', model: '' }
    renderBar()
    const mic = await screen.findByTestId('mic-button') as HTMLButtonElement
    await waitFor(() => expect(mic.disabled).toBe(true))
    fireEvent.pointerDown(mic)
    fireEvent.pointerUp(mic)
    expect(startSpy).not.toHaveBeenCalled()
  })
})
