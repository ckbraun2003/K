# Project Bible — Jarvis Agentic Engineering Harness

> **Status:** Phase 0 — In Progress | **Last updated:** 2026-06-10

## Vision

A personal, self-hosted "Jarvis" — a single entry point for directing AI agents to perform real engineering work: managing projects and tickets, contributing to repositories, running automated skills and workflows, and doing all of this under a high-clarity visual dashboard that makes the system's inner workings visible and understandable at a glance.

The goal is not just a tool — it's a **persistent engineering co-pilot** that grows smarter over time through accumulated run data, knowledge graphs of your codebases, and a skill testing/verification loop.

---

## Architecture Decision

**Architecture A with B-seams** — Monolith core, B-style observability built in from day one.

### Why this shape

| Choice | Reasoning |
|--------|-----------|
| Monolith core | Fastest path to a working system for one operator; trivial self-host; easy to reason about |
| EventBus seam | Every agent event appended immutably to SQLite `events` table — enables time-travel/replay now, worker split later |
| ModelRouter interface | `route(task)` decouples the engine from the orchestrator — Ollama routing is a config switch, not a code change |
| One web UI | React + Tailwind + shadcn, wrapped as Tauri desktop + PWA mobile — design once, run everywhere, no visual quality trade-off |

### What gets deferred (not lost)

- **Multi-process workers** (Architecture B) — the EventBus seam makes this a transport swap, not a rewrite
- **CRDT offline sync** (Architecture C) — the model router is already the right abstraction
- **Passkey/TOTP auth** — Phase 0 uses a bearer token; Phase 1 hardens this

---

## Tech Stack

```
Monorepo (pnpm workspaces)
├── shared/        Zod schemas: AgentEvent, Run, Artifact, WsMessage
├── core/          Node 20 + TypeScript + Fastify + ws + better-sqlite3 + execa
└── web/           Vite + React + TS + Tailwind + shadcn/ui + TanStack Query + Framer Motion
```

**Agent engine:** Claude Code CLI (`claude -p --output-format stream-json`) wrapped by `supervisor.ts`

**Existing building blocks (don't rebuild):**
- **GitNexus** — repo indexing, knowledge graphs, impact analysis, wiki generation (Phase 2)
- **everything-claude-code** — eval-harness, continuous-learning, skill testing (Phase 3)
- **Claude Code CLI** — agent execution, skills, hooks, MCP, permissions (Phase 0+)

---

## Phased Roadmap

### Phase 0 — Foundation *(current)*

> Running skeleton: prompt → supervised agent → live stream → persisted run + artifacts

- [x] Monorepo scaffold (`shared/`, `core/`, `web/`)
- [x] Shared Zod schemas (AgentEvent, Run, Artifact, WsMessage)
- [x] SQLite schema + helpers (runs, events, artifacts tables)
- [x] EventBus seam (`events.ts`) — persist + push to WS subscribers
- [x] ModelRouter interface (`router.ts`) — claude default, ollama stub
- [x] Agent Supervisor (`supervisor.ts`) — worktree + claude CLI + stream-json parser
- [x] Artifacts store (`artifacts.ts`) — md → styled HTML + DocViewer
- [x] Project Bible (this file) — generated on core startup
- [ ] Fastify REST + WS gateway (`core/src/index.ts`)
- [ ] React dashboard: PromptBar · RunList · RunConsole · DocViewer
- [ ] End-to-end verification pass

### Phase 1 — Visibility Core

> Full observability: event timeline, token charts, terminal, structured task memory

- [ ] Token time-series charts (ECharts, per day/project/agent)
- [ ] Full run event timeline (replayable, time-travel from SQLite)
- [ ] Web terminal (xterm.js + PTY via node-pty)
- [ ] Structured task/goal records with frontmatter ⇄ DB sync
- [ ] Run list with kill switch, status filter, cost totals
- [ ] Auth hardening (passkey/TOTP replacing bearer token)

### Phase 2 — Projects, Repos, Knowledge

> Projects, tickets, agent→PR flow, knowledge graphs

- [ ] Lightweight ticket model (+ optional GitHub Issues sync)
- [ ] Agent-opens-PR flow via `gh` CLI; UI shows diff/PR status
- [ ] GitNexus integration — repo indexing + embedded graph/wiki view
- [ ] Artifact-linked project dashboard (goals ↔ runs ↔ PRs)

### Phase 3 — Automation & Skills

> Skills registry, model router live, eval loop

- [ ] Skill/hook/workflow registry with scheduled + event triggers
- [ ] Model router live — Ollama integration, cost-aware routing
- [ ] Skill testing/verification via eval-harness (pass/fail + regression)
- [ ] Data collection dashboard — run outcomes → routing improvement

### Phase 4 — Multi-Device

> Download the app everywhere without losing visual quality

- [ ] Tauri desktop app (system tray, native notifications, bundled core)
- [ ] PWA for mobile (installable, responsive, push notifications)
- [ ] Remote access hardening (reverse proxy / Tailscale)

### Phase 5 — Intelligence & Scale *(optional)*

> Promote to event bus, analytics, graph-driven context

- [ ] Promote EventBus → NATS/Redis Streams + worker processes
- [ ] Analytics on collected run data for routing improvement
- [ ] Knowledge-graph-driven agent context (GitNexus → agent prompts)

---

## Key Files

| File | Purpose |
|------|---------|
| `shared/src/types.ts` | Canonical Zod schemas for all domain objects |
| `core/src/db.ts` | SQLite schema + prepared statement helpers |
| `core/src/events.ts` | **EventBus** — the Architecture-B seam |
| `core/src/router.ts` | **ModelRouter** — the Architecture-C seam |
| `core/src/supervisor.ts` | Agent lifecycle: worktree + spawn + parse + emit |
| `core/src/artifacts.ts` | Markdown store + md→HTML renderer |
| `core/src/index.ts` | Fastify bootstrap + WS gateway |
| `web/src/pages/Dashboard.tsx` | Main single-screen dashboard |
| `artifacts/project-bible.md` | This file — regenerated by core on startup |

---

## Running Locally

```bash
# Prerequisites: Node 20, pnpm 10, claude CLI authenticated
pnpm install

# Start core (API + WS)
pnpm --filter @k/core dev       # http://localhost:3001

# Start web dashboard
pnpm --filter @k/web dev        # http://localhost:5173

# Or both in parallel
pnpm dev
```

**Environment variables (core/.env):**
```
PORT=3001
HARNESS_TOKEN=dev-token-change-me
CORS_ORIGIN=http://localhost:5173
CLAUDE_MODEL=claude-sonnet-4-6
ENABLE_OLLAMA=false
```

---

*This document is the source of truth for the Jarvis project. It is version-controlled, regenerated as `project-bible.html` on every core startup, and read by agents to stay aligned with the mission.*
