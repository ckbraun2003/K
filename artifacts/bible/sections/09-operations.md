---
title: Operations
icon: "⌘"
status: stable
updated: 2026-06-10
---

## Running locally

```bash
# Prerequisites: Node 20, pnpm 10, claude CLI authenticated, gh CLI authenticated
pnpm install

pnpm --filter @k/core dev    # core API + WS  → http://localhost:3001
pnpm --filter @k/web dev     # dashboard      → http://localhost:5173
pnpm dev                     # both in parallel
```

## Environment (`core/.env`)

```
PORT=3001
HARNESS_TOKEN=dev-token-change-me     # bearer token (Phase 1: passkey/TOTP)
CORS_ORIGIN=http://localhost:5173
CLAUDE_MODEL=claude-sonnet-4-6
ENABLE_OLLAMA=false
```

## Data locations

| What | Where | Versioned |
|------|-------|-----------|
| SQLite (runs, events, artifacts, projects, verification) | `core/data/k.db` (WAL) | no |
| Bible source | `artifacts/bible/` | yes |
| Compiled bible | `artifacts/project-bible.html` | no (generated) |
| Other artifacts | `artifacts/*.md` (+ generated `.html`) | md yes / html no |
| Run worktrees | git worktrees, pruned after run | no |

## Bible workflow

- Edit a section under `artifacts/bible/sections/` (update its `updated:` frontmatter).
- Recompile: restart core, or `POST /api/bible/compile` (bearer auth), or wait for the next startup.
- The compiled HTML is self-contained — open it directly in a browser or via the dashboard Docs view.
- Registered projects follow the same flow with `<repo>/docs/bible/`.

## Key files

| File | Purpose |
|------|---------|
| `shared/src/types.ts` | canonical Zod schemas (Run, AgentEvent, Artifact, Project, VerificationReport, WsMessage) |
| `core/src/db.ts` | SQLite schema + prepared-statement helpers |
| `core/src/events.ts` | EventBus — the B-seam |
| `core/src/router.ts` | ModelRouter — the model seam |
| `core/src/supervisor.ts` | agent lifecycle: worktree + spawn + parse + emit |
| `core/src/bible.ts` | bible compiler (sections + live data → HTML) |
| `core/src/artifacts.ts` | generic artifact store + md→HTML |
| `core/src/index.ts` | Fastify bootstrap + WS gateway |
| `artifacts/bible/` | this document's source |
