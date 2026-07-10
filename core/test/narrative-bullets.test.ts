/** P3 A1 - narrativeBullets over the injected fake transport (never a real Ollama). */
import { describe, it, expect } from 'vitest'
import { narrativeBullets, deriveNarrative } from '../src/narrative.js'
import { makeFakeTransport, textChunk } from './helpers/ollama-fakes.js'

const det = deriveNarrative({
  runId: '11111111-2222-4333-8444-555555555555', prompt: 'Add a feature', status: 'done',
  createdAt: 1, endedAt: 2, costUsd: 0, tokensIn: 0, tokensOut: 0,
  verify: { status: 'pass', reason: null, commandCount: 1 }, files: ['a.ts'],
})

describe('narrativeBullets', () => {
  it('ok path: returns clamped, labeled bullets from the model text', async () => {
    const transport = makeFakeTransport([{ chunks: [textChunk('{"decisions":["chose X"],"risks":["no tests"]}')] }])
    const b = await narrativeBullets(transport, 'test-model', det)
    expect(b).toEqual({ decisions: ['chose X'], risks: ['no tests'], generated: true, model: 'test-model' })
  })
  it('unparseable model answer -> null (route maps to bulletsState error)', async () => {
    const transport = makeFakeTransport([{ chunks: [textChunk('I cannot help with that.')] }])
    expect(await narrativeBullets(transport, 'm', det)).toBeNull()
  })
  it('transport throw propagates (route catches -> unavailable)', async () => {
    const transport = makeFakeTransport([{ error: new Error('connection refused') }])
    await expect(narrativeBullets(transport, 'm', det)).rejects.toThrow()
  })
  it('threads the abort signal to the transport (route timeout -> unavailable)', async () => {
    const transport = makeFakeTransport([{ hang: true }])
    const ctrl = new AbortController(); ctrl.abort()
    await expect(narrativeBullets(transport, 'm', det, ctrl.signal)).rejects.toThrow()
  })
})
