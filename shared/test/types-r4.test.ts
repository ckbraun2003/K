import { it, expect } from 'vitest'
import {
  BackgroundSettingsSchema,
  PrimaryColorSettingsSchema, DEFAULT_PRIMARY_COLOR_SETTINGS,
  SecondaryColorSettingsSchema, DEFAULT_SECONDARY_COLOR_SETTINGS,
  InboxItemSchema,
} from '../src/types'

it('background settings: solidColor accepts a 6-digit hex, null, or omission (defaults to null)', () => {
  expect(BackgroundSettingsSchema.parse({
    kind: 'solid', preset: null, imageVersion: null, solidColor: '#223344',
  })).toEqual({ kind: 'solid', preset: null, imageVersion: null, solidColor: '#223344' })

  expect(BackgroundSettingsSchema.parse({
    kind: 'solid', preset: null, imageVersion: null, solidColor: null,
  })).toEqual({ kind: 'solid', preset: null, imageVersion: null, solidColor: null })

  // omitted entirely — defaults to null
  expect(BackgroundSettingsSchema.parse({
    kind: 'solid', preset: null, imageVersion: null,
  })).toEqual({ kind: 'solid', preset: null, imageVersion: null, solidColor: null })
})

it('primary/secondary color settings: accept 6-digit hex or null, reject non-hex, default to null', () => {
  expect(PrimaryColorSettingsSchema.parse({ color: '#aabbcc' })).toEqual({ color: '#aabbcc' })
  expect(PrimaryColorSettingsSchema.parse({ color: null })).toEqual({ color: null })
  expect(PrimaryColorSettingsSchema.safeParse({ color: 'red' }).success).toBe(false)
  expect(DEFAULT_PRIMARY_COLOR_SETTINGS.color).toBeNull()

  expect(SecondaryColorSettingsSchema.parse({ color: '#aabbcc' })).toEqual({ color: '#aabbcc' })
  expect(SecondaryColorSettingsSchema.parse({ color: null })).toEqual({ color: null })
  expect(SecondaryColorSettingsSchema.safeParse({ color: 'red' }).success).toBe(false)
  expect(DEFAULT_SECONDARY_COLOR_SETTINGS.color).toBeNull()
})

it('inbox input_needed item: optional question + inputKind fields', () => {
  const base = {
    kind: 'input_needed' as const, id: 'input_needed:r1', ts: 1, projectId: null, projectName: null,
    title: 'Run r1', runId: 'r1', model: 'claude-opus-4-8',
  }
  // still parses without the new optional fields (backward compatible with existing producers)
  expect(InboxItemSchema.parse(base)).toEqual(base)

  // parses with the new optional fields populated
  const withQuestion = { ...base, question: 'Which branch should I use?', inputKind: 'question' as const }
  expect(InboxItemSchema.parse(withQuestion)).toEqual(withQuestion)

  expect(InboxItemSchema.safeParse({ ...base, inputKind: 'not-a-kind' }).success).toBe(false)
})
