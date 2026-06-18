# Lessons Learned

Reusable rules captured after corrections, per CLAUDE.md §3 (Self-Improvement Loop).
Each entry: **Pattern** (the mistake) → **Rule** (how to prevent it). Review relevant
entries at session start before touching the same area.

## Phase G / Phase 3 (2026-06-18)

- **Worktree selective-merge discipline** — **Pattern:** agent worktrees always start
  from `main`, not the active feature branch, so naively copying agent output back loses
  the changes already accumulated on the feature branch. **Rule:** when merging worktree
  output, diff each shared/accumulation file (`api.ts`, `Shell.tsx`, `db.ts`, `types.ts`,
  routes) and copy only genuinely-new files directly; apply additive changes to
  accumulation files by hand; verify with `git diff <agent-commit> <landed-commit>`
  (should be empty).

- **Overlay modals must use `fixed`, not `absolute`** — **Pattern:** a modal with
  `absolute inset-0` was clipped by an `overflow-hidden` ancestor (Shell `<main>`).
  **Rule:** full-screen overlays/modals use `fixed inset-0 z-50` so they escape ancestor
  clipping.

- **Empty-string is falsy — use `null` sentinels for "unset"** — **Pattern:**
  `editMd || sectionMd` silently dropped an intentionally-empty edit because `''` is
  falsy. **Rule:** distinguish "unset" from "empty" with a `null` sentinel and `??`, never
  `||`.

- **Verify CLI flags against the real tool, not mocks** — **Pattern:** `createPR` called
  `gh pr create --json`, a flag `gh pr create` does not support; mocked tests passed
  falsely. **Rule:** when wrapping an external CLI, confirm the real binary's actual
  flags/output; don't let a mock invent a contract the real tool never produces.

- **No blocking I/O in async handlers** — **Pattern:** `fs.readFileSync` inside a Fastify
  handler blocks the event loop. **Rule:** use `await readFile` from `fs/promises` in
  async request handlers.

- **Navigate to the right route** — **Pattern:** fleet-graph nodes navigated to `verify`
  instead of the project workspace. **Rule:** confirm the navigation target matches the
  intended destination before shipping.

- **Validate external/user input at the boundary** — **Pattern:** skill cron expressions
  and trigger-type/field consistency weren't validated at creation, so invalid skills were
  stored silently and never fired. **Rule:** validate at the API boundary and reject with
  400; don't defer to silent runtime filtering.

- **Run a code-review agent for every wave** — **Pattern:** wave 3-1 skipped review and
  shipped minor issues a review would have caught. **Rule:** implement → review → gates →
  commit for every wave, no exceptions.

- **Windows case-insensitive gitignore** — **Pattern:** a `claude.md` ignore entry also
  matched the canonical `CLAUDE.md` on NTFS, making it un-committable. **Rule:** be precise
  with gitignore patterns on case-insensitive filesystems; verify with `git check-ignore`.

- **`CLAUDE.md` is the GLOBAL harness prompt, not project docs** — **Pattern:** "make
  CLAUDE.md the system prompt for the harness" was misread as "document the K project in
  CLAUDE.md" — it was rewritten with K-specific repo map, pnpm commands, ports, and module
  list. **Rule:** the root `CLAUDE.md` is the project-agnostic global ruleset shared by every
  agent the harness runs (planning, delegation, verification, tone, must/must-not). Keep
  project-specific facts (stack, run/test commands, module map) in that project's own bible /
  `AGENTS.md`, never in the global prompt. When asked to edit a "system prompt," confirm
  whether it is the global harness prompt or a single project's instructions before rewriting.
