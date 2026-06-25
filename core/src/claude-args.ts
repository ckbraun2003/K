export const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const
export type PermissionMode = typeof PERMISSION_MODES[number]

export function resolvePermissionMode(env: string | undefined): PermissionMode {
  if (env && (PERMISSION_MODES as readonly string[]).includes(env)) return env as PermissionMode
  if (env) console.warn(`[supervisor] invalid RUN_PERMISSION_MODE "${env}" — using acceptEdits`)
  return 'acceptEdits'
}

/**
 * CLI argv for a headless run. Permission mode applies ONLY inside a worktree.
 * When `opts.model` is set, `--model <id>` is appended so the routed model
 * actually reaches the CLI; with no model the argv is byte-identical to before.
 */
export function buildClaudeArgs(prompt: string, opts: { inWorktree: boolean; permissionMode: PermissionMode; model?: string }): string[] {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose']
  if (opts.inWorktree && opts.permissionMode !== 'default') {
    args.push('--permission-mode', opts.permissionMode)
  }
  if (opts.model) {
    args.push('--model', opts.model)
  }
  return args
}
