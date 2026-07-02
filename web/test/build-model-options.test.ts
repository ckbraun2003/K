import { describe, it, expect } from 'vitest'
import { buildModelOptions } from '../src/lib/run-models'

describe('buildModelOptions — dynamic Ollama surfacing', () => {
  it('with no ollama info: Auto first, static "Ollama (local)" last', () => {
    const opts = buildModelOptions()
    expect(opts[0].value).toBe('auto')
    const last = opts[opts.length - 1]
    expect(last.value).toBe('ollama')
    expect(last.label).toBe('Ollama (local)')
  })

  it('reflects the live active model in the Ollama label when reachable', () => {
    const opts = buildModelOptions({ enabled: true, reachable: true, model: 'llama3.2' })
    const last = opts[opts.length - 1]
    expect(last.value).toBe('ollama') // value unchanged → modelChoiceToOpts still maps to preferLocal
    expect(last.label).toBe('Ollama · llama3.2')
  })

  it('falls back to the static label when enabled but unreachable', () => {
    const opts = buildModelOptions({ enabled: true, reachable: false, model: 'llama3.2' })
    expect(opts[opts.length - 1].label).toBe('Ollama (local)')
  })

  it('always includes Auto + the four Claude models + Ollama', () => {
    const values = buildModelOptions().map(o => o.value)
    expect(values).toContain('claude-opus-4-8')
    expect(values).toContain('claude-sonnet-4-6')
    expect(values).toContain('claude-haiku-4-5-20251001')
    expect(values).toContain('claude-fable-5')
    expect(values).toHaveLength(6)
  })
})
