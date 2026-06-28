export const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const
export type PermissionMode = typeof PERMISSION_MODES[number]

export function resolvePermissionMode(env: string | undefined): PermissionMode {
  if (env && (PERMISSION_MODES as readonly string[]).includes(env)) return env as PermissionMode
  if (env) console.warn(`[supervisor] invalid RUN_PERMISSION_MODE "${env}" — using acceptEdits`)
  return 'acceptEdits'
}

/**
 * The K-owned, per-run isolation config the supervisor threads into the argv so a
 * managed `claude` run loads ONLY K's settings/MCP/allowlist/system-prompt (host
 * ~/.claude is bypassed via CLAUDE_CONFIG_DIR). Produced by `synthesizeConfigDir`
 * (agent-config.ts); absent for ollama runs and any non-managed call.
 */
export interface ClaudeConfigArgs {
  allowedTools: string[]
  mcpConfigPath: string
  settingsPath: string
  appendSystemPromptFile: string
}

/**
 * CLI argv for a headless run. Permission mode applies ONLY inside a worktree.
 * When `opts.model` is set, `--model <id>` is appended so the routed model
 * actually reaches the CLI; with no model the argv is byte-identical to before.
 *
 * Interactive runs (`opts.interactive`) read every turn — including the first
 * prompt — from stdin as stream-json, so the prompt is NOT an argv positional;
 * `--print` stays on (required for stream-json I/O) and `--replay-user-messages`
 * echoes each operator turn back on the output stream. Non-interactive runs keep
 * the original one-shot argv (`-p <prompt>`), byte-identical to before.
 *
 * When `opts.claudeConfig` is supplied (every managed claude run synthesizes one),
 * the per-run isolation flags are appended AFTER the base/permission/model flags:
 * `--settings`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools <tool…>`
 * (each tool a separate argv element), `--append-system-prompt-file`. With no
 * `claudeConfig` the argv is byte-identical to before (host config still bypassed
 * via CLAUDE_CONFIG_DIR, but no extra flags).
 */
export function buildClaudeArgs(
  prompt: string,
  opts: {
    inWorktree: boolean
    permissionMode: PermissionMode
    model?: string
    interactive?: boolean
    claudeConfig?: ClaudeConfigArgs
  },
): string[] {
  const args = opts.interactive
    ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages']
    : ['-p', prompt, '--output-format', 'stream-json', '--verbose']
  if (opts.inWorktree && opts.permissionMode !== 'default') {
    args.push('--permission-mode', opts.permissionMode)
  }
  if (opts.model) {
    args.push('--model', opts.model)
  }
  if (opts.claudeConfig) {
    const cc = opts.claudeConfig
    args.push('--settings', cc.settingsPath)
    args.push('--mcp-config', cc.mcpConfigPath, '--strict-mcp-config')
    args.push('--allowedTools', ...cc.allowedTools)
    args.push('--append-system-prompt-file', cc.appendSystemPromptFile)
  }
  return args
}
