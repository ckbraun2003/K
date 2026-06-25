/**
 * Effective run defaults surfaced in the ⌘K dispatch confirm card.
 *
 * ⌘K dispatch (`api.runs.start`) sends only `prompt`/`cwd`/`projectId`; the core
 * supervisor derives the rest from env. These constants mirror those server-side
 * defaults so the preview card is honest about what will actually run:
 *   - model: ModelRouter's `CLAUDE_MODEL ?? 'claude-sonnet-4-6'` (core/src/router.ts)
 *   - permission mode: `RUN_PERMISSION_MODE ?? 'acceptEdits'`, applied inside the
 *     run's isolated worktree (core/src/claude-args.ts)
 *   - scope: every run executes in a throwaway git worktree (core/src/supervisor.ts)
 *
 * The browser has no access to core's env, so these are the documented defaults.
 * Keep them in sync if the core defaults change.
 */
export const RUN_DEFAULTS = {
  model: 'claude-sonnet-4-6',
  permissionMode: 'acceptEdits',
  scope: 'Isolated git worktree',
} as const

/**
 * Muted caveats for the confirm card: the browser can't read core's env, so
 * model/permission shown are documented defaults that env vars or per-project
 * routing can override. The Project/Prompt rows are exact and need no caveat.
 */
export const RUN_DEFAULT_CAVEATS = {
  model: 'default · routing may select another',
  permissionMode: 'default · CLAUDE_MODEL / RUN_PERMISSION_MODE env overrides',
  footer:
    'Model and permission shown are defaults; env vars or per-project routing can override them.',
} as const
