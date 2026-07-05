import { describe, it, expect, vi, afterEach } from 'vitest'
import { api } from '../src/lib/api'

/**
 * api.capabilities / api.skillCreator — the capability-catalog + skill-creator
 * client namespaces (wave C1). Verifies URL/method/body per endpoint, that
 * catalog ids (qualified keys containing ':' and '@') are URL-encoded in path
 * params, and that server errors surface as thrown messages (the trust-gate 400
 * and the save 409 ride req()'s error path). Stubs global.fetch (node env).
 */

function mockResponse(opts: { status: number; body?: unknown }): Response {
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    statusText: '',
    headers: new Headers(),
    json: async () => {
      if (opts.body === undefined) throw new SyntaxError('Unexpected end of JSON input')
      return opts.body
    },
  } as unknown as Response
}

function stubFetch(opts: { status: number; body?: unknown }) {
  const fetchMock = vi.fn(async () => mockResponse(opts))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function call(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit | undefined] {
  return fetchMock.mock.calls[0] as [string, RequestInit | undefined]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api.capabilities — reads', () => {
  it('GET /capabilities/skills', async () => {
    const body = { skills: [], scannedAt: null, warnings: [] }
    const fetchMock = stubFetch({ status: 200, body })
    await expect(api.capabilities.skills()).resolves.toEqual(body)
    const [url, init] = call(fetchMock)
    expect(url).toBe('/api/capabilities/skills')
    expect(init?.method).toBeUndefined()
  })

  it('GET /capabilities/mcp', async () => {
    const body = { servers: [], scannedAt: 1, warnings: [] }
    const fetchMock = stubFetch({ status: 200, body })
    await expect(api.capabilities.mcp()).resolves.toEqual(body)
    expect(call(fetchMock)[0]).toBe('/api/capabilities/mcp')
  })

  it('GET /capabilities/hooks', async () => {
    const body = { hooks: [], scannedAt: 1, warnings: [] }
    const fetchMock = stubFetch({ status: 200, body })
    await expect(api.capabilities.hooks()).resolves.toEqual(body)
    expect(call(fetchMock)[0]).toBe('/api/capabilities/hooks')
  })

  it('GET /capabilities/summary', async () => {
    const fetchMock = stubFetch({ status: 200, body: { totalEstTokens: 0 } })
    await api.capabilities.summary()
    expect(call(fetchMock)[0]).toBe('/api/capabilities/summary')
  })

  it('POST /capabilities/rescan', async () => {
    const fetchMock = stubFetch({ status: 200, body: { scannedAt: 5 } })
    await api.capabilities.rescan()
    const [url, init] = call(fetchMock)
    expect(url).toBe('/api/capabilities/rescan')
    expect(init?.method).toBe('POST')
  })
})

describe('api.capabilities — id URL-encoding', () => {
  // Qualified keys are the wire ids and contain ':' and '@' (D-069 grammar).
  const pluginId = 'plugin:superpowers@obra:brainstorming'
  const encoded = encodeURIComponent(pluginId)

  it('toggleSkill PATCHes the ENCODED id with {enabled}', async () => {
    const fetchMock = stubFetch({ status: 200, body: { id: pluginId, enabled: true } })
    await api.capabilities.toggleSkill(pluginId, true)
    const [url, init] = call(fetchMock)
    expect(url).toBe(`/api/capabilities/skills/${encoded}`)
    expect(url).not.toContain('@')
    expect(url.split('/api/capabilities/skills/')[1]).not.toContain(':')
    expect(init?.method).toBe('PATCH')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init?.body as string)).toEqual({ enabled: true })
  })

  it('toggleMcp PATCHes the ENCODED id with {enabled}', async () => {
    const id = 'user:context7'
    const fetchMock = stubFetch({ status: 200, body: { id, enabled: false } })
    await api.capabilities.toggleMcp(id, false)
    const [url, init] = call(fetchMock)
    expect(url).toBe(`/api/capabilities/mcp/${encodeURIComponent(id)}`)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ enabled: false })
  })

  it('trustMcp POSTs /trust with the enable flag when given', async () => {
    const id = 'user:context7'
    const fetchMock = stubFetch({ status: 200, body: { id, trusted: true, enabled: true } })
    await api.capabilities.trustMcp(id, { enable: true })
    const [url, init] = call(fetchMock)
    expect(url).toBe(`/api/capabilities/mcp/${encodeURIComponent(id)}/trust`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ enable: true })
  })

  it('trustMcp defaults to an empty JSON body (trust WITHOUT enable)', async () => {
    const fetchMock = stubFetch({ status: 200, body: { trusted: true } })
    await api.capabilities.trustMcp('user:context7')
    expect(JSON.parse(call(fetchMock)[1]?.body as string)).toEqual({})
  })

  it('probeMcp POSTs /probe with the ENCODED id', async () => {
    const fetchMock = stubFetch({ status: 200, body: { toolCount: 3 } })
    await api.capabilities.probeMcp(pluginId)
    const [url, init] = call(fetchMock)
    expect(url).toBe(`/api/capabilities/mcp/${encoded}/probe`)
    expect(init?.method).toBe('POST')
  })
})

describe('api.capabilities — error surfacing', () => {
  it('surfaces the trust-gate 400 message on toggleMcp', async () => {
    stubFetch({ status: 400, body: { error: 'server is not trusted — review & trust it first' } })
    await expect(api.capabilities.toggleMcp('user:context7', true)).rejects.toThrow(
      'server is not trusted — review & trust it first',
    )
  })

  it('falls back to status text shape when the error body is unreadable', async () => {
    stubFetch({ status: 500 })
    await expect(api.capabilities.rescan()).rejects.toThrow('500')
  })
})

describe('api.skillCreator', () => {
  it('list GETs /skill-creator/drafts', async () => {
    const fetchMock = stubFetch({ status: 200, body: [] })
    await expect(api.skillCreator.list()).resolves.toEqual([])
    expect(call(fetchMock)[0]).toBe('/api/skill-creator/drafts')
  })

  it('get GETs the draft by id', async () => {
    const fetchMock = stubFetch({ status: 200, body: { id: 'd1' } })
    await api.skillCreator.get('d1')
    expect(call(fetchMock)[0]).toBe('/api/skill-creator/drafts/d1')
  })

  it('create POSTs {brief, nameHint}', async () => {
    const fetchMock = stubFetch({ status: 200, body: { id: 'd1', status: 'drafting' } })
    await api.skillCreator.create({ brief: 'summarize PRs', nameHint: 'pr-summarizer' })
    const [url, init] = call(fetchMock)
    expect(url).toBe('/api/skill-creator/drafts')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ brief: 'summarize PRs', nameHint: 'pr-summarizer' })
  })

  it('update PATCHes the edited skillMd', async () => {
    const fetchMock = stubFetch({ status: 200, body: { id: 'd1' } })
    await api.skillCreator.update('d1', { skillMd: '---\nname: x\n---\nbody' })
    const [url, init] = call(fetchMock)
    expect(url).toBe('/api/skill-creator/drafts/d1')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ skillMd: '---\nname: x\n---\nbody' })
  })

  it('refine POSTs {feedback}', async () => {
    const fetchMock = stubFetch({ status: 200, body: { id: 'd1', revision: 1 } })
    await api.skillCreator.refine('d1', 'tighten the trigger description')
    const [url, init] = call(fetchMock)
    expect(url).toBe('/api/skill-creator/drafts/d1/refine')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ feedback: 'tighten the trigger description' })
  })

  it('evaluate POSTs and returns {evalId, runId} (202)', async () => {
    const fetchMock = stubFetch({ status: 202, body: { evalId: 'e1', runId: 'r1' } })
    await expect(api.skillCreator.evaluate('d1')).resolves.toEqual({ evalId: 'e1', runId: 'r1' })
    const [url, init] = call(fetchMock)
    expect(url).toBe('/api/skill-creator/drafts/d1/evaluate')
    expect(init?.method).toBe('POST')
  })

  it('evals GETs the draft eval history', async () => {
    const fetchMock = stubFetch({ status: 200, body: [] })
    await api.skillCreator.evals('d1')
    expect(call(fetchMock)[0]).toBe('/api/skill-creator/drafts/d1/evals')
  })

  it('save POSTs {name} and returns the registered skill (201)', async () => {
    const fetchMock = stubFetch({ status: 201, body: { skill: { id: 'pr-summarizer' } } })
    await expect(api.skillCreator.save('d1', 'pr-summarizer')).resolves.toEqual({
      skill: { id: 'pr-summarizer' },
    })
    const [url, init] = call(fetchMock)
    expect(url).toBe('/api/skill-creator/drafts/d1/save')
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'pr-summarizer' })
  })

  it('save surfaces the 409 collision message', async () => {
    stubFetch({ status: 409, body: { error: 'a skill named "pr-summarizer" already exists' } })
    await expect(api.skillCreator.save('d1', 'pr-summarizer')).rejects.toThrow(
      'a skill named "pr-summarizer" already exists',
    )
  })

  it('delete DELETEs the draft and resolves on 204', async () => {
    const headers = new Headers()
    const fetchMock = vi.fn(async () =>
      ({ ok: true, status: 204, statusText: '', headers, json: async () => { throw new SyntaxError('empty') } }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.skillCreator.delete('d1')).resolves.toBeUndefined()
    const [url, init] = call(fetchMock)
    expect(url).toBe('/api/skill-creator/drafts/d1')
    expect(init?.method).toBe('DELETE')
  })
})
