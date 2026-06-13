export const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const
export type PermissionMode = typeof PERMISSION_MODES[number]

export function resolvePermissionMode(env: string | undefined): PermissionMode {
  if (env && (PERMISSION_MODES as readonly string[]).includes(env)) return env as PermissionMode
  if (env) console.warn(`[supervisor] invalid RUN_PERMISSION_MODE "${env}" — using acceptEdits`)
  return 'acceptEdits'
}

/** CLI argv for a headless run. Permission mode applies ONLY inside a worktree. */
export function buildClaudeArgs(prompt: string, opts: { inWorktree: boolean; permissionMode: PermissionMode }): string[] {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose']
  if (opts.inWorktree && opts.permissionMode !== 'default') {
    args.push('--permission-mode', opts.permissionMode)
  }
  return args
}
