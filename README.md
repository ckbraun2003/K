# K

K is a self-hosted, single-operator agentic engineering harness — a "software factory." One operator
directs AI agents to do real engineering work across a fleet of projects: managing goals, building and
maintaining code through GitHub pull requests, and running verification skills that keep the agents
honest. Everything is visible on a high-clarity dashboard.

This is a quick-start you can follow top to bottom in about five minutes. For the full reference, see
the project bible (linked at the bottom).

## Prerequisites

- **Node 20+** — runtime for core and web.
- **pnpm 10+** — package manager and workspace runner. The root `package.json` pins
  `packageManager: pnpm@10.34.2`; matching that version avoids lockfile drift.
- **`claude` CLI, authenticated** — Anthropic Claude Code. Agent runs are dispatched through it, so it
  must be installed and signed in (`claude` should work from your shell).
- **`gh` CLI, authenticated** — optional. Only needed for GitHub features (PR/CI status, cloning
  private repos). K runs fine without it for local-path projects.

## Install

```bash
pnpm install
```

Native dependencies (`better-sqlite3`, `node-pty`, `esbuild`) are built automatically — they're listed
under `onlyBuiltDependencies` in `pnpm-workspace.yaml`. No extra steps.

## Run

```bash
pnpm dev
```

This starts **both** services in parallel (via `concurrently`):

- Core API + WebSocket — http://localhost:3001
- Dashboard (web) — http://localhost:5173

Open **http://localhost:5173** in your browser. Core takes a few seconds to boot; until it's ready the
dashboard's API proxy returns a brief `503 {"error":"core starting"}`. That's by design, not an error —
the dashboard connects automatically once core is up.

To run the services separately (e.g. in two terminals):

```bash
pnpm --filter @k/core dev    # core only  → http://localhost:3001
pnpm --filter @k/web dev     # web only   → http://localhost:5173
```

## First steps in the app

Once the dashboard is open:

1. **Register a project** — point K at a local repo path or a GitHub URL.
2. **Build its knowledge graph** — index the codebase so agents can navigate and assess impact.
3. **Verify or dispatch a run** — run verification to get a health score, or press **⌘K** to dispatch
   an agent run against a goal.

The in-app Getting Started guide and the bible's user guide go deeper.

## Configuration

All configuration is optional with sane defaults — K runs out of the box for local testing. To
customize, copy the template and edit:

```bash
cp .env.example core/.env
```

The handful of vars that matter for local testing (real defaults shown):

| Variable | Default | Notes |
|----------|---------|-------|
| `HARNESS_TOKEN` | `dev-token-change-me` | Bearer token for web → core auth. **Insecure default** — fine for loopback, but change it before exposing K beyond localhost. |
| `PORT` | `3001` | Core HTTP/WS port. |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Claude model used for agent runs. |
| `RUN_PERMISSION_MODE` | `acceptEdits` | `claude --permission-mode` for worktree runs. One of `default` \| `plan` \| `acceptEdits` \| `bypassPermissions` (invalid values fall back to `acceptEdits`). `bypassPermissions` is the explicit opt-in for fully-autonomous runs. |

This is the short list. For the complete set (host binding, CORS, data dir, Ollama routing, GitHub
polling, the web terminal, etc.) see bible §09 Operations.

## Common commands

```bash
pnpm dev          # run core + web together
pnpm build        # build all workspaces
pnpm -r test      # run tests across workspaces (core + web)
pnpm typecheck    # type-check all workspaces
```

## Troubleshooting

- **Dashboard shows errors on first load.** Core is still booting — the proxy returns a brief
  `503 "core starting"` until it's ready, then the dashboard connects on its own. Give it a few seconds.
- **Port already in use (`EADDRINUSE`).** Core binds `PORT` (default 3001) and the web dev server binds
  5173. Stop the conflicting process, or change `PORT` in `core/.env` (and `CORS_ORIGIN` to match the
  web origin). On Windows: `netstat -ano | findstr :3001`.
- **SQLite "database is locked".** `core/data/k.db` runs in WAL mode. Run a single core process — two
  processes on the same DB, or a first boot right after a schema migration, can race. The `-wal`/`-shm`
  sidecar files are normal.
- **Stale worktree after a crash.** A killed run can leave a `.worktrees/<runId>` directory. A core
  restart auto-reconciles and prunes these. On Windows a file lock can block removal (logged,
  non-fatal); if one persists, close any process holding it, run `git worktree prune`, then delete it.

## Where to learn more

The living documentation is the **project bible** — a self-contained page at
`artifacts/project-bible.html`, built from the structured sources under `artifacts/bible/` and
regenerated on core startup. It's also viewable in-app under **Docs**. Start with §09 Operations for the
full configuration and operations reference.
