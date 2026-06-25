/**
 * Pure mapping from a per-run model-picker selection to the `runs.start` payload
 * extension, plus the option list the picker renders. Kept dependency-free so the
 * mapping is unit-testable in isolation (lessons.md: extract pure logic + test it).
 */
import { KNOWN_MODELS } from '@k/shared'

export type ModelChoice = 'auto' | 'ollama' | (string & {})

export const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto (router decides)' },
  ...KNOWN_MODELS.map(m => ({ value: m.id, label: m.label })),
  { value: 'ollama', label: 'Ollama (local)' },
]

/** Map a picker value to the extra runs.start opts. 'auto' → {} (preserve routing);
 *  'ollama' → { preferLocal:true }; a known model id → { model:id }. */
export function modelChoiceToOpts(choice: string): { model?: string; preferLocal?: boolean } {
  if (choice === 'auto' || choice === '') return {}
  if (choice === 'ollama') return { preferLocal: true }
  return { model: choice }
}
