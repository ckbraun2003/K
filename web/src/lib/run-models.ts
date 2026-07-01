/**
 * Pure mapping from a per-run model-picker selection to the `runs.start` payload
 * extension, plus the option list the picker renders. Kept dependency-free so the
 * mapping is unit-testable in isolation (lessons.md: extract pure logic + test it).
 */
import { KNOWN_MODELS } from '@k/shared'

export type ModelChoice = 'auto' | 'ollama' | (string & {})

export type ModelOption = { value: string; label: string }

// The static option list = buildModelOptions() with no live Ollama info (its
// default branch yields the "Ollama (local)" label). Kept as a named export for
// call sites/tests that don't need the dynamic label; buildModelOptions is the
// single source so the two can never drift.
export const MODEL_OPTIONS: ModelOption[] = buildModelOptions()

/**
 * Build the picker options, surfacing the live Ollama model dynamically. When
 * Ollama is reachable the local option's LABEL reflects the active local model
 * (e.g. "Ollama · llama3.2"); otherwise the static "Ollama (local)" label is used.
 *
 * The VALUE stays `ollama` in every case, so modelChoiceToOpts still maps it to
 * `{ preferLocal:true }` — a local dispatch runs the *active* model (chosen in the
 * Settings Local-models panel), which is exactly what the backend routes to. This
 * keeps the picker honest: it reflects real local state without implying a
 * per-run model swap the dispatch path doesn't support.
 */
export function buildModelOptions(ollama?: { enabled: boolean; reachable: boolean; model: string }): ModelOption[] {
  const label = ollama?.reachable && ollama.model ? `Ollama · ${ollama.model}` : 'Ollama (local)'
  return [
    { value: 'auto', label: 'Auto (router decides)' },
    ...KNOWN_MODELS.map(m => ({ value: m.id, label: m.label })),
    { value: 'ollama', label },
  ]
}

/** Map a picker value to the extra runs.start opts. 'auto' → {} (preserve routing);
 *  'ollama' → { preferLocal:true }; a known model id → { model:id }. */
export function modelChoiceToOpts(choice: string): { model?: string; preferLocal?: boolean } {
  if (choice === 'auto' || choice === '') return {}
  if (choice === 'ollama') return { preferLocal: true }
  return { model: choice }
}
