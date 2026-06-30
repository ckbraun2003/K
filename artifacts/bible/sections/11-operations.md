---
title: Operations
icon: "⌘"
status: stable
updated: 2026-06-27
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
HOST=127.0.0.1                        # loopback default; only set 0.0.0.0 behind Tailscale / an auth proxy (see Remote access)
HARNESS_TOKEN=                        # leave UNSET to auto-generate+persist a strong token on first run (see Remote access)
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
| Harness bearer token (first-run generated secret) | `data/auth-token` (0600, gitignored) | no |
| Shipped agent-config assets (D2) | `agent-config/` (base prompt, tier charters, vendored gitnexus skills/hook) | yes |
| Bible source | `artifacts/bible/` | no — gitignored K-system dir (same in every project) |
| Compiled bible | `artifacts/project-bible.html` | no (generated) |
| Other artifacts | `artifacts/*.md` (+ generated `.html`) | no — gitignored K-system dir |
| Task tracker | `tasks/todo.md`, `tasks/lessons.md` | no — gitignored K-system dir |
| Per-run synthesized config dir (D3) | `<dataDir>/agent-runs/<runId>/config/` | no — ephemeral, gitignored, swept on boot |
| Run worktrees | git worktrees, pruned after run | no |
| Cloned workspaces | workspace/ | no |

`artifacts/` and `tasks/` are **K-system directories** — the same hidden, gitignored names in every
managed project (`onboard.ts ensureGitignore` adds them); bibles scaffold into `artifacts/bible/`.
K's own bible therefore lives on-disk as a living spec and is **not** under version control.

## Bible workflow

- Edit a section under `artifacts/bible/sections/` (update its `updated:` frontmatter).
- Recompile: restart core, or `POST /api/bible/compile` (bearer auth), or wait for the next startup.
- The compiled HTML is self-contained — open it directly in a browser or via the dashboard Docs view.
- Registered projects follow the same flow with `<repo>/docs/bible/`.

## Onboard / verify scaffold-then-commit workflow

Onboarding (`POST /api/projects/:id/onboard`) and verification (`POST /api/projects/:id/verify`) may scaffold files into the **working tree — uncommitted**: a starter `.github/workflows/ci.yml` and/or a starter bible, written for operator review rather than pushed. Nothing is committed or pushed on your behalf. After running either, inspect the proposed changes with `git status` / `git diff`, then commit manually if you accept them. The score reflects the pre-fix state; the next verify observes the now-present files.

## Host cleanup

Because K vendors what it needs (gitnexus skills/hook into `agent-config/`) and synthesizes a
per-run config dir, the host `~/.claude` is only ever *invoked*, never depended on.
`scripts/host-cleanup.mjs` reconciles a developer's host install toward that posture: it is
**dry-run by default** (prints what it would do), and `--apply` backs up first, then removes only
what K now owns. It is deliberately **conservative** — personal plugins (superpowers / ecc / ui-ux)
are left intact and the action is reversible.

## Remote access (exposing K beyond localhost)

K defaults to a **loopback-only** posture (`HOST=127.0.0.1`). Exposing it on a
network requires an authentication layer in front of it — never expose the raw
port to the open internet.

**Token resolution (every boot).** The harness bearer token is resolved in this
order:

1. `HARNESS_TOKEN` env, if set and non-empty (operator override).
2. A persisted token at `data/auth-token` (gitignored, `0600` where the FS
   honours it), if present.
3. Otherwise a **first run**: a cryptographically strong token
   (`crypto.randomBytes(32)`, base64url) is generated, persisted to
   `data/auth-token`, and printed **once** in a prominent setup banner. Copy it
   then — subsequent boots only print a masked confirmation (last 4 chars) and
   the file path, never the full token.

There is no insecure hard-coded production default. (`pnpm dev` seeds the
well-known `dev-token-change-me` via `core/dev-env.mjs` purely for loopback
ergonomics — it is never on the `pnpm start` / production path.)

**Safety gate.** If `HOST` is non-loopback (anything but `127.0.0.1` / `::1` /
`localhost`) **and** the effective token is empty or the legacy weak literal,
core **refuses to start** with an actionable error. Fix it by setting a strong
`HARNESS_TOKEN` (e.g. `openssl rand -base64 32`) or by removing the override so a
strong token is generated.

**Recommended exposure.** Put an authenticating layer in front and keep core on
loopback wherever possible:

- **Tailscale (preferred).** Join the host to your tailnet and reach K at its
  Tailscale IP/MagicDNS name; leave `HOST=127.0.0.1` and bind Tailscale's
  userspace proxy, or set `HOST` to the tailnet interface. Access is then gated
  by your tailnet ACLs *and* the harness token.
- **Authenticating HTTPS reverse proxy** (Caddy/nginx/Cloudflare Access) doing
  TLS termination + its own auth, proxying to loopback core. Only then is
  `HOST=0.0.0.0` acceptable, and only bound to the proxy's interface.

**Dashboard auth.** The browser can't send an `Authorization` header on the WS
upgrade, so the main `/ws` event gateway authenticates a `?token=` query param
(constant-time compared) and closes unauthenticated sockets with code `4401`
before subscribing them to the event bus. On loopback dev the dashboard uses the
dev token transparently (no login). Accessed remotely, a REST `401` triggers a
**login screen**: paste the harness token; it is stored in `sessionStorage` and
attached to subsequent REST (`Authorization: Bearer …`) and WS (`?token=…`)
calls. The real token is **never** baked into the built bundle — only the
loopback-only dev token is.

## Troubleshooting

- **Stale worktree after a crash.** A crashed or killed run can leave a `.worktrees/<runId>` directory behind. On boot, `reconcileOnBoot` (core/src/supervisor.ts, wired in index.ts) auto-reconciles runs stuck in `running`/`queued` to `interrupted`, runs `git worktree prune`, and removes orphaned `.worktrees/*` dirs — so a simple core restart usually cleans these up. On Windows a file lock can block removal (logged, non-fatal); if a stale dir persists, close any process holding it and run `git worktree prune` manually, then delete the directory.
- **SQLite "database is locked".** `core/data/k.db` runs in WAL mode. A first boot after a new schema migration, or two core processes pointing at the same DB, can race and surface a lock. Run a single core process, and start the dev server **stopped** for the first boot after a migration (see Schema migrations). The `-wal`/`-shm` sidecar files are normal and are checkpointed automatically.
- **Port already in use.** The core binds `PORT` (default 3001) and the web dev server binds 5173. If either is taken (`EADDRINUSE`), stop the other process or change `PORT` in `core/.env` (and `CORS_ORIGIN` to match the web origin). On Windows, find the holder with `netstat -ano | findstr :3001`.

## HTTP API surface (projects + verification + runs)

Beyond the registry/metrics endpoints, the project + verification surface is:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/projects/:id/onboard` | scaffold the three §05 invariants (starter bible + CI) for whatever is missing; idempotent |
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
| `core/src/agent-config.ts` | `synthesizeConfigDir` — builds the per-run `CLAUDE_CONFIG_DIR` (settings, allowlist, MCP, vendored skills, injected L0+L1 prompt) so host `~/.claude` never loads |
| `core/src/profiles.ts` | `AgentProfile` registry + the single default `controller` profile (pre-Phase-5 bridge) |
| `core/src/claude-args.ts` | pure: resolve `RUN_PERMISSION_MODE` + build claude CLI argv (worktree-gated `--permission-mode`, per-tier `--allowedTools`, `--mcp-config`/`--strict-mcp-config`) |
| `core/src/auth.ts` | token resolution/persistence (`resolveHarnessToken`), safety gate (`unsafeBootReason`), constant-time compare (`tokensEqual`/`wsTokenOk`), and `isAuthExempt(url)` pathname exemption (decodes once, no dot-segment bypass) |
| `core/src/project-match.ts` | pure: `matchProjectByCwd` — deepest-root prefix match for run→project inference |
| `core/src/bible.ts` | bible compiler (sections + live data → HTML) |
| `core/src/artifacts.ts` | generic artifact store + md→HTML |
| `core/src/index.ts` | Fastify bootstrap + WS gateway |
| `core/src/github.ts` | GitHubProvider — gh CLI, cache, poller |
| `core/src/projects.ts` | project registry (register/clone) |
| `core/src/scaffold.ts` | pure bible/CI scaffolders (idempotent, path-guarded) |
| `core/src/onboard.ts` | enforce the 3 §05 project invariants (delegates to the scaffolders) |
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
guarded idempotent ALTERs — it stores the four §07 score components (`ci`,
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

- `/health` is auth-exempt **by design** (a liveness probe; no sensitive data).
- The main `/ws` event gateway is **authenticated** (Phase 4): exempt from the
  header hook (a browser WS can't send one) but its handler validates a
  `?token=` query param with a constant-time compare and closes unauthenticated
  sockets with code `4401` before subscribing them. `/ws/terminal` keeps its own
  scoped `TERMINAL_TOKEN` gate (default-off feature).
- Setting `HOST=0.0.0.0` is still only safe **behind** Tailscale or an
  authenticating HTTPS reverse proxy (see Remote access). The non-loopback safety
  gate prevents booting that posture with a weak/empty token.

## Phase 5 — Agent Organization (PLANNED storage / env / key files)

None of the following exists yet; it is recorded here so the operational surface of the agent org
(§03, §04) is planned, not discovered. All new SQLite tables follow the existing guarded-ALTER
migration discipline above.

**New tables (planned).**

| Table | Holds |
|-------|-------|
| `agent_profiles` | one row per durable tier (K · Chief · each lead): `tier`, `charter`, `default_model`, `allowed_tools` (JSON), `mcp_servers` (JSON), `skills` (JSON) |
| `agent_memory` | per-profile lessons (layer A): `profile_id`, `lesson`, `status` (`pending`/`approved`/`rejected`), `source_run_id`, `created_at` — the gated-reflection store |
| `workflow_definitions` | named workflows: `name`, `roles` (JSON), `prompt_scaffold`, `cross_project` — generalizing today's single `buildDelegationPrompt` |
| `work_items` | unified scoped task store (replaces the `agent_tasks` / `project_tasks` split): `scope` (`personal`/`org`/`project`), `text`, `status`, `project_id` (set iff `scope='project'`), `created_at` |

**New env (planned).** Per-tier MCP server endpoints/toggles (`LOGISTICS_MCP_*`, `MGMT_MCP_*`,
status-write MCP), the Google connector credentials K mounts (Calendar/Gmail/Drive), and a flag for
K's hybrid idle-timeout (when an idle K session is torn down and re-seeded on the next message/wake).

**New key files (planned).**

| File | Purpose |
|------|---------|
| `core/src/profiles.ts` | `AgentProfile` registry + `startAgentRun` (generalizes `startRun`) |
| `core/src/authority.ts` | tier → allowed tools/skills/MCPs resolution; the `--allowedTools` allowlist + MCP mount gating |
| `core/src/memory.ts` | layer-A lessons store + gated end-of-run reflection (propose → approve) |
| `core/src/workflows.ts` | extended from the single delegation loop to named `WorkflowDefinition`s |
