/**
 * ModelRouter is an honest seam. The default route resolves to the claude
 * provider (whose argv/parse logic is byte-for-byte the existing behavior); an
 * ollama route resolves to a real ollama provider that spawns `ollama run` and
 * parses its output — never silently running or parsing as claude.
 */
import { describe, it, expect } from 'vitest'
import { getProvider, claudeProvider, ollamaProvider } from '../src/providers.js'
import { buildClaudeArgs } from '../src/claude-args.js'

const RUN_ID = '00000000-0000-0000-0000-000000000000'
const CTX = { tokensIn: 0, tokensOut: 0, costUsd: 0 }

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

  it('buildArgs forwards claudeConfig through to the isolation flags', () => {
    const claudeConfig = {
      allowedTools: ['Bash', 'Read'],
      mcpConfigPath: '/c/mcp.json',
      settingsPath: '/c/settings.json',
      appendSystemPromptFile: '/c/system-prompt.md',
    }
    const args = claudeProvider.buildArgs('hi', { inWorktree: false, permissionMode: 'acceptEdits', claudeConfig })
    expect(args).toContain('--settings')
    const i = args.indexOf('--allowedTools')
    expect(args.slice(i, i + 3)).toEqual(['--allowedTools', 'Bash', 'Read'])
  })
})

describe('ollamaProvider — local model dispatch', () => {
  it('buildArgs spawns `ollama run <model> <prompt>` with the routed model', () => {
    const args = ollamaProvider.buildArgs('do a thing', { inWorktree: true, permissionMode: 'acceptEdits', model: 'llama3.1' })
    expect(args).toEqual(['run', 'llama3.1', 'do a thing'])
  })

  it('buildArgs falls back to a default model when none is routed', () => {
    const args = ollamaProvider.buildArgs('hi', { inWorktree: false, permissionMode: 'default' })
    expect(args[0]).toBe('run')
    expect(args[1]).toBeTruthy()       // some model name
    expect(args[2]).toBe('hi')
  })

  it('buildArgs ignores claudeConfig (local runs get no isolation flags)', () => {
    const claudeConfig = {
      allowedTools: ['Bash'], mcpConfigPath: 'm', settingsPath: 's', appendSystemPromptFile: 'a',
    }
    const args = ollamaProvider.buildArgs('do a thing', { inWorktree: true, permissionMode: 'acceptEdits', model: 'llama3.1', claudeConfig })
    expect(args).toEqual(['run', 'llama3.1', 'do a thing'])
  })

  it('parseLine treats a plain-text line as assistant output', () => {
    const ev = ollamaProvider.parseLine('hello from llama', RUN_ID, 1, CTX)
    expect(ev!.type).toBe('assistant')
    expect(ev!.text).toBe('hello from llama')
  })

  it('parseLine tolerates NDJSON {response} (e.g. --format json)', () => {
    const ev = ollamaProvider.parseLine(JSON.stringify({ response: 'tok', done: false }), RUN_ID, 2, CTX)
    expect(ev!.text).toBe('tok')
  })

  it('parseLine ignores an empty line', () => {
    expect(ollamaProvider.parseLine('', RUN_ID, 3, CTX)).toBeNull()
  })
})
