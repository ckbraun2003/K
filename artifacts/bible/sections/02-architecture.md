---
title: Architecture
icon: "⬡"
status: stable
updated: 2026-06-11
---

**Architecture A with B-seams** — a monolith core with Architecture-B observability built in from day one (decision D-001).

```
┌──────────────────────────────────────────────────────────────┐
│  web/  React Command Deck (Vite + Tailwind + shadcn/ui)      │
│        TanStack Query (REST)  ·  WS client (live events)     │
└───────────────▲───────────────────────▲──────────────────────┘
                │ REST /api/*           │ ws://…/ws
┌───────────────┴───────────────────────┴──────────────────────┐
│  core/  Fastify + TypeScript (Node 20)                       │
│                                                              │
│   routes/     runs · artifacts · bible · projects · metrics  │
│   supervisor.ts  spawn claude CLI in worktree, parse         │
│                  stream-json, emit AgentEvents               │
│   events.ts      EventBus ── the B-seam: every event is      │
│                  persisted to SQLite AND pushed to WS subs   │
│   router.ts      ModelRouter ── the C-seam: route(task) →    │
│                  claude | ollama (config, not code)          │
│   github.ts      GitHubProvider ── gh CLI + polling seam     │
│   bible.ts       compile sections + live data → HTML         │
│   artifacts.ts   md store + generic md→HTML renderer         │
│   db.ts          better-sqlite3 (WAL) schema + helpers       │
└───────────────┬──────────────────────────────────────────────┘
                │ execa
        ┌───────┴────────┐        ┌──────────────┐
        │ claude CLI     │        │ gh CLI       │
        │ (agent engine) │        │ (GitHub)     │
        └────────────────┘        └──────────────┘
```

## The seams

| Seam | Interface | Today | Later |
|------|-----------|-------|-------|
| **EventBus** | `emit/onEvent/onRunUpdate` | in-process + SQLite `events` table | NATS/Redis Streams + worker processes (Phase 5) |
| **ModelRouter** | `route(task) → provider/model` | claude default, ollama stub | cost-aware routing from run-outcome data (Phase 3) |
| **GitHubProvider** | `listPRs/prStatus/ciRuns/createPR/syncIssues` | `gh` CLI + polling (Phase 1) | webhook push (only if polling lag ever hurts) |

## Tech stack

```
Monorepo (pnpm workspaces)
├── shared/   Zod schemas — single source of type truth for core + web
├── core/     Node 20 · TypeScript · Fastify · ws · better-sqlite3 · execa
└── web/      Vite · React · Tailwind · shadcn/ui · TanStack Query · Framer Motion
```

**Agent engine:** Claude Code CLI (`claude -p --output-format stream-json`) wrapped by `supervisor.ts`. Each run executes in an isolated git worktree.

**Existing building blocks (reused, not rebuilt):**

- **GitNexus** — repo indexing, knowledge graphs, impact analysis, wiki generation (graph data source, Phase 2)
- **everything-claude-code** — eval-harness, continuous-learning, skill testing (Phase 3)
- **Claude Code CLI** — agent execution, skills, hooks, MCP, permissions (Phase 0+)

## Data flow (one run)

1. `POST /api/runs` (or ⌘K dispatch) → supervisor creates a worktree, spawns the claude CLI.
2. Every stream-json line → normalized `AgentEvent` → EventBus → SQLite (immutable, replayable) + WS push (live console).
3. Run completes → status/cost roll-ups on the `runs` row → artifacts saved → (Phase 1+) PR opened via GitHubProvider → CI status polls back onto the dashboard.
