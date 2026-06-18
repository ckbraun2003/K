# Phase 2 — Verification & Workspace Core (+ Phase 1 backlog: tech debt + onboarding)

## Context

Phase 1 (Observability Core) is complete and merged to `main` (ckbraun2003/K). The bible roadmap shows Phase 1 at 6/10 and Phase 2 unstarted. The user scoped this milestone (2026-06-12) as a **focused vertical slice**, not the full Phase 1 backlog + Phase 2:

- **Phase 1 backlog pulled in:** the `tasks/todo.md` tech-debt items (metrics/summary full-table scan, server-side run filters, lazy raw fetch) + the **Onboarding skill** (scaffold bible + CI).
- **Phase 2 vertical started:** the **Verification system** — `verify-project` skill + `VerificationReport` persistence/UI + health-score formula + CI auditor.
- **Explicitly deferred to named follow-on milestones:** web terminal (xterm/node-pty), task/goal records, auth hardening (passkey/TOTP), fleet/knowledge graph, the full 7-tab project workspace, and the agent-team PR-opening fidelity of verification.

This is the right boundary because verification reuses scaffolding that already exists but is dormant: the `verification_reports` table + `idx_verification_project` (`core/src/db.ts:72-81`), `verificationDb.insertVerificationReport`/`listVerificationReports` (`db.ts:186-196`), `projectsDb.updateProjectHealth` (`db.ts:176-178`), `VerificationReportSchema`/`FindingSchema` (`shared/src/types.ts:92-111`), and the `verification_update` WS message (`shared/src/types.ts:200`). The slice **activates** this spine end-to-end rather than building net-new infrastructure.

**Method (unchanged from Phase 0/1, the project standard):** superpowers subagent-driven development — per task: implementer subagent → spec-review subagent → quality-review subagent → controller applies fixes → one reviewable commit → push (CI verifies). Separate whole-implementation review agent before merge. Tracker in `tasks/todo.md`; this plan copied to `docs/superpowers/plans/2026-06-12-phase2-verification-core.md`.

**Branch:** `feat/phase2-verification-core` from `main`. PR → main at the end; merge on green CI.

**Verified facts the plan builds on:**
- **Metrics scan** (`core/src/routes/metrics.ts:14-19`): `/summary` does `SELECT … FROM runs` (no WHERE) → `summarizeRuns(rows, now)` derives `totalRuns = rows.length` and a 14-day window. `windowStartMs(now, days)` already exists (`metrics.ts:59-62`) and `idx_runs_created_at` exists (`db.ts:115`). `/timeseries` is already bounded.
- **Run list** (`core/src/routes/runs.ts:24-28`, `db.ts:133`): `listRuns` is a fixed `LIMIT 100`, no status/limit params. Web filters client-side in `RunList.tsx`.
- **Raw fetch** (`runs.ts:40-44`): `?raw=1` bulk-includes every event's `raw`. `RunConsole` backfills with `raw:true`; lazy per-event fetch is plan-risk #4 from Phase 1.
- **Registration** (`core/src/projects.ts:78-135`): inserts a row; never scaffolds `docs/bible/` or `.github/workflows/`. Bible §3 names exactly three invariants (GitHub remote, `docs/bible/`, CI workflows). `WORKSPACE_DIR` + `ClientError`→400 mapping established.
- **Dispatch** (`core/src/supervisor.ts:49`): `startRun(prompt, {cwd, model, projectId})` spawns claude in a worktree; `buildClaudeArgs` (`claude-args.ts:11`) sets permission mode only inside a worktree.
- **GitHub/CI signal** (`core/src/github.ts:40-49`): `getGithubStatus(projectId)` returns cached `{prs, ci, fetchedAt}` — the deterministic CI input for the health score, no live `gh` call needed.
- **Broadcast seam** (`events.ts:80-84`, `index.ts:84`): `eventBus.broadcast(WsMessage)` → all WS clients; web `onWsMessage` (`ws.ts:51`) already routes the discriminated union — UI just needs a `verification_update` handler.
- **Migration convention** (`db.ts:98-116`): guarded idempotent `ALTER` after the `CREATE TABLE IF NOT EXISTS` block; reference columns by name.
- Pure-fn + vitest pattern (`metrics.ts`, `bible-parse.ts`, `project-match.ts`; core 86 tests, web 32). Tailwind v3 drops alpha on `var()` colors — named tokens / SVG `fill="var(--x)"` only. `gh` CLI absent on this machine → CI status via GitHub web/REST; `pnpm --filter @k/core dev` hangs under the harness, e2e uses one-shot `tsx src/index.ts` background; web dev auth via Vite proxy bearer injection.

## Tasks (one reviewable commit each)

### Task 0 — Branch + plan + tracker
Branch `feat/phase2-verification-core` from `main`; copy this plan to `docs/superpowers/plans/2026-06-12-phase2-verification-core.md`; prepend a Phase 2 checklist section to `tasks/todo.md` (keep Phase 1 + Phase 0 history below).

### Task 1 — Tech debt: bound `/api/metrics/summary` (no full-table scan)
- `core/src/metrics.ts`: change `summarizeRuns(rows, now)` → `summarizeRuns(rows, now, counts: { totalRuns, activeRuns })`; rows are now only the 14-day window, `totalRuns`/`activeRuns` come from counts (preserves the documented "lifetime totalRuns" + "active = running|queued" semantics — `db.ts`/types comments).
- `core/src/routes/metrics.ts`: bound the daily scan `WHERE created_at >= windowStartMs(now,14)`; add `SELECT COUNT(*)` for `totalRuns` and `COUNT(*) WHERE status IN ('running','queued')` for `activeRuns`; pass both in.
- Update `core/test/metrics.test.ts` for the new signature (window rows + counts). Backlog note in `tasks/todo.md:43-49` is the spec.

### Task 2 — Tech debt: server-side `?status=` / `?limit=` run filters
- `shared/src/types.ts`: small `RunsQuerySchema` (`status?: RunStatus`, `limit?: 1..500 default 100`) — reuse `RunStatusSchema`.
- `core/src/db.ts` + `routes/runs.ts`: `GET /api/runs` accepts validated `status`/`limit`; build the statement dynamically (parameterized — no string interpolation of values) ordered `created_at DESC`. Default behavior unchanged (last 100, all statuses) for backward compat. 400 on invalid query.
- `web/src/lib/api.ts` `runs.list(opts?)` + `RunList.tsx`: keep the existing client chips, but pass `limit` so the footer's "last 100" boundary is server-honored; client-side counts still computed over the returned set. (Plan-risk #5 from Phase 1.)
- Tests: `core/test` route/db test for status filter + limit clamp + invalid-status 400.

### Task 3 — Tech debt: lazy per-event raw fetch
- `core/src/routes/runs.ts`: add `GET /api/runs/:id/events/:seq/raw` → returns `{ raw }` for one event (404 if absent); keep `?raw=1` for now but stop the web bulk backfill from using it.
- `web/src/lib/api.ts`: `runs.eventRaw(id, seq)`; `web/src/components/RunTimeline.tsx`: on row-expand, fetch that one event's raw on demand (cache in component state) instead of relying on the bulk `raw:true` backfill in `RunConsole`. Live WS events still carry `raw` inline (unchanged).
- Tests: `web/test/timeline.test.ts` for the lazy-fetch/caching path; core test for the single-raw endpoint + 404.

### Task 4 — Scaffolders: pure `scaffoldBible` + `scaffoldCi`
- New `core/src/scaffold.ts`: `scaffoldBible(localPath)` writes a starter `docs/bible/manifest.json` + the five sections bible §3 names (vision, architecture, roadmap, decision-log, operations) using the **same manifest+frontmatter format** as `artifacts/bible/` (mirror `bible-parse.ts` expectations); `scaffoldCi(localPath, stack)` writes `.github/workflows/ci.yml` (lint·typecheck·test·build) — start with the node/pnpm template adapted from this repo's own `.github/workflows/ci.yml`. Both are **idempotent** (skip files that already exist, return a list of created paths) and **path-guarded** (write only under `localPath`).
- Tests: `core/test/scaffold.test.ts` against a temp dir — creates expected files, second run is a no-op, never escapes `localPath`, scaffolded bible parses through `bible-parse.ts`, scaffolded `ci.yml` is valid YAML.

### Task 5 — Onboarding skill: enforce invariants on a project
- New `core/src/onboard.ts`: `onboardProject(project)` → checks the three invariants (remote present, `docs/bible/` present, `.github/workflows/` present), calls the Task-4 scaffolders for whatever's missing, returns `{ created: string[], invariants: {...} }`. Reuses `getProject` + `detectRemote` semantics from `projects.ts`.
- `core/src/routes/projects.ts`: `POST /api/projects/:id/onboard` (404 unknown id) → runs onboarding, returns the result. Do **not** auto-onboard on register (keep registration side-effect-free; onboarding is an explicit, idempotent step the UI/operator triggers — also reused by the verifier's CI auditor in Task 8).
- Author the operator-facing skill `.claude/skills/onboarding/SKILL.md` documenting the flow (mirrors the gitnexus skill layout) so it's discoverable as a Claude Code skill, but the scaffolding logic lives in core (testable, not agent-dependent).
- Tests: `core/test/onboard.test.ts` — temp git repo with/without bible/CI → correct created list, idempotent re-run.

### Task 6 — Verification engine: pure health score + auditors
- New `core/src/verify.ts`:
  - `computeHealthScore(inputs): { score, breakdown }` — exact bible §5 formula `40·CI + 20·coverageTrend + 20·bibleFreshness + 20·findings`. Inputs: `ci: 'passing'|'failing'|'flaky'|'none'`, `coverageTrend: 'improving'|'stable'|'declining'|'unknown'`, `bibleFresh: boolean`, `findings: Finding[]` (each open critical −10, warn −2, floor 0). Pure, no I/O.
  - Auditor fns that take already-gathered facts and return `Finding[]`: `auditCi(ghStatus, hasWorkflow)`, `auditBible(freshnessDays, hasBibleDir)`, `auditInvariants(project)`. Filesystem/git reads isolated in thin helpers (`hasWorkflowFile(localPath)`, `bibleFreshnessDays(localPath, bibleDir)` via `git log`) so the scoring/auditor core stays pure and unit-tested.
- Tests: `core/test/verify.test.ts` — score boundaries (all-green=100, failing CI floor, critical-finding penalties, flaky=half CI), each auditor's finding output, coverage-trend vs previous report.

### Task 7 — Verification orchestration + routes + persistence
- `core/src/verify.ts` `runVerification(projectId): VerificationReport` — gather facts (`getGithubStatus`, workflow presence, bible freshness, prior report from `listVerificationReports` for coverage trend), run auditors, `computeHealthScore`, build the report, persist via `verificationDb.insertVerificationReport`, `projectsDb.updateProjectHealth({ healthScore, lastVerifiedAt })`, then `eventBus.broadcast({ type:'verification_update', report })`.
- `shared/src/types.ts`: add optional `breakdown` (the 4 score components) to `VerificationReportSchema` for the UI; persist via a guarded `score_breakdown TEXT` ALTER in `migrate()` (established convention) + map it in a `rowToReport` helper.
- `core/src/routes/projects.ts`: `POST /api/projects/:id/verify` (synchronous deterministic run → returns report; 404 unknown id) and `GET /api/projects/:id/verifications` (history via `listVerificationReports` → `rowToReport`).
- Tests: orchestration test against a temp DB (insert project → verify → report persisted + health updated + breakdown round-trips); route 404.

### Task 8 — `verify-project` skill + CI auditor fix + deep-verify dispatch
- Author `.claude/skills/verify-project/SKILL.md` — the agent-team spec from bible §5 (CI auditor, test-coverage scout, PR reviewer, doc-freshness checker; fixes via PR, never direct push). This is the Layer-2 skill the harness dispatches.
- **CI auditor fix (deterministic, in `runVerification`):** when `auditCi` finds no workflow, call `scaffoldCi` (Task 4) to write `ci.yml` into the project working tree (uncommitted — a proposed change, not a push) and record it in `report.fixesApplied`. Honest boundary: scaffolds into the working tree for operator review; **agent-opened PRs are the deferred next increment** (needs a branch+`gh pr create` flow).
- **Deep verify (agent layer):** `POST /api/projects/:id/verify` accepts `{ deep?: boolean }`; when true, after the deterministic report it also `startRun`s the `verify-project` skill scoped to the project (`cwd: project.localPath`, `projectId`) for judgment findings — surfaced as a normal run console. Wiring the agent's structured output back into a report is explicitly deferred (risk #2).
- Tests: CI-auditor scaffold path adds a `fixesApplied` entry + creates `ci.yml` (temp repo); deep-flag dispatch is invoked (mock `startRun`).

### Task 9 — Web: verification UI (card action + report view, live)
- `web/src/components/ProjectCard.tsx`: add a "▶ Run verification" action + show `healthScore` (already rendered) with a freshness hint from `lastVerifiedAt`; clicking the card/score opens the report view. Amber/red float per existing `attention` logic, extended to low health.
- New `web/src/pages/ProjectVerification.tsx` (route `#/verify/<projectId>` in `Shell.tsx`/route map — a reusable stepping-stone toward the Phase 2 workspace Verification tab): score + breakdown bars, findings list grouped by severity, fixesApplied, report timeline (`GET …/verifications`), "Re-run" + "Deep verify" buttons. Subscribe to `verification_update` via `onWsMessage` → invalidate/patch `['verifications', id]` and `['projects']`.
- `web/src/lib/api.ts`: `projects.verify(id, {deep?})`, `projects.verifications(id)`.
- Tests: `web/test/verify.test.ts` — score/breakdown rendering, finding grouping, `verification_update` handler updates state.

### Task 10 — E2E verification pass
Core one-shot `tsx src/index.ts` (background) + web dev server; playwright-core browser checks + API/WS probes. Checklist: CI green on branch head; `/api/metrics/summary` shape unchanged + no full scan (counts correct on seeded data); `?status=`/`?limit=` filter + invalid 400; lazy raw endpoint 200/404 + timeline expand fetches one raw; `POST /projects/:id/onboard` scaffolds bible+CI idempotently on a temp repo; `POST /projects/:id/verify` → report persisted, health on card, `verification_update` arrives live, breakdown renders; CI-auditor writes `ci.yml` when missing + lists the fix; deep-verify dispatches a run; `pnpm -r typecheck` + core/web tests + `pnpm build` clean. Fix-forward, re-verify, commit fixes.

### Task 11 — Docs + bible + merge
- `artifacts/bible/sections/07-roadmap.md`: check **Onboarding skill** (Phase 1) and **`verify-project` skill** + **CI scaffolding/repair by the CI auditor** (Phase 2); update phase-progress `@live` percentages; verify in the served compiled bible.
- `09-operations.md`: new endpoints (`/projects/:id/onboard`, `/verify`, `/verifications`, lazy raw, run filters), key files (`scaffold.ts`, `onboard.ts`, `verify.ts`), `score_breakdown` migration note. `05-verification-system.md`: note the deterministic-spine-vs-agent-layer split + what's deferred. `03-project-model.md`: onboarding now scaffolds invariants.
- Tracker all-checked + review log. **Final whole-implementation review** (opus review subagent) → fix findings → push → PR `feat/phase2-verification-core → main` (github.com — `gh` absent) → merge on green CI. Re-run `npx gitnexus analyze` post-merge if the hook doesn't.

## Verification (overall)
- Per task: vitest + `pnpm -r typecheck` locally; CI on every push; spec + quality subagent reviews per task.
- Milestone: Task 10 checklist in a real browser + API/WS probes against a seeded temp project (register → onboard → verify → live report); final opus review before merge.

## Risks
1. **Health-score inputs are partly judgment (coverage, PR review).** This milestone computes the deterministic components (CI, bible freshness, invariant findings) for a real, testable score; coverage-trend uses report-over-report deltas and defaults to `unknown` (neutral) until an agent layer supplies it. Documented in `05-verification-system.md` so operator and agents agree on what today's score means.
2. **Agent-team fidelity (fan-out, PR-opening, structured report ingestion) is deferred.** Task 8 authors the skill and dispatches it as a supervised run, but the deterministic engine — not the agent — owns the persisted score/report this milestone. Avoids a fragile, untestable agent→DB ingestion path; flagged as the explicit next increment.
3. **CI auditor writes into the project working tree** (uncommitted), not via PR — honest given `gh` is absent here and no branch/PR flow exists yet. Bible §5's "fix via PR, never direct push" is preserved in spirit (nothing is pushed) and called out as deferred.
4. **`score_breakdown` ALTER on existing DBs** — guarded/idempotent per the `db.ts` convention; first post-migration boot with the dev server stopped.
5. **Scope creep into the 7-tab workspace.** The verification view is a single focused route, deliberately reusable as the future workspace Verification tab — not the workspace shell. Held firm.
