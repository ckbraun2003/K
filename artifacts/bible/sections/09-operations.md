---
title: Operations
icon: "⌘"
status: stable
updated: 2026-06-17
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

## Onboard / verify scaffold-then-commit workflow

Onboarding (`POST /api/projects/:id/onboard`) and verification (`POST /api/projects/:id/verify`) may scaffold files into the **working tree — uncommitted**: a starter `.github/workflows/ci.yml` and/or a starter bible, written for operator review rather than pushed. Nothing is committed or pushed on your behalf. After running either, inspect the proposed changes with `git status` / `git diff`, then commit manually if you accept them. The score reflects the pre-fix state; the next verify observes the now-present files.

## Troubleshooting

- **Stale worktree after a crash.** A crashed or killed run can leave a `.worktrees/<runId>` directory behind. On boot, `reconcileOnBoot` (core/src/supervisor.ts, wired in index.ts) auto-reconciles runs stuck in `running`/`queued` to `interrupted`, runs `git worktree prune`, and removes orphaned `.worktrees/*` dirs — so a simple core restart usually cleans these up. On Windows a file lock can block removal (logged, non-fatal); if a stale dir persists, close any process holding it and run `git worktree prune` manually, then delete the directory.
- **SQLite "database is locked".** `core/data/k.db` runs in WAL mode. A first boot after a new schema migration, or two core processes pointing at the same DB, can race and surface a lock. Run a single core process, and start the dev server **stopped** for the first boot after a migration (see Schema migrations). The `-wal`/`-shm` sidecar files are normal and are checkpointed automatically.
- **Port already in use.** The core binds `PORT` (default 3001) and the web dev server binds 5173. If either is taken (`EADDRINUSE`), stop the other process or change `PORT` in `core/.env` (and `CORS_ORIGIN` to match the web origin). On Windows, find the holder with `netstat -ano | findstr :3001`.

## HTTP API surface (projects + verification + runs)

Beyond the registry/metrics endpoints, the project + verification surface is:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/projects/:id/onboard` | scaffold the three §3 invariants (starter bible + CI) for whatever is missing; idempotent |
| `POST /api/projects/:id/verify` | deterministic single-shot verification → `VerificationReport`. Optional body `{ deep?: boolean }`: `deep: true` also fire-and-forgets the Layer-2 `verify-project` agent run (the deterministic report is always returned immediately) |
| `GET /api/projects/:id/verifications` | report history, newest first |
| `GET /api/runs/:id/events/:seq/raw` | lazy per-event raw stream-json (404 on missing/null-raw seq, 400 on non-numeric) |
| `GET /api/runs?status=&limit=` | server-side run filters (`status` validated; `limit` 1–500, default 100) |

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
| `core/src/scaffold.ts` | pure bible/CI scaffolders (idempotent, path-guarded) |
| `core/src/onboard.ts` | enforce the 3 §3 project invariants (delegates to the scaffolders) |
| `core/src/verify.ts` | health-score engine + auditors + `runVerification` orchestration |
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

`verification_reports.score_breakdown` (TEXT, JSON) was added via one of these
guarded idempotent ALTERs — it stores the four §5 score components (`ci`,
`coverage`, `bible`, `findings`) so the Verification tab can render per-weight
bars without recomputing. Older reports without the column still validate
(the breakdown is optional on read).

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
