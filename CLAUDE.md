# K — Project Guide

How to develop **K** itself. This is the L2 project file: both a contributor's Claude Code
session and a K-managed agent working on the K repo read it. It is **not** the operating
prompt for managed runs — see "Agent operating prompt" below.

## What K is

A self-hosted agentic engineering harness. **Architecture A with B-seams**: one monolithic
`core` with three swappable interfaces — `EventBus` (events), `ModelRouter` (model choice),
`GitHubProvider` (GitHub) — so transport/model/GitHub can scale out later without a rewrite.
The agent engine is the **Claude Code CLI**, spawned per run (worktree + `stream-json`) by
`core/src/supervisor.ts`. Full design: `artifacts/bible/sections/02-architecture.md`.

## Stack & layout

pnpm monorepo, TypeScript ESM:

| Package | Stack | Role |
|---------|-------|------|
| `shared/` | Zod | **Single type source** — schemas in `shared/src/types.ts` |
| `core/` | Node 20 · Fastify · ws · better-sqlite3 · execa | API + WS + agent supervisor |
| `web/` | Vite · React · Tailwind · shadcn/ui · TanStack Query | the Command Deck dashboard |

## How to run

```bash
pnpm install
pnpm --filter @k/core dev     # core API + WS  → http://localhost:3001
pnpm --filter @k/web dev      # dashboard      → http://localhost:5173
pnpm dev                      # both in parallel

pnpm typecheck                # tsc across all packages
pnpm -r test                  # vitest across all packages
pnpm build                    # build all packages
```

Prereqs: Node 20, pnpm 10, `claude` CLI authenticated, `gh` CLI authenticated. Env lives in
`core/.env` (see `artifacts/bible/sections/11-operations.md`).

## Module map (`core/src/`)

| File | Purpose |
|------|---------|
| `supervisor.ts` | agent lifecycle: worktree + spawn claude CLI + parse stream-json + emit |
| `events.ts` | `EventBus` B-seam (persist to SQLite + push to WS) |
| `router.ts` | `ModelRouter` B-seam (cost-aware route → claude \| ollama) |
| `providers.ts` | how a routed provider is dispatched (binary, argv, NDJSON parse) |
| `claude-args.ts` | pure: resolve permission mode + build claude CLI argv |
| `agent-config.ts` | per-run config-dir synthesizer (injects L0+L1 — see below) |
| `db.ts` | better-sqlite3 (WAL) schema + prepared-statement helpers |
| `bible.ts` | bible compiler (sections + live data → HTML) |
| `github.ts` | `GitHubProvider` B-seam (gh CLI + cache + poller) |
| `verify.ts` | health-score engine + auditors + `runVerification` |

Full file list: `artifacts/bible/sections/11-operations.md` ("Key files").

## Conventions

- **LF** line endings; **ESM** — use `.js` import specifiers in TS source.
- `shared/src/types.ts` Zod schemas are the **single source of type truth** for core + web.
- Harness working files: `tasks/todo.md` (active tracker) + `tasks/lessons.md` (corrections).
- Bible **source** is `artifacts/bible/sections/` (edit the markdown; never the compiled HTML).
- CI runs `pnpm typecheck → pnpm -r test → pnpm build` — keep all three green.

## Agent operating prompt — NOT this file

The operating prompt injected into **K-managed agent runs** is *not* `CLAUDE.md`. It is layered:

- **L0** — `agent-config/base-operating-prompt.md` (K-owned global ruleset: planning,
  delegation, verification, tone).
- **L1** — `agent-config/tiers/<tier>.charter.md` (per-tier charter).

`core/src/agent-config.ts` materializes **L0 + L1** into each run's ephemeral config dir at
spawn. **To change how managed agents behave, edit those files — not this one.** The dashboard
"Global system prompt" editor edits the L0 file (`agent-config/base-operating-prompt.md`).

## AGENTS.md

`AGENTS.md` is the same project guidance for non-Claude tools — it mirrors this file, is
gitignored / locally generated, and also carries the GitNexus code-intelligence block.
