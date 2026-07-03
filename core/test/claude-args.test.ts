import { describe, it, expect } from 'vitest'
import { buildClaudeArgs, resolvePermissionMode } from '../src/claude-args.js'

const BASE_PROMPT = 'do something'
const BASE_ARGS = ['-p', BASE_PROMPT, '--output-format', 'stream-json', '--verbose']

describe('buildClaudeArgs', () => {
  it('worktree + acceptEdits appends --permission-mode acceptEdits', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: true, permissionMode: 'acceptEdits' })
    expect(args).toEqual([...BASE_ARGS, '--permission-mode', 'acceptEdits'])
  })

  it('worktree + default appends nothing', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: true, permissionMode: 'default' })
    expect(args).toEqual(BASE_ARGS)
  })

  it('worktree + plan appends --permission-mode plan', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: true, permissionMode: 'plan' })
    expect(args).toEqual([...BASE_ARGS, '--permission-mode', 'plan'])
  })

  it('worktree + bypassPermissions appends --permission-mode bypassPermissions', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: true, permissionMode: 'bypassPermissions' })
    expect(args).toEqual([...BASE_ARGS, '--permission-mode', 'bypassPermissions'])
  })

  it('non-worktree appends nothing for acceptEdits', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: false, permissionMode: 'acceptEdits' })
    expect(args).toEqual(BASE_ARGS)
  })

  it('non-worktree appends nothing for bypassPermissions', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: false, permissionMode: 'bypassPermissions' })
    expect(args).toEqual(BASE_ARGS)
  })

  it('non-worktree appends nothing for plan', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: false, permissionMode: 'plan' })
    expect(args).toEqual(BASE_ARGS)
  })

  it('non-worktree appends nothing for default', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: false, permissionMode: 'default' })
    expect(args).toEqual(BASE_ARGS)
  })

  it('model appends --model <id> after the base args', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: false, permissionMode: 'acceptEdits', model: 'claude-opus-4-8' })
    expect(args).toEqual([...BASE_ARGS, '--model', 'claude-opus-4-8'])
  })

  it('model appends --model after --permission-mode inside a worktree', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: true, permissionMode: 'acceptEdits', model: 'claude-sonnet-4-6' })
    expect(args).toEqual([...BASE_ARGS, '--permission-mode', 'acceptEdits', '--model', 'claude-sonnet-4-6'])
  })

  it('no model → argv has no --model (byte-identical to before)', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: false, permissionMode: 'acceptEdits' })
    expect(args).toEqual(BASE_ARGS)
    expect(args).not.toContain('--model')
  })

  it('base args always start with [-p, prompt, --output-format, stream-json, --verbose]', () => {
    for (const inWorktree of [true, false]) {
      for (const permissionMode of ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const) {
        const args = buildClaudeArgs(BASE_PROMPT, { inWorktree, permissionMode })
        expect(args.slice(0, 5)).toEqual(BASE_ARGS)
      }
    }
  })

  // Interactive (multi-turn HITL) argv — verified against the live CLI in the
  // A3.0 smoke: stdin-driven turns, `--replay-user-messages` echoes each turn,
  // and the prompt is NOT an argv positional (it's seeded over stdin instead).
  const INTERACTIVE_BASE = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages']

  it('interactive: prompt is NOT a positional; stream-json I/O + replay flags are set', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: false, permissionMode: 'acceptEdits', interactive: true })
    expect(args).toEqual(INTERACTIVE_BASE)
    expect(args).not.toContain(BASE_PROMPT) // the prompt never reaches argv in interactive mode
  })

  it('interactive: appends --permission-mode inside a worktree, then --model', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: true, permissionMode: 'plan', model: 'claude-sonnet-4-6', interactive: true })
    expect(args).toEqual([...INTERACTIVE_BASE, '--permission-mode', 'plan', '--model', 'claude-sonnet-4-6'])
  })

  // Wave 3 — K-owned isolated config. When `claudeConfig` is supplied (every
  // managed claude run synthesizes one) the per-run settings/MCP/allowlist/prompt
  // flags are appended AFTER the base + permission + model flags, in a fixed order.
  const CLAUDE_CONFIG = {
    allowedTools: ['Bash', 'Read', 'Task'],
    disallowedTools: [],
    mcpConfigPath: '/run/cfg/mcp.json',
    settingsPath: '/run/cfg/settings.json',
    appendSystemPromptFile: '/run/cfg/system-prompt.md',
  }

  it('claudeConfig appends settings/mcp/allowedTools/append-system-prompt-file after the base + model flags', () => {
    const args = buildClaudeArgs(BASE_PROMPT, {
      inWorktree: true, permissionMode: 'acceptEdits', model: 'claude-sonnet-4-6', claudeConfig: CLAUDE_CONFIG,
    })
    expect(args).toEqual([
      ...BASE_ARGS,
      '--permission-mode', 'acceptEdits',
      '--model', 'claude-sonnet-4-6',
      '--settings', '/run/cfg/settings.json',
      '--mcp-config', '/run/cfg/mcp.json',
      '--strict-mcp-config',
      '--allowedTools', 'Bash', 'Read', 'Task',
      '--append-system-prompt-file', '/run/cfg/system-prompt.md',
    ])
  })

  it('claudeConfig: each allowed tool is a SEPARATE argv element right after --allowedTools', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: false, permissionMode: 'default', claudeConfig: CLAUDE_CONFIG })
    const i = args.indexOf('--allowedTools')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args.slice(i, i + 4)).toEqual(['--allowedTools', 'Bash', 'Read', 'Task'])
  })

  it('without claudeConfig argv is byte-identical to BASE_ARGS (no isolation flags leak)', () => {
    const args = buildClaudeArgs(BASE_PROMPT, { inWorktree: false, permissionMode: 'acceptEdits' })
    expect(args).toEqual(BASE_ARGS)
    expect(args).not.toContain('--settings')
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--allowedTools')
    expect(args).not.toContain('--append-system-prompt-file')
  })
})

describe('resolvePermissionMode', () => {
  it('undefined returns acceptEdits', () => {
    expect(resolvePermissionMode(undefined)).toBe('acceptEdits')
  })

  it('bogus string returns acceptEdits', () => {
    expect(resolvePermissionMode('bogus')).toBe('acceptEdits')
  })

  it('bypassPermissions passes through', () => {
    expect(resolvePermissionMode('bypassPermissions')).toBe('bypassPermissions')
  })

  it('plan passes through', () => {
    expect(resolvePermissionMode('plan')).toBe('plan')
  })

  it('default passes through', () => {
    expect(resolvePermissionMode('default')).toBe('default')
  })

  it('acceptEdits passes through', () => {
    expect(resolvePermissionMode('acceptEdits')).toBe('acceptEdits')
  })
})
