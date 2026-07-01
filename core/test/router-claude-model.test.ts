/**
 * router.route() reads the Claude default model at CALL time, not load time (P5.5).
 *
 * The old `const CLAUDE_DEFAULT_MODEL` froze the model at module load, so a
 * runtime change couldn't take effect without a restart. route() now reads the
 * config-store getter every call. We prove: (a) a persisted change is reflected by
 * the very next route() with NO reload, and (b) the injectable dep keeps route()
 * pure for tests.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db.js'
import { route } from '../src/router.js'
import { setClaudeDefaultModel, __resetConfigCache } from '../src/config-store.js'

beforeEach(() => {
  db.prepare(`DELETE FROM app_config`).run()
  __resetConfigCache()
  delete process.env.CLAUDE_MODEL
})

describe('route() Claude model is runtime-managed (not an env-frozen const)', () => {
  it('reflects a runtime setClaudeDefaultModel on the very next route() call', () => {
    // Disabled ollama → always the claude branch; the model must be the live default.
    const before = route({ prompt: 'x' }, { enableOllama: false })
    expect(before.provider).toBe('claude')
    expect(before.model).toBe('claude-sonnet-4-6') // seeded default

    setClaudeDefaultModel('claude-opus-4-8')

    const after = route({ prompt: 'x' }, { enableOllama: false })
    expect(after.provider).toBe('claude')
    expect(after.model).toBe('claude-opus-4-8') // no restart, no reload
  })

  it('honors an injected claudeDefaultModel dep (route stays pure)', () => {
    const r = route({ prompt: 'x' }, { enableOllama: false, claudeDefaultModel: () => 'injected-model' })
    expect(r.model).toBe('injected-model')
  })
})
