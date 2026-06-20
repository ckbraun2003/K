---
title: Roadmap
icon: "➤"
status: active
updated: 2026-06-20
---

Re-baselined 2026-06-10 to fold in the compiled-bible, registry, GitHub, verification, and Command Deck designs.

<!-- @live:roadmap-progress -->

## Phase 0 — Foundation

> Running skeleton: prompt → supervised agent → live stream → persisted run + artifacts + compiled bible

- [x] Monorepo scaffold (`shared/`, `core/`, `web/`)
- [x] Shared Zod schemas (AgentEvent, Run, Artifact, WsMessage)
- [x] SQLite schema + helpers (runs, events, artifacts)
- [x] EventBus seam (`events.ts`) — persist + push to WS subscribers
- [x] ModelRouter interface (`router.ts`) — claude default, ollama stub
- [x] Agent Supervisor (`supervisor.ts`) — worktree + claude CLI + stream-json parser
- [x] Artifacts store (`artifacts.ts`) — md → styled HTML
- [x] Bible compiler (`bible.ts`) — sections + live data → self-contained HTML
- [x] Project/VerificationReport schemas + tables (groundwork)
- [x] Fastify REST + WS gateway end-to-end verification pass
- [x] React dashboard — Command Deck shell (sidebar · ⌘K · stage · activity strip)

## Phase 1 — Visibility + Fleet plumbing

> Full observability, plus the registry and GitHub seams go live

- [x] Project registry API (register path / clone URL)
- [x] Onboarding skill (scaffold bible + CI)
- [x] GitHubProvider via `gh` CLI — PR list/status, CI runs, polling + SQLite cache
- [x] Metrics summary endpoint + dashboard metrics row
- [x] Token time-series charts (per day/project/model) — stacked SVG, top-8 + other
- [x] Full run event timeline (replayable from SQLite via `?raw=1`)
- [x] Run list kill switch, status filters, cost totals

**Deferred out of Phase 1** (re-homed to their target phases so this phase reflects only its
delivered scope): web terminal → **Phase 3 (3-6)**; structured task/goal records + GitHub Issues
sync → **Phase 3 (3-7)**; auth hardening (passkey/TOTP) → **Phase 4** (remote-access hardening).

## Phase G — Command Deck + Knowledge + Verification *(✓ complete 2026-06-18)*

> The approved dashboard design built for real; graphs and the verify-project skill live

> *Phase G builds the originally-numbered "Phase 2 — Command Deck" design; it was renamed to avoid collision with the merged Phase 2 verification-core work.*

- [x] Command Deck frame: icon sidebar, ⌘K bar, stage, activity strip
- [x] Home stage: metrics row, needs-attention project cards, fleet graph pane
- [x] Project workspace: 7 tabs incl. per-project Knowledge Graph (GitNexus)
- [x] Node inspector with dispatch-agent actions
- [x] `verify-project` skill: agent team, VerificationReport, health scores
- [x] CI scaffolding/repair by the CI auditor
- [x] Agent-opens-PR flow surfaced in PRs & CI tab
- [x] Fleet Graph on Home page + full-screen /graph route
- [x] Knowledge Graph tab: ForceGraph2D, node inspector, stale-index banner
- [x] Task CRUD: `project_tasks` table + `GET/POST/PATCH /api/projects/:id/tasks`
- [x] `createPR` via `gh` CLI (argv array, sanitized errors) + `POST /api/projects/:id/prs`
- [x] "Create PR from Run →" footer in RunConsole
- [x] G-6: tasks-route tests, create-pr tests, bible §06+§07 updates, .env.example

## Phase 3 — Automation & Skills *(✓ complete 2026-06-18)*

> Skills run themselves on schedules and events; the model router goes live with cost-aware
> routing; skills are tested for regressions; and run-outcome data becomes visible and
> actionable. Waves 3-6 and 3-7 are the Phase-1 deferrals, re-homed here.

- [x] **3-1 — Skill/Hook/Workflow Registry.** `skills` + `skill_runs` tables, `skills.ts`,
  REST routes, `SkillsPage`, cron scheduler + event listener, boundary validation.
  *Done — CRUD plus manual / schedule / event triggers dispatch runs; invalid cron or
  trigger-field mismatch is rejected with 400 at the API boundary.*
- [x] **3-2 — Ollama provider + cost-aware routing.** Replaced the `ollamaProvider` stub with a
  real `ollama run` provider; extended `route()` with `preferLocal`/`maxCostUsd` hints, mean
  completed-claude-cost run-outcome data, and a background reachability probe.
  *Done — `route()` returns claude unless `ENABLE_OLLAMA` AND a probe confirms reachability;
  an unreachable/absent Ollama degrades to claude (warn, never fails a run); supervisor unchanged
  (it dispatches + parses on the routed provider, so an ollama run can't run/parse as claude).*
- [x] **3-3 — Skill testing via eval-harness.** `skill_evals` table; `runSkillTest` dispatches a
  supervised eval run (eval-harness methodology, `EVAL VERDICT` marker); `POST /api/skills/:id/test`
  + `GET …/evals`. *Done — each test records pass/fail; a regression (was-pass, now-fail vs the
  prior baseline) is flagged + badged on `SkillsPage`; a non-dispatchable eval degrades to a
  durable failed eval.*
- [x] **3-4 — Routing improvement dashboard.** Pure `aggregateRouting` over windowed runs
  (cost / latency / success by provider+model — there is no task taxonomy on `runs`, so
  provider+model is the routing dimension); `GET /api/metrics/routing`; `RoutingPage` with an
  outcome table, a cost-by-model trend (reusing the stacked-SVG chart), a plain-language
  recommendation, and an empty state. *Done.*
- [x] **3-6 — Web terminal** *(re-homed from Phase 1).* A `node-pty` shell bridged over a new
  `/ws/terminal` WS route, rendered with xterm.js. *Done — default-OFF (`ENABLE_TERMINAL`);
  auth-guarded by a scoped `TERMINAL_TOKEN` (distinct from `HARNESS_TOKEN`, the only token in the
  web bundle); node-pty dynamically imported so a missing binding degrades to a clean error, never
  crashing boot; session disposed on disconnect. Verified live (real echo on a valid token; no
  shell spawned on a bad token).*
- [x] **3-7 — Structured task/goal records + GitHub Issues sync** *(re-homed from Phase 1).*
  `GitHubProvider.syncIssues` reconciles `gh issue list` into `project_tasks` (insert / close /
  reopen / no-clobber of `in_progress`); Tasks-tab sync button. *Done — mapping verified with a
  mocked `gh`; absent `gh` (or a no-remote project) degrades to `{ synced: 0, degraded: true }`
  at 200, matching the PR/CI poller posture.*
- [x] **3-5 — Phase 3 close-out.** These sections + roadmap progress finalized, lessons captured,
  whole-implementation review (no blockers; in-scope fixes landed) + full verification
  (typecheck · core 345 / web 81 tests · build) green, merged to `main`. Live headless-Chromium
  pass across all 10 routes caught and fixed a blank-screen regression — the `react-force-graph`
  aggregate threw `AFRAME is not defined` at module-eval time, blanking every route; switched to
  the 2D-only `react-force-graph-2d` subpackage (guarded by a static import test).

## Phase H — Knowledge Graph Engine & Experience Polish

> Every registered project gets a live, navigable, actionable code graph; the interface feels finished (hybrid glass + motion); the bible self-demonstrates via a real UI artifact. One reviewable commit per wave (implementer → spec-review → quality-review → controller → CI).

> *Phase H is experience-focused and lettered like Phase G; it slots in before Phase 4 (Multi-Device).*

- [x] **H-1 — Graph build engine (core).** `project_graphs` table (status/built_at/last_commit/node+edge counts/error); `buildGraph()` runs `npx gitnexus analyze` via an injected seam with an in-flight guard + EventBus emit; `POST /api/projects/:id/graph/build` + status/stale on `GET …/graph`; transient `graph_update` WS; shared graph-status schema; `graph.test.ts` (CI never invokes real GitNexus).
- [x] **H-2 — Enrichment, dispatch, auto-reindex (core).** Live node enrichment in `GET …/graph` (last-touched run, verify findings, bible — bible scoped to the harness project only); `POST /api/projects/:id/graph/dispatch` (node-scoped run via `startRun`, single-line input guard → 400); auto-reindex via an `onRunUpdate` subscriber (per-project debounced, guarded; env flag `GRAPH_AUTO_REINDEX`, default on).
- [x] **H-3 — Knowledge Graph UI.** Build/Refresh button + building spinner + last-built/stale/error chips + WS-driven auto-refresh; node inspector enriched facts + enabled Dispatch Agent (confirm-card → dispatch → transient notice); graph polish (status coloring, legend, spring physics, center/zoom on click, reduced-motion); fleet-graph polish (nodes-only, no invented edges).
- [x] **H-4 — Hybrid glass + motion.** Glass tokens + backdrop-blur utilities + `@supports` fallback (`index.css`); glass applied to hero surfaces only (command bar, modals, node inspector, activity strip); centralized `lib/motion.ts` variants + `MotionConfig` reduced-motion; 60fps check.
- [x] **H-5 — UI artifact system.** `core/src/ui-artifact.ts` (`compileUiArtifact` writes rich HTML to disk verbatim + upserts md); `POST /api/ui-artifact/compile`; seeded harness `ui-demo` (interactive mini Command Deck, hybrid-glass); DocViewer UI badge/link; `ui-artifact.test.ts` (preserves interactive HTML, output-path isolation).
- [x] **H-6 — `create-web-ui-artifact` skill + bible docs.** New `.claude/skills/create-web-ui-artifact/SKILL.md` (UI counterpart to `onboarding`), seeded into the skills registry as a manual workflow; bible §06 (hybrid glass + motion + graph engine + UI artifact), §07 (this Phase H), §08 (D-009/D-010/D-011); skill-registration + bible-isolation tests.
- [ ] **H-7 — Verify, CI, whole-implementation review.** `verify-project` / health audit; `pnpm typecheck && pnpm -r test && pnpm build` + CI green on the branch; whole-implementation review across all waves; recompile bible; merge `--no-ff`.

## Phase 4 — Multi-Device

- [ ] Tauri desktop app (tray, native notifications, bundled core)
- [ ] PWA mobile (installable, push notifications)
- [ ] Remote access hardening (reverse proxy / Tailscale)

## Phase 5 — Intelligence & Scale *(optional)*

- [ ] EventBus → NATS/Redis Streams + worker processes
- [ ] Analytics on run data for routing improvement
- [ ] Knowledge-graph-driven agent context (GitNexus → agent prompts)
