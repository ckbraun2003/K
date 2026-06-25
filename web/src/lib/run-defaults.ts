/**
 * Effective run defaults surfaced in the ⌘K dispatch confirm card.
 *
 * The model is now chosen per-run in the confirm card (see lib/run-models.ts), so
 * it is no longer mirrored here. These remaining constants mirror the server-side
 * defaults the dispatch path still derives from env:
 *   - permission mode: `RUN_PERMISSION_MODE ?? 'acceptEdits'`, applied inside the
 *     run's isolated worktree (core/src/claude-args.ts)
 *   - scope: every run executes in a throwaway git worktree (core/src/supervisor.ts)
 *
 * The browser has no access to core's env, so these are the documented defaults.
 * Keep them in sync if the core defaults change.
 */
export const RUN_DEFAULTS = {
  permissionMode: 'acceptEdits',
  scope: 'Isolated git worktree',
} as const

/**
 * Muted caveats for the confirm card: the browser can't read core's env, so the
 * permission mode shown is a documented default that env vars can override. The
 * Project/Prompt rows are exact and need no caveat.
 */
export const RUN_DEFAULT_CAVEATS = {
  permissionMode: 'default · CLAUDE_MODEL / RUN_PERMISSION_MODE env overrides',
  footer:
    'Permission mode shown is a default; env vars or per-project routing can override it.',
} as const
