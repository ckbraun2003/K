---
title: Roadmap
icon: "➤"
status: active
updated: 2026-06-10
---

Re-baselined 2026-06-10 to fold in the compiled-bible, registry, GitHub, verification, and Command Deck designs.

<!-- @live:roadmap-progress -->

## Phase 0 — Foundation *(current)*

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
- [ ] Fastify REST + WS gateway end-to-end verification pass
- [ ] React dashboard skeleton: PromptBar · RunList · RunConsole · DocViewer

## Phase 1 — Visibility + Fleet plumbing

> Full observability, plus the registry and GitHub seams go live

- [ ] Project registry API + onboarding skill (register path / clone URL, scaffold bible)
- [ ] GitHubProvider via `gh` CLI — PR list/status, CI runs, polling + SQLite cache
- [ ] Token time-series charts (per day/project/agent)
- [ ] Full run event timeline (replayable from SQLite)
- [ ] Web terminal (xterm.js + node-pty)
- [ ] Structured task/goal records (+ optional GitHub Issues sync)
- [ ] Run list kill switch, status filters, cost totals
- [ ] Auth hardening (passkey/TOTP replacing bearer token)

## Phase 2 — Command Deck + Knowledge + Verification

> The approved dashboard design built for real; graphs and the verify-project skill live

- [ ] Command Deck frame: icon sidebar, ⌘K bar, stage, activity strip
- [ ] Home stage: metrics row, needs-attention project cards, fleet graph pane
- [ ] Project workspace: 7 tabs incl. per-project Knowledge Graph (GitNexus)
- [ ] Node inspector with dispatch-agent actions
- [ ] `verify-project` skill: agent team, VerificationReport, health scores
- [ ] CI scaffolding/repair by the CI auditor
- [ ] Agent-opens-PR flow surfaced in PRs & CI tab

## Phase 3 — Automation & Skills

- [ ] Skill/hook/workflow registry with scheduled + event triggers
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
