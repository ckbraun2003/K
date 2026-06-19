---
title: Architecture
icon: "⬡"
status: stable
updated: 2026-06-18
---

**Architecture A with B-seams** — a single monolithic core (Architecture A) with three deliberate **B-seams** built in from day one (decision D-001): EventBus, ModelRouter, and GitHubProvider. Each B-seam is a clean interface that lets the transport, model, or GitHub layer be swapped or scaled out later without a rewrite. "B-seam" is the one canonical term — there is no separate "C-seam" (legacy code comments that said so are being corrected).

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
│   events.ts      EventBus ── a B-seam: every event is        │
│                  persisted to SQLite AND pushed to WS subs   │
│   router.ts      ModelRouter ── a B-seam: route(task) →      │
│                  claude | ollama (config, not code)          │
│   github.ts      GitHubProvider ── a B-seam: gh CLI + poll   │
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

## The three B-seams

| B-seam | Interface | Today | Later |
|------|-----------|-------|-------|
| **EventBus** | `emit/onEvent/onRunUpdate` | in-process + SQLite `events` table | NATS/Redis Streams + worker processes (Phase 5) |
| **ModelRouter** | `route(task) → provider/model` | cost-aware routing across claude + ollama (Phase 3) | learned routing from accumulated run-outcome data (Phase 5) |
| **GitHubProvider** | `listPRs/prStatus/ciRuns/createPR/syncIssues` | `gh` CLI + polling (Phase 1) | webhook push (only if polling lag ever hurts) |

### ModelRouter — cost-aware routing (Phase 3)

`route(task) → { provider, model, baseUrl? }` is the single decision point; `providers.ts`
owns *how* a chosen provider is dispatched (binary, argv, NDJSON parsing). Two providers exist:
`claudeProvider` (the agent engine) and `ollamaProvider` (local models). Routing inputs:

- **Task hints** — `preferLocal` (route to Ollama when available) and `maxCostUsd` (prefer a
  cheaper model when the cap is tight).
- **Run-outcome data** — cost, latency, and success rate aggregated per provider+model from the
  `runs`/`events` tables. The router favours the cheapest provider/model that has historically
  succeeded for similar work.

**Graceful-degradation contract:** Ollama is optional. If `ENABLE_OLLAMA` is unset, or the
Ollama binary/endpoint is unreachable, the router falls back to `claudeProvider` and logs a
warning — a routing decision can never make a run *fail* for lack of a local model (the same
posture the GitHub poller takes when `gh` is absent). The supervisor dispatches strictly on the
routed provider's name, so choosing "ollama" can never silently run claude, and vice-versa.

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
