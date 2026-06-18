---
title: Roadmap
icon: "➤"
status: active
updated: 2026-06-18
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

## Phase 3 — Automation & Skills *(current)*

> Skills run themselves on schedules and events; the model router goes live with cost-aware
> routing; skills are tested for regressions; and run-outcome data becomes visible and
> actionable. Waves 3-6 and 3-7 are the Phase-1 deferrals, re-homed here.

- [x] **3-1 — Skill/Hook/Workflow Registry.** `skills` + `skill_runs` tables, `skills.ts`,
  REST routes, `SkillsPage`, cron scheduler + event listener, boundary validation.
  *Done — CRUD plus manual / schedule / event triggers dispatch runs; invalid cron or
  trigger-field mismatch is rejected with 400 at the API boundary.*
- [ ] **3-2 — Ollama provider + cost-aware routing.** Replace the `ollamaProvider` stub; extend
  `route()` with task hints + run-outcome data + an Ollama reachability check.
  *Accept when: unit tests pass with no live Ollama; `route()` returns claude when
  `ENABLE_OLLAMA` is unset; an unreachable/absent Ollama falls back to claude with a warning and
  never fails a run; the supervisor needs no edits.*
- [ ] **3-3 — Skill testing via eval-harness.** Reuse `everything-claude-code:eval-harness`
  behind a thin native layer; `skill_evals` table; `POST /api/skills/:id/test` + `GET …/evals`.
  *Accept when: each test records pass/fail; a regression (was-pass, now-fail vs the prior
  baseline) is detected and surfaced on `SkillsPage`; a non-dispatchable eval degrades cleanly.*
- [ ] **3-4 — Routing improvement dashboard.** Backend aggregation of cost / latency / success
  by provider+model+task; a `RoutingPage` with an outcome table, trend charts, and a plain-
  language recommendation. *Accept when: the dashboard renders live aggregates and a sane empty
  state, reusing the stacked-SVG chart, `buildTimeseries`, and the design tokens.*
- [ ] **3-6 — Web terminal** *(re-homed from Phase 1).* `node-pty` session over the WS gateway,
  auth-guarded, cleaned up on disconnect; an xterm.js terminal in the workspace. *Accept when:
  spawn/echo/exit works and cleans up; an unsupported/absent pty degrades gracefully; the WS
  upgrade is auth-guarded. Feature-flag-isolate if `node-pty` destabilizes Windows CI.*
- [ ] **3-7 — Structured task/goal records + GitHub Issues sync** *(re-homed from Phase 1).*
  Implement `GitHubProvider.syncIssues` on the existing `project_tasks` model; add a Tasks-tab
  sync affordance. *Accept when: issue↔task mapping is correct with a mocked `gh`; an absent
  `gh` degrades (no crash), matching the PR/CI poller posture.*
- [ ] **3-5 — Phase 3 close-out.** Finalize these sections + roadmap progress, capture lessons,
  run the whole-implementation review and full e2e verification, open the PR, merge on green CI.

## Phase 4 — Multi-Device

- [ ] Tauri desktop app (tray, native notifications, bundled core)
- [ ] PWA mobile (installable, push notifications)
- [ ] Remote access hardening (reverse proxy / Tailscale)

## Phase 5 — Intelligence & Scale *(optional)*

- [ ] EventBus → NATS/Redis Streams + worker processes
- [ ] Analytics on run data for routing improvement
- [ ] Knowledge-graph-driven agent context (GitNexus → agent prompts)
