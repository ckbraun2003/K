import { describe, it, expect } from 'vitest'
import { MODEL_OPTIONS, modelChoiceToOpts } from '../src/lib/run-models'

describe('modelChoiceToOpts', () => {
  it("'auto' → {} (preserve routing)", () => {
    expect(modelChoiceToOpts('auto')).toEqual({})
  })

  it("'' → {} (treated as auto)", () => {
    expect(modelChoiceToOpts('')).toEqual({})
  })

  it("'ollama' → { preferLocal: true }", () => {
    expect(modelChoiceToOpts('ollama')).toEqual({ preferLocal: true })
  })

  it('a known model id → { model: id }', () => {
    expect(modelChoiceToOpts('claude-opus-4-8')).toEqual({ model: 'claude-opus-4-8' })
    expect(modelChoiceToOpts('claude-fable-5')).toEqual({ model: 'claude-fable-5' })
  })
})

describe('MODEL_OPTIONS', () => {
  it('lists Auto first and Ollama last', () => {
    expect(MODEL_OPTIONS[0].value).toBe('auto')
    expect(MODEL_OPTIONS[MODEL_OPTIONS.length - 1].value).toBe('ollama')
  })

  it('includes the four Claude models between Auto and Ollama', () => {
    const values = MODEL_OPTIONS.map(o => o.value)
    expect(values).toContain('claude-opus-4-8')
    expect(values).toContain('claude-sonnet-4-6')
    expect(values).toContain('claude-haiku-4-5-20251001')
    expect(values).toContain('claude-fable-5')
  })

  it('has exactly Auto + 4 Claude models + Ollama', () => {
    expect(MODEL_OPTIONS).toHaveLength(6)
  })
})
