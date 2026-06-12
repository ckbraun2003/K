# Phase 1 — Observability Core — Execution Tracker

Plan: `docs/superpowers/plans/2026-06-12-phase1-observability-core.md`
Method: subagent-driven development (implementer → spec review → quality review per task)
Branch: `feat/phase1-observability-core`

## Tasks

- [x] Task 0: Branch + plan + tracker (this commit)
- [ ] Task 1: GitHub Actions CI (install, typecheck, test, build)
- [ ] Task 2: Auth pathname fix + accepted-risks note + favicon
- [ ] Task 3: Supervisor — permission mode + worktree-NULL persistence
- [ ] Task 4: runs.project_id migration + run→project association
- [ ] Task 5: Web plumbing — projectId dispatch + ⌘K @project scope
- [ ] Task 6: Time-series aggregation + endpoint
- [ ] Task 7: Web — stacked SVG chart + Metrics page
- [ ] Task 8: Full run event timeline (replay)
- [ ] Task 9: Run list — filter chips, row kill, cost totals
- [ ] Task 10: End-to-end verification pass
- [ ] Task 11: Documentation + bible update
- [ ] Final: whole-implementation code review → PR → merge on green CI

## Backlog (deferred to next milestone — user decision 2026-06-12)

- Web terminal (xterm.js + node-pty)
- Structured task/goal records (+ optional GitHub Issues sync)
- Onboarding skill (scaffold bible + CI)
- Auth hardening (passkey/TOTP replacing bearer token)
- Lazy per-event raw fetch if `?raw=1` backfill payloads ever bite (plan risk #4)
- Server-side `?limit=`/`?status=` filters on GET /api/runs if the last-100
  window proves unsatisfying (plan risk #5)

## Environment notes

- `gh` CLI NOT installed — CI status via GitHub web UI / unauthenticated REST.
- `pnpm --filter @k/core dev` (tsx watch) hangs under the agent harness; for
  e2e run one-shot: `cd core && ./node_modules/.bin/tsx src/index.ts` via Bash,
  background.
- Web dev auth: Vite proxy injects the bearer header (web/vite.config.ts).
- First boot after Task 4 migration: run with the dev server stopped.

## Review log

(per-task spec/quality review outcomes recorded here)

---

# Phase 0 Finish + Command Deck — Execution Tracker (history)

Plan: `docs/superpowers/plans/2026-06-10-phase0-command-deck.md`
Method: subagent-driven development (implementer → spec review → quality review per task)
Branch: `feat/phase0-command-deck`

## Tasks

- [x] Task 1: Fix REPO_ROOT bug + vitest setup (15b144c — spec ✅, quality ✅; deferred: vitest 2.x bump suggestion, plan pins ^1.6.0)
- [x] Task 2: Extract + test bible parsing (be4a87d — spec ✅, quality ✅ minor notes)
- [x] Task 3: EventBus broadcast channel (45e6481 — spec ✅, quality ✅)
- [x] Task 4: Metrics summary (b1d9a4f + fixes e040a9a, 38df5c4 — spec ✅, quality ✅ after DST fix loop; controller caught reviewer's midnight-anchor fix being wrong, replaced with calendar-day arithmetic)
- [x] Task 5: Project registry API (b591e30 + hardening 4263713 — spec ✅; quality review found Critical path traversal via name→workspace path, fixed + 409/500 semantics, in-flight guard, stale-clone remote check; 19 tests green)
- [x] Task 6: GitHubProvider — gh CLI, cache, poller (55132fa + hardening d73a521 — spec ✅; quality review: 2 Critical fixed (safe cache JSON parse, NaN POLL_MS), overlap guard, stopGithubPoller onClose hook, fetchedAt max, 3 rollup tests; deferred: state/status enums, github_cache FK, Fastify logger; 27 tests green)
- [x] Task 7: Web design tokens + flare layer (2303bfb + 9e8b0f8 — spec ✅; quality: tailwind.config.ts palette aligned to bible tokens (prevents silent color trap in Tasks 8-15), glow-live base opacity 0.45; deferred: @fontsource latin-subset imports (~109KB legacy woff in dist — cosmetic))
- [x] Task 8: Hash router + Shell frame (72bd1ef + 5418065 — spec ✅; quality: added `relative` so chrome z-10 is effective; controller REJECTED reviewer's Ctrl+K input-guard suggestion — would break ⌘K toggle-close from CommandBar's own input)
- [x] Task 9: CommandBar — dispatch + navigate (36e6a75 + 4a64018 — spec ✅; quality: busy guard vs double-dispatch + selection reset on items identity; PromptBar.tsx + Dashboard.tsx deleted)
- [x] Task 10: ActivityStrip (6f6b613 — spec ✅, quality ✅ no fixes; api.ts gained metrics/projects endpoints)
- [x] Task 11: Home page — metrics row + project cards (5397d42 — spec ✅, quality ✅ no fixes; cosmetic useTicker decimal-snap noted, accepted)
- [x] Task 12: Runs page (restyle existing console) (9ebd26a — spec ✅, quality ✅ no fixes)
- [x] Task 13: Docs page — artifact rail + DocViewer (975f058 + 59c9ab0 — spec ✅ verbatim, quality ✅; controller found+fixed core gap: getArtifact re-rendered md generically, discarding compiled bible view — now prefers on-disk html; verified live: API serves 48KB compiled template with nav/progress)
- [x] Task 14: Projects page — register + GitHub status (58865de — spec ✅ verbatim, quality ✅ no fixes; api.ts error-body parsing + dialog a11y deferred to Task 15)
- [x] Task 15: Keyboard chords + final polish (5f37b15 + af47788 — spec ✅ all 7 changes, quality ✅; ⌘K branch deliberately hoisted above input guard to preserve toggle-close; controller applied chord-timer cleanup + aria-labelledby; api.ts now surfaces server `{error}` bodies; raw palette tokenized)
- [x] Task 16: End-to-end verification pass (ce42b4b — all 12 checklist items PASS, verified in real Chrome via playwright-core + API/WS probes; fixed: kill→"killed" status, CLI usage/cost parsing (nested usage + total_cost_usd), WS socket error handler, web dot amber-on-disconnect (onWsStatus), CommandBar nav-vs-dispatch ranking, dialog Escape via window listener, nested <main> landmarks; probes: duplicate-register 409 message surfaces, Escape-after-error closes, reconnect green ≤3s)
- [x] Task 17: Documentation + bible update (95bf361 + 4d31e83 — roadmap Phase 0 11/11 = 100% verified in served compiled bible; Phase 1 at 30%; env vars + key files + workspace row added to operations; architecture diagram updated, controller fixed 1-char box misalignment)
- [x] Final: whole-implementation code review (opus — APPROVE; both Important findings fixed + verified in browser (9936876): RunConsole event backfill via GET /runs/:id/events, worktree cleanup on error path; also fixed: 14 dead `bg-[var(--x)]/NN` tints (Tailwind v3 drops alpha on var() colors — replaced with named tokens, rgba now renders), HOST default → 127.0.0.1)

## Backlog (from final review + e2e observations) — STATUS as of Phase 1 plan

- Headless runs can't use write tools → **Phase 1 Task 3** (--permission-mode acceptEdits for worktree runs)
- Stale `worktree` DB column when worktree creation fails → **Phase 1 Task 3**
- Auth-exempt match is exact-string `req.url === '/ws'` → **Phase 1 Task 2**
- /ws auth-exempt by design — bible accepted-risks note → **Phase 1 Task 2**
- Missing favicon → benign 404 console error → **Phase 1 Task 2**

## Environment notes

- `gh` CLI NOT installed on this machine — GitHub features degrade gracefully
  (poller logs warnings, cache serves empty). User must `winget install GitHub.cli`
  + `gh auth login` for live PR/CI data.
- Baseline before Task 1: all three typechecks clean, no tests existed yet.
- `pnpm --filter @k/core dev` (tsx watch) hangs silently when launched from the
  agent harness (no output, never binds 3001). For e2e checks run one-shot:
  `cd core && ./node_modules/.bin/tsx src/index.ts` via Bash, background.

## Review log

- Task 3 quality review: WS gateway lacks `socket.on('error')` handler (pre-existing
  debt, not introduced by Task 3). Unhandled ws 'error' can skip 'close' → subscriber
  leak. Address during Task 16 e2e pass (check #11 WS reconnect).
- Task 8 quality review — notes for downstream tasks:
  - Task 12: AnimatePresence key is route.view only — run-detail param changes won't
    transition; use `key={route.view + (route.param ?? '')}` if needed.
  - Task 13: route param is not URI-decoded and `/` in a param truncates — DocsPage
    should decodeURIComponent and slugs must avoid raw slashes (or encode in navigate).
  - Task 15: add `aria-current="page"` to active sidebar button (a11y polish checklist).
  - Task 15: CommandBar keyboard selection lacks scrollIntoView past max-h-72 clip
    (quality review Task 9 — deferred polish).
  - Task 15: pre-existing raw-palette colors to tokenize if polish scope allows:
    RunConsole kill button (bg-red-500/20), tool-call span (text-purple-400),
    RunList STATUS_DOT fallback (bg-gray-400).
  - web/src/lib/ws.ts reconnect setTimeout has no stored handle (endless loop after
    server shutdown) — evaluate during Task 16.
- Task 14 quality review — notes for Task 15:
  - api.ts req() throws `${status} ${statusText}`, discarding the server's
    descriptive `{ error }` JSON body — parse it so register dialog (and all
    error states) show real messages instead of "409 Conflict".
  - Register dialog a11y: role="dialog"/aria-modal, Escape to close, autoFocus
    first input (fold into Task 15 polish if scope allows).
