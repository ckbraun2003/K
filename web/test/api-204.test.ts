import { describe, it, expect, vi, afterEach } from 'vitest'
import { api } from '../src/lib/api'

/**
 * Regression: req() must not call res.json() on an empty 204 body. A successful
 * DELETE /api/skills/:id returns 204 No Content; calling res.json() there throws
 * "Unexpected end of JSON input", landing the mutation in onError even though the
 * server deleted the row. These tests stub global.fetch (node env, no jsdom).
 */

function mockResponse(opts: { status: number; body?: unknown; contentLength?: string }): Response {
  const headers = new Headers()
  if (opts.contentLength !== undefined) headers.set('content-length', opts.contentLength)
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    statusText: '',
    headers,
    json: async () => {
      if (opts.body === undefined) throw new SyntaxError('Unexpected end of JSON input')
      return opts.body
    },
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('req() empty-body handling', () => {
  it('resolves (does not throw) on a 204 with an empty body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ status: 204 })))
    await expect(api.skills.delete('skill-1')).resolves.toBeUndefined()
  })

  it('resolves on a 200 with content-length: 0 and no body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ status: 200, contentLength: '0' })))
    await expect(api.skills.delete('skill-2')).resolves.toBeUndefined()
  })

  it('still parses a normal 200 JSON response', async () => {
    const skills = [{ id: 's1', name: 'demo' }]
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ status: 200, body: skills })))
    await expect(api.skills.list()).resolves.toEqual(skills)
  })

  it('throws on a non-OK response with an error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ status: 404, body: { error: 'not found' } })))
    await expect(api.skills.delete('missing')).rejects.toThrow('not found')
  })
})
