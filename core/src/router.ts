/**
 * ModelRouter — the Architecture-C seam.
 *
 * route(task) returns { provider, model } so the supervisor never has
 * a hard dependency on "claude". Swapping in Ollama for cheap/offline
 * tasks is a config change, not a code change.
 *
 * Phase 0: always returns claude-sonnet-4-6 (the latest capable model).
 * Phase 3: read ROUTER_RULES env/config to split tasks by type/cost/privacy.
 */

export type RoutingTask = {
  prompt: string
  preferLocal?: boolean   // hint: route to Ollama if available
  maxCostUsd?: number     // hint: use cheaper model if needed
}

export type RouteResult = {
  provider: 'claude' | 'ollama'
  model: string
  baseUrl?: string  // used for ollama: http://localhost:11434
}

const CLAUDE_DEFAULT_MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6'
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
const OLLAMA_DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2'
const ENABLE_OLLAMA = process.env.ENABLE_OLLAMA === 'true'

export function route(_task: RoutingTask): RouteResult {
  // Phase 0: always claude
  // Phase 3: evaluate task hints + ROUTER_RULES + check if ollama is reachable
  if (ENABLE_OLLAMA && _task.preferLocal) {
    return { provider: 'ollama', model: OLLAMA_DEFAULT_MODEL, baseUrl: OLLAMA_BASE_URL }
  }
  return { provider: 'claude', model: CLAUDE_DEFAULT_MODEL }
}
