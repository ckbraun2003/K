/**
 * VoiceSection — read-only ENABLE_VOICE posture from the shared ['status'] query.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Status } from '@k/shared'

const statusSpy = vi.fn<[], Promise<Status>>()
vi.mock('../src/lib/api', () => ({
  api: { status: () => statusSpy() },
}))

import { VoiceSection } from '../src/pages/SettingsVoice'

function mkStatus(voice: Status['voice']): Status {
  return {
    claude: { available: true },
    ollama: { enabled: false, reachable: false, baseUrl: '', model: '' },
    github: { authenticated: false },
    auth: { tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false, credentialPosture: 'managed' },
    voice,
  }
}

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => statusSpy.mockReset())
afterEach(() => cleanup())

describe('VoiceSection', () => {
  it('enabled + reachable → green "Reachable"', async () => {
    statusSpy.mockResolvedValue(mkStatus({ enabled: true, reachable: true, baseUrl: 'http://127.0.0.1:9000', model: 'whisper-1' }))
    renderWithQuery(<VoiceSection />)
    const label = await screen.findByTestId('voice-status-label')
    expect(label.textContent).toBe('Reachable')
  })

  it('enabled + unreachable → red "Unreachable"', async () => {
    statusSpy.mockResolvedValue(mkStatus({ enabled: true, reachable: false, baseUrl: 'http://127.0.0.1:9000', model: 'whisper-1' }))
    renderWithQuery(<VoiceSection />)
    const label = await screen.findByTestId('voice-status-label')
    expect(label.textContent).toBe('Unreachable')
  })

  it('disabled → amber "Disabled"', async () => {
    statusSpy.mockResolvedValue(mkStatus({ enabled: false, reachable: false, baseUrl: '', model: '' }))
    renderWithQuery(<VoiceSection />)
    const label = await screen.findByTestId('voice-status-label')
    expect(label.textContent).toBe('Disabled')
  })
})
