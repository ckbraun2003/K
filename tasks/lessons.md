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

- **`npx gitnexus analyze` rewrites `CLAUDE.md`** — **Pattern:** running the
  GitNexus analyzer (manually or via the post-commit hook) appends a large
  `<!-- gitnexus:start -->…<!-- gitnexus:end -->` block to `CLAUDE.md`, re-bloating
  the file that Wave 0 deliberately trimmed. **Rule:** after any `gitnexus analyze`
  (or any commit, since a PostToolUse hook re-runs it), `git checkout -- CLAUDE.md`
  before staging the next change; never let the injected block land in a feature
  commit. Verify with `git diff --stat CLAUDE.md` (should be empty).

- **pnpm 10 ignores native build scripts until approved** — **Pattern:** `pnpm add
  node-pty` installed the package but skipped its build (prebuild copy), so the
  native binding was absent. **Rule:** native deps must be listed under
  `onlyBuiltDependencies` in `pnpm-workspace.yaml` (alongside `better-sqlite3`,
  `esbuild`); then `pnpm install` runs the build. Verify the binding actually loads
  (`node -e "require('node-pty').spawn(...)"`) before assuming it works.

- **Scope embedded browser secrets to the feature** — **Pattern:** the web terminal
  needed a token in the bundle; baking `HARNESS_TOKEN` (the full-REST credential)
  into the Vite bundle would let a leaked bundle hit every API route. **Rule:** when
  a credential must reach the browser, mint a SEPARATE, narrowly-scoped token
  (`TERMINAL_TOKEN`) so a leak grants only that feature — never the master token.
  Auth-guard sensitive WS routes that are hook-exempt with an in-handler token check.

- **Verify native/runtime seams live, not just with mocks** — **Pattern:** the
  terminal's unit tests use a fake pty; that proves the bridge logic but not the
  real node-pty dynamic-import + spawn. **Rule:** for a wave whose risk is a native
  binding or a real subprocess, run one live end-to-end smoke (boot the app, drive
  the real WS, assert real output + that a bad token spawns nothing) in addition to
  the deterministic mocked unit tests. Keep the live check out of CI; run it in
  verification.

- **`CLAUDE.md` is the GLOBAL harness prompt, not project docs** — **Pattern:** "make
  CLAUDE.md the system prompt for the harness" was misread as "document the K project in
  CLAUDE.md" — it was rewritten with K-specific repo map, pnpm commands, ports, and module
  list. **Rule:** the root `CLAUDE.md` is the project-agnostic global ruleset shared by every
  agent the harness runs (planning, delegation, verification, tone, must/must-not). Keep
  project-specific facts (stack, run/test commands, module map) in that project's own bible /
  `AGENTS.md`, never in the global prompt. When asked to edit a "system prompt," confirm
  whether it is the global harness prompt or a single project's instructions before rewriting.

- **Import the renderer subpackage, not the `react-force-graph` aggregate** — **Pattern:** all
  three graph views imported `{ ForceGraph2D } from 'react-force-graph'`. The aggregate package's
  module body wires up the 3D/VR/AR renderers, which reference a global `AFRAME` that doesn't exist
  in a plain browser, so it threw `ReferenceError: AFRAME is not defined` at module-evaluation time.
  Because `Shell` statically imports the graph pages, that throw crashed the whole React tree —
  blank screen on EVERY route. typecheck, `vite build`, and all 80 unit tests passed regardless,
  because the crash only manifests in a real browser at runtime. **Rule:** import the renderer-
  specific subpackage (`react-force-graph-2d`, default export) — never the `react-force-graph`
  aggregate — and remember unit tests + build do NOT catch module-eval-time browser crashes. For a
  client-rendered SPA, a "blank page" almost always = an uncaught throw during initial render/module
  load; drive a real browser and read the console. Added a static guard test
  (`web/test/bundle-guard.test.ts`) that fails CI if the aggregate import returns.
