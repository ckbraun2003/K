/**
 * OllamaCatalog — curated list of recommended models + disk-fit helpers.
 *
 * CATALOG is the hand-curated list of models shown in the UI for one-click
 * pull. freeDiskBytes/fitsOnDisk answer whether a model can fit on the home
 * volume (where Ollama stores models by default).
 *
 * Uses node:fs and node:os — no new runtime deps. statfs is Node 19.6+/18.15+
 * and is not available on all platforms; freeDiskBytes falls back to
 * Number.MAX_SAFE_INTEGER so callers optimistically allow installs rather than
 * blocking them on a platform limitation.
 */

import fs from 'node:fs'
import os from 'node:os'

export type CatalogEntry = {
  name: string
  label: string
  sizeBytes: number
  blurb: string
  paramSize?: string
}

export const CATALOG: CatalogEntry[] = [
  {
    name: 'qwen2.5:0.5b',
    label: 'Qwen 2.5 0.5B',
    sizeBytes: 400 * 1024 * 1024,
    blurb: 'Ultra-compact 0.5B model — fast inference, minimal RAM.',
    paramSize: '0.5B',
  },
  {
    name: 'llama3.2:3b',
    label: 'Llama 3.2 3B',
    sizeBytes: 2 * 1024 * 1024 * 1024,
    blurb: "Meta's capable 3B model, a great balance of speed and quality.",
    paramSize: '3B',
  },
  {
    name: 'mistral:7b',
    label: 'Mistral 7B',
    sizeBytes: Math.round(4.1 * 1024 * 1024 * 1024),
    blurb: "Mistral's flagship 7B model — excellent reasoning and coding.",
    paramSize: '7B',
  },
  {
    name: 'qwen2.5-coder:7b',
    label: 'Qwen 2.5 Coder 7B',
    sizeBytes: Math.round(4.7 * 1024 * 1024 * 1024),
    blurb: 'Code-specialized 7B model from Qwen, optimized for software tasks.',
    paramSize: '7B',
  },
  {
    name: 'phi4',
    label: 'Phi-4',
    sizeBytes: Math.round(9.1 * 1024 * 1024 * 1024),
    blurb: 'Microsoft Phi-4 — high capability in a 14B-class footprint.',
  },
]

/**
 * Free bytes on the volume that contains the home directory.
 * Ollama stores models under ~/.ollama by default, so the home volume is a
 * reasonable proxy for available space. Falls back to MAX_SAFE_INTEGER on
 * platforms where statfs is unavailable or throws.
 */
export async function freeDiskBytes(): Promise<number> {
  try {
    const stats = await fs.promises.statfs(os.homedir())
    return stats.bavail * stats.bsize
  } catch {
    // statfs may not be available on all platforms; return a large sentinel so
    // fitsOnDisk returns true (optimistic) rather than blocking all installs.
    return Number.MAX_SAFE_INTEGER
  }
}

/**
 * True when sizeBytes is smaller than the available free disk space.
 * A 5 % headroom margin guards against simultaneous writes / FS overhead.
 */
export async function fitsOnDisk(sizeBytes: number): Promise<boolean> {
  const free = await freeDiskBytes()
  return sizeBytes < free * 0.95
}
