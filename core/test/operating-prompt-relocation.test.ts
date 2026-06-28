/**
 * Base operating-prompt (L0) guard.
 *
 * `agent-config/base-operating-prompt.md` is K's committed, K-owned L0 base
 * operating prompt — the asset the per-run synthesizer (core/src/agent-config.ts)
 * injects into every managed run's config dir. This test guards that the L0 asset
 * stays present and recognizable.
 *
 * The repo-root CLAUDE.md / AGENTS.md are operator-local files (untracked) whose
 * content is the operator's own — they are intentionally NOT asserted here.
 *
 * Pure filesystem assertions — no DB, no supervisor.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '../../')

// The L0 operating-prompt framing phrase marks the base operating prompt.
const L0_MARKER = 'shared system prompt for'
const L0_PATH = path.join(REPO_ROOT, 'agent-config', 'base-operating-prompt.md')

describe('base operating prompt (L0)', () => {
  it('base-operating-prompt.md carries the L0 framing phrase', () => {
    const body = fs.readFileSync(L0_PATH, 'utf8')
    expect(body).toContain(L0_MARKER)
  })
})
