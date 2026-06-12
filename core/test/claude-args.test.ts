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

  it('base args always start with [-p, prompt, --output-format, stream-json, --verbose]', () => {
    for (const inWorktree of [true, false]) {
      for (const permissionMode of ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const) {
        const args = buildClaudeArgs(BASE_PROMPT, { inWorktree, permissionMode })
        expect(args.slice(0, 5)).toEqual(BASE_ARGS)
      }
    }
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
