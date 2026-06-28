/**
 * Base operating-prompt (L0) doc-lint.
 *
 * `agent-config/base-operating-prompt.md` is K's committed, K-owned L0 base
 * operating prompt — the asset the per-run synthesizer (core/src/agent-config.ts)
 * injects into every managed run's config dir. This test guards that the L0:
 *   - stays present and recognizable (the new "agent run by K" framing),
 *   - drives storage through TOOLS, not the home-dev `tasks/*.md` file trackers,
 *   - names the subagent-spawn tool by its CLI id `Task`, never `Agent`,
 *   - stays SMALL (the methodology lives in mounted skills, not the base prompt).
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
const L0_PATH = path.join(REPO_ROOT, 'agent-config', 'base-operating-prompt.md')

describe('base operating prompt (L0)', () => {
  const body = fs.readFileSync(L0_PATH, 'utf8')

  it('carries the L0 framing phrase', () => {
    expect(body).toContain('You are an agent run by')
  })

  it('drives storage through tools, not the home-dev tasks/*.md trackers', () => {
    // It MAY name tasks/*.md to forbid them, but must not carry the old
    // home-dev "Conventions & Locations" tracker block or host plan paths.
    expect(body).toMatch(/work-item/i)
    expect(body).toMatch(/memory tool/i)
    expect(body).not.toContain('Conventions & Locations')
    expect(body).not.toContain('~/.claude/plans')
  })

  it('names the subagent-spawn tool by its CLI id `Task`, not `Agent`', () => {
    expect(body).toContain('`Task`')
    expect(body).not.toContain('`Agent`')
  })

  it('stays small (methodology lives in mounted skills, not the base prompt)', () => {
    const nonEmptyLines = body.split('\n').filter(l => l.trim().length > 0).length
    expect(nonEmptyLines).toBeLessThan(45)
  })
})
