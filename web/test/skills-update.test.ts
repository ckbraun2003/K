import { describe, it, expect, vi, afterEach } from 'vitest'
import { api } from '../src/lib/api'

/**
 * api.skills.update — the editable-skill-prompts (Wave D1) client call. Verifies
 * it issues a PATCH to /api/skills/:id with a JSON body and parses the returned
 * Skill, and that a server-side 400/409 surfaces as a thrown error (so the editor
 * can show the message). Stubs global.fetch (node env, no jsdom).
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api.skills.update', () => {
  it('PATCHes /skills/:id with the partial body and returns the updated skill', async () => {
    const updated = { id: 's1', name: 'renamed', source: 'new prompt' }
    const fetchMock = vi.fn(async () => mockResponse({ status: 200, body: updated }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await api.skills.update('s1', { source: 'new prompt', name: 'renamed' })
    expect(res).toEqual(updated)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/skills/s1')
    expect(init.method).toBe('PATCH')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ source: 'new prompt', name: 'renamed' })
  })

  it('throws the server error message on a 409 name collision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse({ status: 409, body: { error: "a skill named 'x' already exists" } })),
    )
    await expect(api.skills.update('s1', { name: 'x' })).rejects.toThrow(/already exists/i)
  })

  it('throws on a 400 invalid-source response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse({ status: 400, body: { error: 'bad' } })),
    )
    await expect(api.skills.update('s1', { source: '' })).rejects.toThrow()
  })
})
