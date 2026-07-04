/**
 * Wave 2 (F-021) — the shared HTTP error-envelope helpers (routes/http-errors.ts).
 *
 * Pure unit test: drives sendError / sendZodError / describePatchRejection / unrecognizedKeys
 * against a minimal fake FastifyReply that records the status + body. No app, no DB.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type { FastifyReply } from 'fastify'
import {
  sendError,
  sendZodError,
  unrecognizedKeys,
  describePatchRejection,
} from '../src/routes/http-errors.js'

function fakeReply() {
  const rec: { status?: number; body?: unknown } = {}
  const reply = {
    status(s: number) {
      rec.status = s
      return reply
    },
    send(b: unknown) {
      rec.body = b
      return reply
    },
  }
  return { reply: reply as unknown as FastifyReply, rec }
}

describe('sendError', () => {
  it('emits { error } with the given status and NO details key when omitted', () => {
    const { reply, rec } = fakeReply()
    sendError(reply, 404, 'not found')
    expect(rec.status).toBe(404)
    expect(rec.body).toEqual({ error: 'not found' })
    expect('details' in (rec.body as object)).toBe(false)
  })

  it('includes details when provided', () => {
    const { reply, rec } = fakeReply()
    sendError(reply, 400, 'bad', { field: 'x' })
    expect(rec.body).toEqual({ error: 'bad', details: { field: 'x' } })
  })
})

describe('sendZodError', () => {
  it('is a 400 with a string message + the flatten() in details', () => {
    const schema = z.object({ leadProfileId: z.string().min(1) }).strict()
    const parsed = schema.safeParse({})
    expect(parsed.success).toBe(false)
    const { reply, rec } = fakeReply()
    if (!parsed.success) sendZodError(reply, parsed.error)
    expect(rec.status).toBe(400)
    const body = rec.body as { error: string; details: { fieldErrors: Record<string, unknown> } }
    expect(typeof body.error).toBe('string')
    expect(body.error).toBe('validation failed')
    // details names the offending field so a caller can self-correct.
    expect(body.details.fieldErrors).toHaveProperty('leadProfileId')
  })
})

describe('unrecognizedKeys / describePatchRejection', () => {
  const strict = z
    .object({ skills: z.array(z.string()).optional() })
    .strict()

  it('names an immutable field with a "why" clause', () => {
    const parsed = strict.safeParse({ tier: 'chief' })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(unrecognizedKeys(parsed.error)).toEqual(['tier'])
      const msg = describePatchRejection(parsed.error, ['tier', 'charter'])
      expect(msg).toMatch(/tier/)
      expect(msg).toMatch(/immutable/)
    }
  })

  it('names multiple immutable fields with a plural verb', () => {
    const parsed = strict.safeParse({ tier: 'chief', charter: 'secretary' })
    if (!parsed.success) {
      const msg = describePatchRejection(parsed.error, ['tier', 'charter'])
      expect(msg).toMatch(/tier and charter are immutable/)
    }
  })

  it('names a plain unknown field when it is not in the immutable set', () => {
    const parsed = strict.safeParse({ bogus: 1 })
    if (!parsed.success) {
      expect(describePatchRejection(parsed.error, ['tier', 'charter'])).toBe('unknown field(s): bogus')
    }
  })

  it('falls back to "invalid patch" for a non-key validation error', () => {
    const parsed = strict.safeParse({ skills: 'not-an-array' })
    if (!parsed.success) {
      expect(unrecognizedKeys(parsed.error)).toEqual([])
      expect(describePatchRejection(parsed.error, ['tier', 'charter'])).toBe('invalid patch')
    }
  })
})
