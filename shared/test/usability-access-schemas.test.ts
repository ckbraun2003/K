import { it, expect } from 'vitest'
import {
  GRADIENT_PRESETS, BACKGROUND_KINDS, BackgroundSettingsSchema, DEFAULT_BACKGROUND_SETTINGS,
  BackgroundImageUploadSchema,
  AvailableModelSchema, AvailableModelsResponseSchema, WORKER_CEILING_TIER,
} from '../src/types'

it('background settings model: kinds/presets + default + schema validation', () => {
  expect(BACKGROUND_KINDS).toEqual(['solid', 'gradient', 'image'])
  expect(GRADIENT_PRESETS).toEqual(['aurora', 'dusk', 'ocean', 'ember'])
  expect(DEFAULT_BACKGROUND_SETTINGS).toEqual({ kind: 'solid', preset: null, imageVersion: null })
  expect(BackgroundSettingsSchema.parse({ kind: 'gradient', preset: 'aurora', imageVersion: null })).toEqual({
    kind: 'gradient', preset: 'aurora', imageVersion: null,
  })
  expect(BackgroundSettingsSchema.safeParse({ kind: 'nope', preset: null, imageVersion: null }).success).toBe(false)
})

it('background image upload schema: accepts png/jpeg/webp data URLs, rejects others', () => {
  expect(BackgroundImageUploadSchema.safeParse({ dataUrl: 'data:image/png;base64,QQ==' }).success).toBe(true)
  expect(BackgroundImageUploadSchema.safeParse({ dataUrl: 'data:image/gif;base64,QQ==' }).success).toBe(false)
  expect(BackgroundImageUploadSchema.safeParse({ dataUrl: 'not-a-data-url' }).success).toBe(false)
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
