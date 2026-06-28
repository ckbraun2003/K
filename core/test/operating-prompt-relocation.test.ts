/**
 * Operating-prompt relocation guard (Wave 4).
 *
 * The L0 base operating prompt no longer lives in the repo-root CLAUDE.md — it
 * was relocated to `agent-config/base-operating-prompt.md` (K-owned, injected per
 * run by core/src/agent-config.ts). The repo-root CLAUDE.md is now K's PROJECT
 * file ("how to develop K"). This test guards that the relocation is real and
 * stays real:
 *   - the L0 framing phrase lives in the base operating prompt, and
 *   - it does NOT linger in the project file (no duplication), and
 *   - the project file points readers at the relocated L0 prompt.
 *
 * Pure filesystem assertions — no DB, no supervisor.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '../../')

// The L0 operating-prompt framing phrase — its presence marks the base operating
// prompt, its absence in CLAUDE.md proves the relocation.
const L0_MARKER = 'shared system prompt for'
const L0_PATH = path.join(REPO_ROOT, 'agent-config', 'base-operating-prompt.md')
const CLAUDE_MD_PATH = path.join(REPO_ROOT, 'CLAUDE.md')

describe('operating-prompt relocation', () => {
  it('base-operating-prompt.md carries the L0 framing phrase', () => {
    const body = fs.readFileSync(L0_PATH, 'utf8')
    expect(body).toContain(L0_MARKER)
  })

  it('repo-root CLAUDE.md no longer carries the L0 framing phrase (relocation is real)', () => {
    const body = fs.readFileSync(CLAUDE_MD_PATH, 'utf8')
    expect(body).not.toContain(L0_MARKER)
  })

  it('repo-root CLAUDE.md points to the relocated L0 operating prompt', () => {
    const body = fs.readFileSync(CLAUDE_MD_PATH, 'utf8')
    expect(body).toContain('agent-config/base-operating-prompt.md')
  })
})
