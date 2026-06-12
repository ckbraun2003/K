# Phase 1 — Observability Core (CI + backlog fixes + charts + timeline + run-list)

## Context

Phase 0 (Command Deck shell + core skeleton) is complete and merged to `main` (ckbraun2003/K). The bible roadmap shows Phase 1 at ~30%: registry, GitHubProvider, and metrics summary are done. The user confirmed this milestone targets the **observability core**: token time-series charts, full run event timeline, run-list kill/filters/cost totals, the five backlog items from `tasks/todo.md`, **plus GitHub Actions CI for this repo itself** (currently has none — first task, so every later task gets machine verification). Deferred to next milestone: web terminal, task/goal records, onboarding skill, passkey/TOTP auth. Charts use **custom SVG** (extend `Sparkline.tsx` pattern, no charting library) — all three were explicit user decisions.

**Method (user-requested agent team):** superpowers subagent-driven development, the exact Phase 0 pattern — per task: implementer subagent → spec-review subagent → quality-review subagent → controller fixes → one commit → push (CI verifies). Final whole-implementation review by a separate review agent before merge. Tracker in `tasks/todo.md`; plan copied to `docs/superpowers/plans/2026-06-12-phase1-observability-core.md`.

**Branch:** `feat/phase1-observability-core` from `main`. PR → main at the end; merge on green CI.

**Verified facts the plan builds on:**
- Auth hook `core/src/index.ts:41-48` — exemption is exact-string `req.url === '/ws' || '/health'`. Web auth comes from the Vite dev proxy injecting the bearer header (`web/vite.config.ts:19-20`) — unaffected by the fix.
- Spawn `core/src/supervisor.ts:135-139`: `claude -p <prompt> --output-format stream-json --verbose` — no permission mode (headless writes declined, the Phase 0 e2e bug). Worktree-creation failure (`supervisor.ts:91-95`) clears `run.worktree` in memory but never updates the DB row.
- `runs` table has **no `project_id`**; no migration mechanism (schema is `CREATE TABLE IF NOT EXISTS`); live data in `core/data/k.db`.
- `GET /api/runs/:id/events` already exists but `dbRowToEvent` (`core/src/routes/runs.ts:53-59`) drops the `raw` column.
- Pure-function + vitest pattern established (`metrics.ts`, `bible-parse.ts`, `github-parse.ts`; ~27 tests, core only).
- Tailwind v3 drops alpha on `var()` colors — named tokens or SVG `fill="var(--x)"` only.
- gh CLI not installed — CI status via GitHub web UI/REST. `pnpm --filter @k/core dev` hangs under the harness; e2e uses one-shot `tsx src/index.ts`.

## Tasks (one reviewable commit each)

### Task 0 — Branch + plan + tracker
Branch; copy this plan to `docs/superpowers/plans/2026-06-12-phase1-observability-core.md`; rewrite `tasks/todo.md` with the Phase 1 checklist (keep Phase 0 section for history; `tasks/` is untracked — first commit).

### Task 1 — GitHub Actions CI
- Add `"packageManager": "pnpm@<exact local version>"` to root `package.json`.
- `.github/workflows/ci.yml`: ubuntu-latest, Node 20; `pnpm/action-setup@v4` + `setup-node` (pnpm cache); `pnpm install --frozen-lockfile` → `pnpm -r typecheck` → `pnpm --filter @k/core test` → `pnpm build`. Trigger: push to `main`/`feat/**`/`fix/**` + PRs to main; `concurrency` cancel-in-progress.
- Verify: push branch, confirm green run on github.com/ckbraun2003/K/actions.

### Task 2 — Auth pathname fix + accepted-risks note + favicon
- New pure `core/src/auth.ts`: `isAuthExempt(url)` — `new URL(url, 'http://localhost').pathname` against `Set(['/ws','/health'])`; `core/test/auth.test.ts` (query variants pass, `/ws/../api/runs` and `/wsx` fail).
- `index.ts` hook uses `isAuthExempt(req.url)`.
- `artifacts/bible/sections/09-operations.md`: **Accepted risks** section — /ws auth-exempt by design (localhost posture), first thing to close if HOST=0.0.0.0.
- `web/public/favicon.svg` (bolt on accent tokens) + `<link rel="icon">` in `web/index.html`.

### Task 3 — Supervisor: permission mode + worktree-NULL persistence
- New pure `core/src/claude-args.ts`: `resolvePermissionMode(env)` (validates against `default|plan|acceptEdits|bypassPermissions`, falls back to `acceptEdits` with warn) and `buildClaudeArgs(prompt, { inWorktree, permissionMode })` — appends `--permission-mode <mode>` **only when in a worktree** and mode ≠ default. Fallback-to-cwd runs stay default-restricted (they touch the real checkout).
- **Decision: default `acceptEdits`**, env override `RUN_PERMISSION_MODE`. Rationale: fixes the observed "write declined" bug with blast radius limited to files in a disposable worktree; `bypassPermissions` (Bash etc.) is explicit opt-in — worktrees isolate the checkout, not the machine. Implementer pre-checks flag names against installed `claude --help`.
- `supervisor.ts`: thread `inWorktree` into `runAgent`; replace literal argv with `buildClaudeArgs`. In the worktree-creation catch block, call new `runsDb.clearRunWorktree` (`UPDATE runs SET worktree = NULL WHERE id = ?`) in `db.ts`.
- Tests: `claude-args.test.ts` (flag matrix) + small `db-runs.test.ts` (clear worktree round-trip).

### Task 4 — `runs.project_id` migration + run→project association
- `db.ts`: add `project_id TEXT REFERENCES projects(id)` to the runs DDL + index, **and** a guarded migration after the exec block: `hasColumn('runs','project_id')` via `db.pragma('table_info(runs)')` → idempotent `ALTER TABLE runs ADD COLUMN ...` (establishes the migration convention with a comment). `insertRun` gains `@projectId`. First post-migration boot with the dev server stopped.
- `shared/src/types.ts`: `RunSchema` + `StartRunBodySchema` gain `projectId: z.string().uuid().optional()`.
- New pure `core/src/project-match.ts`: `matchProjectByCwd(cwd, projects)` — normalized (backslash→slash, lowercase, trailing-slash trimmed) prefix match, deepest root wins, `+'/'` guard against `C:/repo2` vs `C:/repo`; tests for all of those.
- `supervisor.ts` `startRun`: `projectId = opts.projectId ?? matchProjectByCwd(cwd, listProjects) ?? undefined` — inference uses the **original `cwd`**, never the worktree path.
- `routes/runs.ts`: POST validates provided projectId exists (else 400); `dbRowToRun` maps it.

### Task 5 — Web plumbing: projectId dispatch + ⌘K `@project` scope
- `web/src/lib/api.ts`: `runs.start(prompt, opts?: { cwd?, projectId? })` (one call site: CommandBar).
- `web/src/shell/CommandBar.tsx`: `@name <prompt>` prefix → unique case-insensitive project-name match → dispatch with `{ cwd: project.localPath, projectId: project.id }`; bare `@` lists projects as completion hints. Full picker UI deferred to Phase 2 project workspace.

### Task 6 — Time-series aggregation + endpoint
- `shared/src/types.ts`: `MetricsTimeseries` schemas — `{ groupBy: 'project'|'model', days, dates: string[] (local YYYY-MM-DD, zero-filled, oldest→newest), series: [{ key, label, points: {runs,tokens,costUsd}[] (aligned to dates), total }] }`, series sorted tokens-desc.
- `core/src/metrics.ts`: pure `buildTimeseries(rows, now, days, groupBy)` — reuse the existing calendar-day arithmetic from `summarizeRuns` (DST-safe, do not reinvent). `groupBy=project`: NULL → `unassigned`; label from LEFT-JOINed project name. `groupBy=model`: key = model, label prefixed `provider/` when ≠ claude. Top-8 series by total tokens, remainder folded into `other` (always last).
- `core/src/routes/metrics.ts`: `GET /api/metrics/timeseries?days=1..90(=30)&groupBy=project|model(=project)` — zod-coerced query, 400 on invalid; SQL = `runs LEFT JOIN projects`.
- Tests in `core/test/metrics.test.ts`: zero-fill/order, unassigned fold, model labels, top-8+other, window exclusion, `days=1`.

### Task 7 — Web: stacked SVG chart + Metrics page
- Chart tokens: `--chart-1..8` + `--chart-other` in `index.css`, mirrored in `tailwind.config.ts` for legend swatches. SVG `fill="var(--chart-N)"` (no Tailwind alpha trap).
- New `web/src/components/TimeseriesChart.tsx` — hand-rolled stacked bars (Sparkline's viewBox/`preserveAspectRatio="none"` scaling), props `{ data, metric: 'tokens'|'costUsd'|'runs', height? }`; hover rect per day → fixed detail row under the chart (no floating tooltip); legend = swatch + label + total; empty state for all-zero window.
- New `web/src/pages/MetricsPage.tsx` — segmented controls for groupBy/days(14|30|60)/metric, `useQuery` with 30s refetch, card layout on design tokens.
- Enable destination: `Sidebar.tsx` metrics entry, `Shell.tsx` route (+ `g m` chord); ⌘K nav picks it up from DESTINATIONS.
- `api.ts`: `metrics.timeseries(days, groupBy)`.

### Task 8 — Full run event timeline (replay)
- Backend: `GET /api/runs/:id/events?raw=1` opt-in includes the stored `raw` column (default response stays slim); `api.ts` `runs.events(id, { raw? })`.
- `RunConsole.tsx`: `Console | Timeline` segmented toggle in header; backfill fetches with `raw: true`; single merged events array serves both views (live WS events already carry raw).
- New `web/src/components/RunTimeline.tsx`: rows = seq · `HH:MM:SS.mmm` + relative `+12.3s` · type badge (reuse EVENT_COLOR mapping) · tool name · text preview; click-to-expand pretty-printed raw JSON; **replay scrubber** footer — range input over event index, rows past cursor dimmed to `opacity-25` (not hidden), play/pause auto-advance with `clamp(Δts, 120, 1000)`ms chained timeouts (cleared on unmount/run-change — Phase 0 chord-timer lesson), `seq i/N · +Xs` readout.

### Task 9 — Run list: filter chips, row kill, cost totals
- `web/src/components/RunList.tsx` only: filter chips `all|active|done|error|killed` with counts (`active` = running+queued, matching ActivityStrip); row-hover `✕` kill on running/queued rows (`stopPropagation`, no confirm — matches console's existing kill pattern; WS run_update flips status, no optimistic state). **HTML validity:** rows are buttons — nested kill button requires restructuring row to `role="button"` div (quality reviewer checks this).
- Sticky footer: `Σ N runs · $X · Yk tok` over the **filtered** set, prefixed `last 100 ·` when at the LIMIT 100 boundary.

### Task 10 — E2E verification pass (Phase 0 pattern)
Core one-shot via `tsx src/index.ts` (background) + web dev server; playwright-core browser checks + API/WS probes. Checklist: CI green on branch head; `/health?x=1` 200 unauth + `/api/runs` 401 + dot-segment bypass 401; favicon 200/no console 404; permission-mode run writes a file with no "declined"; worktree-fail run → DB worktree NULL; projectId inference + `@k` scope + bogus projectId 400; timeseries shapes + 400s; Metrics page toggles/hover; timeline replay + live append; run-list chips/kill/totals; WS reconnect ≤3s regression; `pnpm -r typecheck` + core tests + `pnpm build` clean. Fix-forward, re-verify, commit fixes.

### Task 11 — Docs + bible + merge
- `07-roadmap.md`: check the three delivered Phase 1 items. `09-operations.md`: `RUN_PERMISSION_MODE` env row, new key files (auth.ts, claude-args.ts, project-match.ts), CI row, migration convention note. `02-architecture.md` route list if applicable. Tracker all-checked + review log. Verify served compiled bible.
- **Final whole-implementation review** (opus review subagent, Phase 0 pattern) → fix findings → push → PR `feat/phase1-observability-core → main` (github.com — gh CLI absent) → merge on green CI.

## Verification (overall)
- Per task: vitest + `pnpm -r typecheck` locally; CI on every push after Task 1; spec + quality subagent reviews per task.
- Milestone: Task 10 checklist in a real browser + API probes; final opus review before merge.

## Risks
1. **`--permission-mode` flag drift across CLI versions** — Task 3 pre-checks `claude --help`; pure `buildClaudeArgs` makes renames one-line fixes. `acceptEdits` still declines Bash — fully autonomous build/test runs need explicit `RUN_PERMISSION_MODE=bypassPermissions` (documented, deliberate).
2. **Migration at import time** — guarded ALTER is idempotent; run first post-Task-4 boot with the server stopped to avoid a concurrent-first-migration race.
3. **CI native module** — better-sqlite3 prebuilds for Node 20/ubuntu expected; ubuntu-latest has toolchain if it must compile. Watch the first run.
4. **`?raw=1` payload size** on long runs — acceptable for localhost; lazy per-event raw fetch is the noted follow-up, not built now.
5. **Cost totals scope** — operates on the visible LIMIT-100 window by design and labeled as such; historical totals live on the Metrics page.
