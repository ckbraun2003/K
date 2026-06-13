---
title: Operations
icon: "⌘"
status: stable
updated: 2026-06-12
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
HOST=127.0.0.1                        # loopback default; 0.0.0.0 exposes on network (see Accepted risks)
HARNESS_TOKEN=dev-token-change-me     # bearer token (Phase 1: passkey/TOTP)
CORS_ORIGIN=http://localhost:5173
CLAUDE_MODEL=claude-sonnet-4-6
RUN_PERMISSION_MODE=acceptEdits       # claude --permission-mode for worktree runs; default acceptEdits.
                                      #   one of default|plan|acceptEdits|bypassPermissions (invalid → acceptEdits + warn).
                                      #   only applied inside a disposable worktree; fallback-to-cwd runs stay default-restricted.
                                      #   bypassPermissions (allows Bash etc.) is explicit opt-in for fully-autonomous runs.
ENABLE_OLLAMA=false
GITHUB_POLL_MS=60000                  # gh polling interval
ENABLE_GITHUB_POLL=true               # set false to disable
```

## Data locations

| What | Where | Versioned |
|------|-------|-----------|
| SQLite (runs, events, artifacts, projects, verification) | `core/data/k.db` (WAL) | no |
| Bible source | `artifacts/bible/` | yes |
| Compiled bible | `artifacts/project-bible.html` | no (generated) |
| Other artifacts | `artifacts/*.md` (+ generated `.html`) | md yes / html no |
| Run worktrees | git worktrees, pruned after run | no |
| Cloned workspaces | workspace/ | no |

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
| `core/src/claude-args.ts` | pure: resolve `RUN_PERMISSION_MODE` + build claude CLI argv (worktree-gated `--permission-mode`) |
| `core/src/auth.ts` | pure: `isAuthExempt(url)` — pathname-based auth exemption (decodes once, no dot-segment bypass) |
| `core/src/project-match.ts` | pure: `matchProjectByCwd` — deepest-root prefix match for run→project inference |
| `core/src/bible.ts` | bible compiler (sections + live data → HTML) |
| `core/src/artifacts.ts` | generic artifact store + md→HTML |
| `core/src/index.ts` | Fastify bootstrap + WS gateway |
| `core/src/github.ts` | GitHubProvider — gh CLI, cache, poller |
| `core/src/projects.ts` | project registry (register/clone) |
| `core/src/metrics.ts` | metrics summary + `buildTimeseries` (day × project\|model, top-8 + other) |
| `artifacts/bible/` | this document's source |

## Schema migrations

`db.ts` uses `CREATE TABLE IF NOT EXISTS` for fresh installs, plus an exported,
idempotent `migrate(d)` run at every boot for existing DBs. New columns are added
with **guarded ALTERs** — a `pragma table_info` check (`hasColumn`) before each
`ALTER TABLE … ADD COLUMN`, so re-running is a no-op. Indexes that depend on a
migrated column are created inside `migrate()` (after the ALTER), never in the
main DDL block. Migrated DBs append columns at the end, so column **order** can
differ from a fresh install — always reference columns by name. `migrate(d)` is
exported so tests can run it against an old-schema temp DB. First boot after a
new migration: run with the dev server stopped to avoid a concurrent-migration race.

## Continuous integration

`.github/workflows/ci.yml` runs on push to `main`/`feat/**`/`fix/**` and PRs to
`main` (concurrency-cancel, `contents: read`). Steps on ubuntu-latest / Node 20:
`pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm -r test` →
`pnpm build`. Root `package.json` pins `packageManager: pnpm@<version>` so
`pnpm/action-setup` matches the local toolchain. `better-sqlite3` uses Node-20
prebuilds. `gh` CLI is absent locally — check CI status via the GitHub web UI or
the REST API with a `git credential` token.

## Accepted risks

- `/ws` and `/health` are auth-exempt **by design** for the localhost posture
  (`HOST=127.0.0.1` default). The WS gateway streams run events to anyone who
  can reach the port. **First thing to close if HOST is ever set to 0.0.0.0**
  — add token auth to the WS upgrade before exposing on a network.
