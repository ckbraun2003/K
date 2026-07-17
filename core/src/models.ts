/**
 * Unified available-models aggregate (Usability & Access Phase 2.6, C.1).
 *
 * Merges the static Claude KNOWN_MODELS registry with whatever Ollama models
 * are actually installed locally, so any per-agent model picker (orchestrator
 * default, sub-agent worker default, per-run override) can offer the full set
 * without hardcoding local ids. Ollama being unreachable is a normal, expected
 * condition (not every host runs it) — resolveAvailableModels() never throws;
 * it degrades to the Claude-only set and reports `localDegraded: true`.
 */
import { KNOWN_MODELS, type AvailableModel, type AvailableModelsResponse } from '@k/shared'
import { listInstalled } from './ollama-client.js'

export async function resolveAvailableModels(): Promise<AvailableModelsResponse> {
  const claude: AvailableModel[] = KNOWN_MODELS.map(m => ({
    id: m.id,
    label: m.label,
    kind: 'claude',
    contextWindow: m.contextWindow,
  }))
  let local: AvailableModel[] = []
  let localDegraded = false
  try {
    local = (await listInstalled()).map(m => ({ id: m.name, label: m.name, kind: 'local' as const }))
  } catch {
    localDegraded = true
  }
  return { models: [...claude, ...local], localDegraded }
}

/** The set of every model id present in an AvailableModelsResponse — used by
 *  route handlers to validate a requested default model without re-deriving
 *  the aggregate logic at each call site. */
export function availableModelIds(resp: AvailableModelsResponse): Set<string> {
  return new Set(resp.models.map(m => m.id))
}
