/**
 * C4 — ModelRouter is an honest seam. The default route resolves to the claude
 * provider (whose argv/parse logic is byte-for-byte the existing behavior); an
 * ollama route resolves to a stub that throws on dispatch rather than silently
 * running claude.
 */
import { describe, it, expect } from 'vitest'
import { getProvider, claudeProvider, ollamaProvider } from '../src/providers.js'
import { buildClaudeArgs } from '../src/claude-args.js'

describe('getProvider — routed dispatch', () => {
  it('default (claude) resolves to the claude provider', () => {
    const p = getProvider('claude')
    expect(p).toBe(claudeProvider)
    expect(p.name).toBe('claude')
    expect(p.binary).toBe('claude')
  })

  it('ollama resolves to the ollama stub provider', () => {
    const p = getProvider('ollama')
    expect(p).toBe(ollamaProvider)
    expect(p.name).toBe('ollama')
  })
})

describe('claudeProvider — preserves existing behavior', () => {
  it('buildArgs is byte-for-byte identical to buildClaudeArgs', () => {
    const opts = { inWorktree: true, permissionMode: 'acceptEdits' as const }
    expect(claudeProvider.buildArgs('hi', opts)).toEqual(buildClaudeArgs('hi', opts))
  })

  it('parseLine parses a claude assistant line', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'yo' }] } })
    const ev = claudeProvider.parseLine(line, '00000000-0000-0000-0000-000000000000', 1, { tokensIn: 0, tokensOut: 0, costUsd: 0 })
    expect(ev!.text).toBe('yo')
  })
})

describe('ollamaProvider — honest not-implemented surface', () => {
  it('buildArgs throws a clear not-implemented error (no silent claude run)', () => {
    expect(() => ollamaProvider.buildArgs('hi', { inWorktree: false, permissionMode: 'default' }))
      .toThrow(/ollama provider not yet implemented/i)
  })

  it('parseLine throws the same not-implemented error', () => {
    expect(() => ollamaProvider.parseLine('{}', 'r', 1, { tokensIn: 0, tokensOut: 0, costUsd: 0 }))
      .toThrow(/ollama provider not yet implemented/i)
  })
})
