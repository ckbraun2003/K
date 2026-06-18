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
- [ ] Web terminal (xterm.js + node-pty) — *deferred to Phase 3 (Automation & Skills)*
- [ ] Structured task/goal records (+ optional GitHub Issues sync) — *deferred to Phase 3; depends on the GitHubProvider issue-sync methods (planned, not yet implemented — see §4)*
- [x] Run list kill switch, status filters, cost totals
- [ ] Auth hardening (passkey/TOTP replacing bearer token) — *deferred to Phase 4 (Multi-Device / remote-access hardening)*

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

- [x] Skill/hook/workflow registry with scheduled + event triggers
- [ ] Model router live — Ollama integration, cost-aware routing
- [ ] Skill testing via eval-harness (pass/fail + regression)
- [ ] Run-outcome data → routing improvement dashboard

## Phase 4 — Multi-Device

- [ ] Tauri desktop app (tray, native notifications, bundled core)
- [ ] PWA mobile (installable, push notifications)
- [ ] Remote access hardening (reverse proxy / Tailscale)

## Phase 5 — Intelligence & Scale *(optional)*

- [ ] EventBus → NATS/Redis Streams + worker processes
- [ ] Analytics on run data for routing improvement
- [ ] Knowledge-graph-driven agent context (GitNexus → agent prompts)
