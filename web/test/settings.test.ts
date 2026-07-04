import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Status } from '@k/shared'
import { api } from '../src/lib/api'
import {
  claudeVerdict,
  ollamaVerdict,
  voiceVerdict,
  githubVerdict,
  authVerdict,
  toneColor,
} from '../src/lib/settings-status'

// ── Pure status → tone/label mapping ────────────────────────────────────────────

describe('settings-status verdicts', () => {
  it('claude available → green with version detail', () => {
    const v = claudeVerdict({ available: true, version: '1.2.3' })
    expect(v.tone).toBe('green')
    expect(v.detail).toBe('1.2.3')
  })

  it('claude unavailable → red', () => {
    expect(claudeVerdict({ available: false }).tone).toBe('red')
  })

  it('ollama disabled → amber, unreachable → red, reachable → green', () => {
    expect(ollamaVerdict({ enabled: false, reachable: false, baseUrl: 'u', model: 'm' }).tone).toBe('amber')
    expect(ollamaVerdict({ enabled: true, reachable: false, baseUrl: 'u', model: 'm' }).tone).toBe('red')
    expect(ollamaVerdict({ enabled: true, reachable: true, baseUrl: 'u', model: 'm' }).tone).toBe('green')
  })

  it('voice disabled → amber, unreachable → red, reachable → green', () => {
    expect(voiceVerdict({ enabled: false, reachable: false, baseUrl: 'u', model: 'm' }).tone).toBe('amber')
    expect(voiceVerdict({ enabled: true, reachable: false, baseUrl: 'u', model: 'm' }).tone).toBe('red')
    expect(voiceVerdict({ enabled: true, reachable: true, baseUrl: 'u', model: 'm' })).toMatchObject({ tone: 'green', label: 'Reachable', detail: 'm @ u' })
  })

  it('github authenticated → green (with user), unauthenticated → red', () => {
    expect(githubVerdict({ authenticated: true, user: 'octocat' })).toMatchObject({ tone: 'green', detail: 'as octocat' })
    expect(githubVerdict({ authenticated: false }).tone).toBe('red')
  })

  it('auth loopback → green, network-exposed → amber', () => {
    expect(authVerdict({ tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false, credentialPosture: 'managed' }).tone).toBe('green')
    expect(authVerdict({ tokenSource: 'env', host: '0.0.0.0', loopbackOnly: false, terminalEnabled: false, credentialPosture: 'managed' }).tone).toBe('amber')
  })

  it('auth surfaces the host-credential fallback posture in the detail (tone unchanged)', () => {
    const managed = authVerdict({ tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false, credentialPosture: 'managed' })
    expect(managed.tone).toBe('green')
    expect(managed.detail).not.toMatch(/creds:/)

    const fallback = authVerdict({ tokenSource: 'generated', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false, credentialPosture: 'host-fallback' })
    expect(fallback.tone).toBe('green') // tone stays host-based
    expect(fallback.detail).toMatch(/host fallback/)

    const disabled = authVerdict({ tokenSource: 'env', host: '127.0.0.1', loopbackOnly: true, terminalEnabled: false, credentialPosture: 'disabled' })
    expect(disabled.detail).toMatch(/fallback off/)
  })

  it('toneColor maps to the midnight-glass palette vars only', () => {
    expect(toneColor('green')).toBe('var(--green)')
    expect(toneColor('amber')).toBe('var(--amber)')
    expect(toneColor('red')).toBe('var(--red)')
  })
})

// ── api call shapes ─────────────────────────────────────────────────────────────

function mockResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: '',
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response
}

afterEach(() => vi.unstubAllGlobals())

describe('api.status / api.systemPrompt call shapes', () => {
  it('api.status() GETs /api/status', async () => {
    const fetchMock = vi.fn(async () => mockResponse({} as Status))
    vi.stubGlobal('fetch', fetchMock)
    await api.status()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/status')
    // GET → no explicit method (init undefined or method unset)
    expect((init as RequestInit | undefined)?.method ?? 'GET').toBe('GET')
  })

  it('api.voice.transcribe() POSTs the Blob to /api/transcribe with the blob mime as Content-Type', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ text: 'refactor auth' }))
    vi.stubGlobal('fetch', fetchMock)
    const blob = new Blob(['bytes'], { type: 'audio/webm' })
    const result = await api.voice.transcribe(blob)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/transcribe')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).headers).toMatchObject({ 'Content-Type': 'audio/webm' })
    expect((init as RequestInit).body).toBe(blob)
    expect(result).toEqual({ text: 'refactor auth' })
  })

  it('api.voice.transcribe() falls back to application/octet-stream for an untyped Blob', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ text: '' }))
    vi.stubGlobal('fetch', fetchMock)
    await api.voice.transcribe(new Blob(['bytes'])) // no type
    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/octet-stream' })
  })

  it('api.systemPrompt.get() GETs /api/system-prompt', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ md: 'x' }))
    vi.stubGlobal('fetch', fetchMock)
    await api.systemPrompt.get()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/system-prompt')
  })

  it('api.systemPrompt.save() PUTs JSON { md } to /api/system-prompt', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ savedAt: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    await api.systemPrompt.save('# new prompt')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/system-prompt')
    expect((init as RequestInit).method).toBe('PUT')
    expect((init as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ md: '# new prompt' })
  })
})
