import { it, expect } from 'vitest'
import {
  BackgroundVariantSchema, BACKGROUND_VARIANTS, DEFAULT_BACKGROUND,
  AvailableModelSchema, AvailableModelsResponseSchema, WORKER_CEILING_TIER,
} from '../src/types'

it('background variant enum + default', () => {
  expect(BACKGROUND_VARIANTS).toEqual(['galaxy', 'aurora', 'blobs', 'solid'])
  expect(DEFAULT_BACKGROUND).toBe('galaxy')
  expect(BackgroundVariantSchema.parse('galaxy')).toBe('galaxy')
  expect(BackgroundVariantSchema.safeParse('nope').success).toBe(false)
})

it('available-model schema', () => {
  const m = AvailableModelSchema.parse({ id: 'claude-opus-4-8', label: 'Opus 4.8', kind: 'claude', contextWindow: 200000 })
  expect(m.kind).toBe('claude')
  expect(AvailableModelSchema.parse({ id: 'llama3.2:3b', label: 'Llama 3.2 3B', kind: 'local' }).contextWindow).toBeUndefined()
  const resp = AvailableModelsResponseSchema.parse({ models: [m], localDegraded: false })
  expect(resp.models).toHaveLength(1)
})

it('worker ceiling tier is orchestrator', () => {
  expect(WORKER_CEILING_TIER).toBe('orchestrator')
})
