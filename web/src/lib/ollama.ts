/**
 * Ollama model-management shapes + pure helpers (P5.5).
 *
 * Types mirror the core routes/ollama.ts responses. formatBytes + pullStateFromEvent
 * are dependency-free so they're unit-testable in isolation (lessons.md: extract
 * pure logic + test it). pullStateFromEvent pins the `ollama_pull` WS message
 * shape from the consumer side.
 */
import type { WsMessage } from '@k/shared'

export interface InstalledModel {
  name: string
  sizeBytes?: number
  digest?: string
  modifiedAt?: string
}

/** GET /api/ollama/models — installed list + the active model name. `degraded`
 *  is set (installed:[]) when Ollama is unreachable (mirrors the router posture). */
export interface OllamaModelsResponse {
  installed: InstalledModel[]
  active: string
  degraded?: boolean
}

/** One curated-catalog row annotated with install + disk-fit status. */
export interface CatalogItem {
  name: string
  label: string
  sizeBytes: number
  blurb: string
  paramSize?: string
  installed: boolean
  fitsOnDisk: boolean
}

/** GET /api/ollama/catalog — the curated catalog + free disk space. */
export interface OllamaCatalogResponse {
  items: CatalogItem[]
  freeDiskBytes: number
}

/** Human-readable byte size. Unknown / invalid inputs degrade to an em-dash so a
 *  size-less model row never renders "NaN GB". */
export function formatBytes(n?: number | null): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  const GB = 1024 ** 3
  const MB = 1024 ** 2
  const KB = 1024
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`
  if (n >= MB) return `${Math.round(n / MB)} MB`
  if (n >= KB) return `${Math.round(n / KB)} KB`
  return `${n} B`
}

type OllamaPullMessage = Extract<WsMessage, { type: 'ollama_pull' }>

/** Live pull state for one model, driven by `ollama_pull` WS messages. */
export interface PullState {
  status: string
  percent?: number
  completed?: number
  total?: number
  done: boolean
  error?: string
}

/** Normalize an `ollama_pull` WS event into a PullState (drops the discriminant +
 *  name; the caller keys by name). Pins the wire shape the panel consumes. */
export function pullStateFromEvent(msg: OllamaPullMessage): PullState {
  return {
    status: msg.status,
    percent: msg.percent,
    completed: msg.completed,
    total: msg.total,
    done: msg.done,
    error: msg.error,
  }
}
