/**
 * REGRESSION — FAULT S5-004 (FIXED + promoted to gating, reboot wave F1.W4a).
 * Finding: testing/findings/S5-supervisor-providers-routing.md → row S5-004.
 *
 * Surface: core/src/claude-args.ts `buildClaudeArgs` (lines ~60-66).
 *
 * Defect: when a claudeConfig is supplied, buildClaudeArgs does
 *   args.push('--allowedTools', ...cc.allowedTools)
 *   args.push('--append-system-prompt-file', cc.appendSystemPromptFile)
 * If `allowedTools` is an EMPTY array the spread contributes nothing, so the
 * argv becomes `... --allowedTools --append-system-prompt-file <file>`. The
 * `--allowedTools` flag is immediately followed by another flag with no value
 * in between, so the claude CLI option parser consumes `--append-system-prompt-file`
 * as the VALUE of `--allowedTools` (or drops it) — silently losing K's L0+L1
 * system-prompt injection for that run.
 *
 * Reachability: today's shipped allowlists (agent-config/allowlists/*.json) are
 * all non-empty, so this is LATENT — but `synthesizeConfigDir` and buildClaudeArgs
 * have NO non-empty guard, so a hand-edited/corrupt allowlist or a future tier
 * asset with `"allowedTools": []` triggers it. allowedTools:[] is a type-valid
 * (string[]) input, so this is a pure-function robustness defect.
 *
 * EXPECTED (post-fix, e.g. omit the flag entirely when the list is empty): an
 * empty allowedTools never leaves `--allowedTools` immediately followed by
 * another `--flag` → test goes green, moves to gating.
 * ACTUAL (today): the token after `--allowedTools` is `--append-system-prompt-file`
 * → RED.
 *
 * Document-only: imports the real claude-args; does not edit core/src/**.
 */
import { describe, it, expect } from 'vitest'
import { buildClaudeArgs } from '../src/claude-args.js'

describe('S5-004 — empty allowedTools must not emit a dangling --allowedTools flag (RED)', () => {
  const args = buildClaudeArgs('do something', {
    inWorktree: false,
    permissionMode: 'default',
    claudeConfig: {
      allowedTools: [], // type-valid empty list
      mcpConfigPath: '/run/cfg/mcp.json',
      settingsPath: '/run/cfg/settings.json',
      appendSystemPromptFile: '/run/cfg/system-prompt.md',
    },
  })

  it('the token after --allowedTools is never another flag', () => {
    const i = args.indexOf('--allowedTools')
    if (i >= 0) {
      // EXPECTED-SAFE: a real tool value, not the next flag.
      // ACTUAL today: args[i+1] === '--append-system-prompt-file' → red.
      expect(args[i + 1] ?? '').not.toMatch(/^--/)
    }
    // If the fix omits --allowedTools entirely (i === -1) this passes trivially.
  })

  it('the append-system-prompt-file flag + its path stay adjacent (injection not swallowed)', () => {
    const j = args.indexOf('--append-system-prompt-file')
    expect(j).toBeGreaterThanOrEqual(0)
    // EXPECTED-SAFE: the flag is immediately followed by its path value.
    // ACTUAL today: the path is present but the flag itself is consumed as the
    // value of the empty --allowedTools, so the FLAG is not preceded by a value —
    // assert the structural expectation that it owns its own value slot.
    expect(args[j + 1]).toBe('/run/cfg/system-prompt.md')
    // The fault: --allowedTools sits directly before --append-system-prompt-file.
    const i = args.indexOf('--allowedTools')
    expect(i >= 0 && args[i + 1] === '--append-system-prompt-file').toBe(false)
  })
})
