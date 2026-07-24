---
title: Operations
icon: "⌘"
status: stable
updated: 2026-07-24
---

## Running locally

```bash
# Prerequisites: Node 20, pnpm 10, claude CLI authenticated, gh CLI authenticated
pnpm install

pnpm --filter @k/core dev    # core API + WS  → http://localhost:3001
pnpm --filter @k/web dev     # dashboard      → http://localhost:5173
pnpm dev                     # both in parallel
```

### Dev-stack hygiene

- `pnpm --filter @k/core dev` is **non-watch by default** (F4) — one boot, no auto-restart on file
  save. Hot-restart-on-save is opt-in: `pnpm --filter @k/core dev:watch`.
- Never leave a dev stack (watched or not) running across a `git merge`/rebase, or while hand-editing
  schema/migrations in `core/src/db.ts` — an in-place restart can boot mid-edit and stamp a schema
  version before its migration exists (see the poisoned-stamp incident under Schema migrations).
- Before merging anything that touches `core/src/db.ts`, run `pnpm smoke:upgrade`
  (`core/scripts/upgrade-smoke.mjs`) — it copies the real dev DB to a temp dir, boots the merged core
  against the copy on port 3299 (override: `K_SMOKE_PORT`), and polls `/api/runs` + `/api/profiles`,
  proving the **upgrade** path boots (not just a fresh install).
- `pnpm --filter @k/core seed:review-demo` — dev-only 3-file checkpoint-diff fixture (BE-6): seeds a
  throwaway `seed-review-demo` project + a completed run with a real 2-wave k-checkpoint chain so the
  Changes surface / DiffViewer renders a genuine multi-file diff without paying for a dispatch.
  Idempotent (re-run replaces); never runs at boot.

## Environment (`core/.env`)

```
PORT=3001
HOST=127.0.0.1                        # loopback default; only set 0.0.0.0 behind Tailscale / an auth proxy (see Remote access)
HARNESS_TOKEN=                        # leave UNSET to auto-generate+persist a strong token on first run (see Remote access)
CORS_ORIGIN=http://localhost:5173
CLAUDE_MODEL=claude-sonnet-4-6        # first-run SEED for the runtime Claude default (now app_config-managed — change it in Settings, no restart)
RUN_PERMISSION_MODE=acceptEdits       # claude --permission-mode for worktree runs; default acceptEdits.
                                      #   one of default|plan|acceptEdits|bypassPermissions (invalid → acceptEdits + warn).
                                      #   only applied inside a disposable worktree; fallback-to-cwd runs stay default-restricted.
                                      #   bypassPermissions (allows Bash etc.) is explicit opt-in for fully-autonomous runs.
ENABLE_OLLAMA=false
GITHUB_POLL_MS=60000                  # gh polling interval
ENABLE_GITHUB_POLL=true               # set false to disable
```

### Runtime config (no restart)

Several values above are now first-run **seeds**, not frozen constants. The **Claude default model**
(`CLAUDE_MODEL`), the **Ollama** enable / base-url / active-model, and the **voice** settings are
persisted in the `app_config` table and editable live from **Settings** — a change applies to the very
next run without touching `.env` or restarting core. Each env var is consulted only when `app_config`
has no stored value for its key (seed-then-override; `config-store.ts`). This retires the earlier
recon finding that the Claude default model was an env-frozen `const` read once at `router.ts` load.

## Data locations

| What | Where | Versioned |
|------|-------|-----------|
| SQLite (runs, events, artifacts, projects, verification) | `data/k.db` (WAL) | no |
| Harness bearer token (first-run generated secret) | `data/auth-token` (0600, gitignored) | no |
| Shipped agent-config assets (D2) | `agent-config/` (base prompt, tier charters, vendored gitnexus skills/hook) | yes |
| Bible source | `artifacts/bible/` | **K's own repo: yes — tracked** (manifest + sections are the living spec, edited by the section editor). Managed projects: gitignored by the onboard scaffold |
| Compiled bible | `artifacts/project-bible.html` | **yes — tracked** (recompiled on request/merge and committed alongside section edits; tracked since e903f5c) |
| Other artifacts | `artifacts/*.md` (+ generated `.html`) | mixed — K's own `ui-demo.html` is tracked (boot-regenerated, deterministic); scratch `.md` artifacts and scanned loose HTML are working files, not deliverables |
| Task tracker | `tasks/todo.md`, `tasks/lessons.md` | no — gitignored K-system dir |
| Per-run synthesized config dir (D3) | `<dataDir>/agent-runs/<runId>/config/` | no — ephemeral, gitignored, swept on boot |
| Run worktrees | `.worktrees/<runId>` git worktrees, pruned after run | no — `.worktrees/` gitignored (P5.7) |
| Cloned workspaces | workspace/ | no |

`artifacts/` and `tasks/` are **K-system directories** in *managed projects* — `onboard.ts
ensureGitignore` hides them there so agent scratch output never dirties a project's history. K's
OWN repo is the exception by design: the bible sources, the compiled `project-bible.html`, and
`ui-demo.html` are **git-tracked deliverables** (this section, its HTML, and the demo ship with
the repo), while `tasks/` stays untracked. When in doubt, `git ls-files artifacts/` is the truth.

**`data/k.db` is a dev database** — disposable test/dev data only, never personal data; the only
registered project is the K repo itself (`jarvis-core` → the repo root). Treat it as expendable: if
it needs wiping to recover from a bad state, wipe it.

## Bible workflow

- Edit a section under `artifacts/bible/sections/` (update its `updated:` frontmatter).
- Recompile: restart core, or `POST /api/bible/compile` (bearer auth), or wait for the next startup.
- The compiled HTML is self-contained — open it directly in a browser or via the dashboard Docs view.
- Registered projects follow the same flow with `<repo>/docs/bible/`.
- **In-dashboard editing is per-SECTION (D-065).** The Bible/Artifacts tab edits one section at a
  time; Save (`PUT /api/artifacts/:slug/sections/:sectionSlug`, `saveBibleSection`) writes the edited
  body back to that `sections/<slug>.md` **source** (frontmatter preserved) then recompiles — so the
  edit IS the source and survives every recompile. Editing the *combined* markdown of a bible slug is
  rejected (`400` → the section editor), and a project-bible save stays in the project's own dir
  (never K's `ARTIFACTS_DIR`, never clobbering the row's `html_path`).
- **Artifact scan (D-117, model in §05).** Loose top-level `<localPath>/artifacts/*.html` an agent
  drops mid-run are registered as `origin='scanned'` gallery entries by `core/src/artifact-scan.ts` —
  automatically when one of the project's runs reaches terminal, and on demand via the Artifacts tab's
  **Refresh from disk** button (`POST /api/projects/:id/artifacts/scan`). The scan is
  `isPathWithin`-guarded and idempotent; it never touches `origin='compiled'` rows (the bible /
  `ui-demo`), so a Refresh can only ever add/remove *scanned* rows, never disturb a compiled deliverable.

## Onboard / verify scaffold-then-commit workflow

Onboarding (`POST /api/projects/:id/onboard`) and verification (`POST /api/projects/:id/verify`) may scaffold files into the **working tree — uncommitted**: a starter `.github/workflows/ci.yml` and/or a starter bible, written for operator review rather than pushed. Nothing is committed or pushed on your behalf. After running either, inspect the proposed changes with `git status` / `git diff`, then commit manually if you accept them. The score reflects the pre-fix state; the next verify observes the now-present files.

## Host cleanup

Because K vendors what it needs (gitnexus skills/hook into `agent-config/`) and synthesizes a
per-run config dir, the host `~/.claude` is only ever *invoked*, never depended on.
`scripts/host-cleanup.mjs` reconciles a developer's host install toward that posture: it is
**dry-run by default** (prints what it would do), and `--apply` backs up first, then removes only
what K now owns. It is deliberately **conservative** — personal plugins (superpowers / ecc / ui-ux)
are left intact and the action is reversible.

## Host capability catalog — rescan, trust, probe (D-069/D-070)

- **Every boot** (first boot included), after `seedBuiltinSkills`, a **guarded host scan**
  (`syncHostDiscovery`) refreshes the capability catalog from the host layer — user / project /
  plugin skills + host MCP servers — and logs one summary line
  (`[discovery] host capability scan: skills +a ~b -c, mcp +x ~y -z`). The scan is
  try/catch-warned so a broken host install never bricks boot, and a malformed host artifact
  (unreadable dir, bad SKILL.md, non-stdio server) becomes a structured warning, never a throw.
  Everything discovered lands **default-disabled**.
- **Rescan on demand:** `POST /api/capabilities/rescan` (the Skills-page **Rescan** button) →
  `200` + a `RescanResult`, and a `capabilities_update` WS broadcast. A rescan upserts by
  qualified key, **never touches your enable overlay**, flags vanished assets `status='missing'`
  (fail-closed at PATCH and synth), and **auto-disables** an MCP server whose host config drifted.
- **Discovery warnings** surface in the rescan response `warnings[]` and the Skills-page banner —
  read them; a skipped source is invisible in the catalog until fixed.
- **Granting trust:** before **Trust & enable** on a discovered MCP server, review the command,
  args, and env **names** the TrustDialog shows — trusting a server authorizes code execution
  inside every run that mounts it. Trust pins the config hash; a host-side config change
  auto-disables + clears trust (re-review to re-enable). Env **values** never leave core.
- **Probe** (`POST /api/capabilities/mcp/:id/probe`) is explicit-request-only, against
  enabled+trusted servers: a real MCP `initialize` + `tools/list` with a 15s hard timeout.
  Failure → `502` + `probe_status='failed'` — it never disables the server.
- **Token estimates are estimates:** `ceil(chars/4)`, ±25% (`core/src/token-estimate.ts` is the
  one swap seam) — relative UX signals, never billed figures. An MCP server's estimate is null
  until probed.

## Local-model agent runtime (D-072)

Ollama-routed runs execute K's in-process tool loop by default (§02). Its knobs:

| Var / config key | Default | Meaning |
|------------------|---------|---------|
| `K_OLLAMA_AGENT_MODE` | *(unset)* | `legacy` reverts ollama runs to the old `ollama run` prompt pipe (no tools/MCP) |
| `K_OLLAMA_FS_SCOPE` | *(worktree)* | `any` widens the native tools' fs guard from the run worktree to the whole filesystem |
| `K_OLLAMA_NUM_CTX` → `ollama.numCtx` | `16384` | the explicit `num_ctx` sent per chat call; the env var is the first-run **seed** for the `app_config` key `ollama.numCtx` (runtime-editable, seed-then-override like the other runtime config) |

Built-in limits (constants, not env): 25 iterations, 10-minute run timeout, 60s per MCP tool call,
a repeated-identical-call detector, and a context-pressure warning above 85% of the model's shown
context length.

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
calls. The real token is **never** baked into the built bundle, and since W10a
(D-066) even the loopback-only dev harness token is emitted only under
`vite serve` — a **prod build ships none**.

## Security hardening — host credentials (W10a, D-066)

The built-in browser terminal's own defense-in-depth hardening (F-084 — a scrubbed
`process.env` denylist stripping `*_TOKEN`/`*_KEY`/`*_SECRET`/`*_PASSWORD`/connection-string vars
from the shell it spawned, a dev-gated `VITE_TERMINAL_TOKEN` never baked into a prod bundle, and an
opt-in-only remote `TERMINAL_ALLOW_REMOTE` gate) was retired along with the terminal feature itself
in UI Adjustments Round 3 (D-134, 2026-07-22) — see the roadmap's 3-6 entry for the shipped history.
What remains of W10a is host-credential hardening:

**Credential posture is surfaced + opt-out-able (F-064/F-090).** The agent-engine boundary (§02) uses
a K-token-first auth with a guarded host-credential dogfooding fallback (D-027). That fallback is now
**visible**: `credentialPosture()` reports one of `managed` (a managed `ANTHROPIC_API_KEY` /
`CLAUDE_CODE_OAUTH_TOKEN` is set) · `host-fallback` (no managed token, fallback ON — runs copy host
creds) · `disabled`, surfaced on **`/api/status`**, the **Settings** auth card, and a **one-line boot
summary** (never the secret itself), so silent host-credential use is no longer invisible. Setting
**`K_DISABLE_HOST_CREDENTIAL_FALLBACK=true`** opts a deployment **out** — a run with no managed token
is left unauthenticated rather than silently copying host credentials. The **default (no flag) is
unchanged** — OOTB dogfooding is byte-identical; the fallback copy stays `chmod 0600` under the
gitignored data dir.

## Troubleshooting

- **Stale worktree after a crash.** A crashed or killed run can leave a `.worktrees/<runId>` directory behind. On boot, `reconcileOnBoot` (core/src/supervisor.ts, wired in index.ts) auto-reconciles runs stuck in `running`/`queued` to `interrupted`, removes orphaned `.worktrees/*` dirs, **then** runs `git worktree prune` — the prune runs **after** dir removal (W10b/F-091) so a crash-orphaned worktree's metadata is reclaimed the same boot. On Windows, `removeWorktree` retries an `EBUSY` (3× backoff) before a best-effort swallow (the happy path adds no delay); a file lock that still blocks removal is logged non-fatal — if a stale dir persists, close any process holding it and run `git worktree prune` manually, then delete the directory.
- **SQLite "database is locked".** `data/k.db` runs in WAL mode. A first boot after a new schema migration, or two core processes pointing at the same DB, can race and surface a lock. Run a single core process, and start the dev server **stopped** for the first boot after a migration (see Schema migrations). The `-wal`/`-shm` sidecar files are normal and are checkpointed automatically.
- **Port already in use.** The core binds `PORT` (default 3001) and the web dev server binds 5173. If either is taken (`EADDRINUSE`), stop the other process or change `PORT` in `core/.env` (and `CORS_ORIGIN` to match the web origin). On Windows, find the holder with `netstat -ano | findstr :3001`.
- **A registered project's folder was moved/deleted.** The GitHub poller **skips** a project whose `localPath` no longer exists instead of erroring every cycle (one warn per boot per project; the row is never deleted or mutated), and the read surface stamps an additive `Project.pathMissing` so the UI can say why (P5.7, D-058). Re-register or restore the path to resume polling.

## HTTP API surface (projects + verification + runs)

Beyond the registry/metrics endpoints, the project + verification surface is:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/projects/:id/onboard` | scaffold the three §05 invariants (starter bible + CI) for whatever is missing; idempotent |
| `POST /api/projects/:id/verify` | deterministic single-shot verification → `VerificationReport`. Optional body `{ deep?: boolean }`: `deep: true` also fire-and-forgets the Layer-2 `verify-project` agent run (the deterministic report is always returned immediately) |
| `GET /api/projects/:id/verifications` | report history, newest first |
| `GET /api/runs/:id/events/:seq/raw` | lazy per-event raw stream-json (404 on missing/null-raw seq, 400 on non-numeric) |
| `GET /api/runs?status=&limit=` | server-side run filters (`status` validated; `limit` 1–500, default 100) |
| `GET /api/profiles[/:id]` | **read-only** (W2, F-020) — exposes K / Chief / leads for inspection with **no write path**, so the authority ceiling stays intact |

**API robustness (W2, F-015..F-028/F-074).** The whole surface now shares one **error envelope** —
`error` is **always a string** (`sendError` / `sendZodError`), fixing the UI's `[object Object]` on a
validation error — and a consistent **validate-body (`400`) → then existence (`404`)** ordering, so
`kill` / `events` on a nonexistent run `404` (were `200`) and a validation rejection names the
offending field. `GET /api/chief/org` includes the **K node** above the Chief (F-023 — the full
user → K → Chief → leads tree), and `workflow_runs` gained a `workflow_id` FK (guarded ALTER,
`SCHEMA_VERSION 3→4`) so a run is traceable to the definition it ran.

## Key files

| File | Purpose |
|------|---------|
| `shared/src/types.ts` | canonical Zod schemas (Run, AgentEvent, Artifact, Project, VerificationReport, WsMessage) |
| `core/src/db.ts` | SQLite schema + prepared-statement helpers |
| `core/src/events.ts` | EventBus — the B-seam |
| `core/src/router.ts` | ModelRouter — the model seam |
| `core/src/supervisor.ts` | agent lifecycle: worktree + spawn + parse + emit |
| `core/src/run-lifecycle.ts` | `trackSupervisedRun` — the shared supervised-run lifecycle seam (insert tracking row → `startRun` → subscribe-until-terminal → finalize-exactly-once + race backstop); the 3 supervised callers ride it, and `startAgentRun` (P5) extends it (F2.W1) |
| `core/src/agent-config.ts` | `synthesizeConfigDir` — builds the per-run `CLAUDE_CONFIG_DIR` (settings, allowlist, MCP, vendored skills, injected L0+L1 prompt) so host `~/.claude` never loads; honors the per-profile authority rows within the tier CEILING, fail-closed validate-before-mutate (P5.7, D-054) |
| `core/src/profiles.ts` | DB-backed `AgentProfile` registry (get/list/create/update + `seedProfiles`) over `agent_profiles`; keeps `DEFAULT_PROFILE` as the orchestrator fallback (P5.0) |
| `core/src/authority.ts` | `resolveAuthority(tier)` → `{allowedTools, mcpServers, skills}` from `agent-config/{allowlists,mcp,bundles}`; fail-closed mcp↔allowlist grant guard + coding-tools gating check (P5.0) |
| `core/src/agent-runs.ts` | `startAgentRun(profileId, {trigger, goal\|thread, …})` — activates a profile into a supervised run over the `run-lifecycle` seam, tracked in `agent_runs`, with dispatch-failure rollback (P5.0) |
| `core/src/k-thread.ts` | K front-door runtime (D-023/D-042, P5.1c; resumable one-shot W7a, D-062) — `askK` (establish-or-`--resume` a stable per-thread CLI session, answer-and-exit — no park), durable K thread over `k_threads`/`k_thread_turns` (source of truth), `renderSeed` (first-ask/reset transcript seed), `captureAnswers` (K replies → thread at each turn boundary, persists `cli_session_id` on first `done`), `undoK` (removes the dangling turn); SDK-free |
| `core/src/routes/k.ts` | the "talk to K" HTTP surface (P5.1c) — `POST /api/k/ask` (activate K, returns `KAskResult`) + `GET /api/k/thread` (the durable thread + turns) |
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
| `core/src/verify.ts` | health-score engine + auditors + `runVerification` orchestration (incl. the live coverage-trend signal, F4) |
| `core/src/metrics.ts` | metrics summary + `buildTimeseries` (day × project\|model, top-8 + other) |
| `core/src/eval/` | the in-engine behavioral eval subsystem (F3): `dispatch`/`sandbox`/`graders`/`judge`/`metrics`/`runner` (the ported harness) + `service.ts` (`startEvalRun`, **dry-default**) + `store.ts` (DB-registry seed/load); see §07 |
| `core/src/routes/evals.ts` | the Evals HTTP surface — 7 endpoints over the run service (dry-default `POST /api/evals/run`) |
| `core/src/html.ts` · `core/src/paths.ts` | shared `escHtml` + path-containment guard (`isPathWithin`) — the F2 leaf-util dedup |
| `core/src/host-discovery.ts` | D-069 guarded host scanners (user/project/plugin skills, host MCP) + `syncHostDiscovery` (transactional upsert preserving the K-scoped overlay) |
| `core/src/skill-roots.ts` | allowlisted skill-source roots + `confineToRoots` (two-gate string+realpath check per root, extends F-069) + the qualified-key grammar guard |
| `core/src/run-assets.ts` | `resolveRunAssets(profile, …)` — the model-neutral resolve seam (ceiling → narrowing → discovered resolution → trust re-verify → project-scope filter) both runtimes consume |
| `core/src/token-estimate.ts` | `estimateTokens` — the one `ceil(chars/4)` heuristic seam (±25%, no tokenizer dep) |
| `core/src/routes/capabilities.ts` | the capability catalog API — skills/mcp/hooks/summary GETs, rescan, enable PATCHes, trust/probe POSTs (env values never leave core) |
| `core/src/ollama-agent/` · `core/src/mcp-client.ts` | the D-072 in-process tool loop (loop/transport/native-tools/tool-registry/capability) + the stdio MCP client wrapper |
| `core/src/skill-creator.ts` · `core/src/routes/skill-creator.ts` | D-071 drafts lifecycle (authoring runs, refine, evaluate, save-to-library) + its HTTP surface |
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

**The `user_version` fast path (P5.7, D-059).** `migrate()` runs on EVERY connection
open — the main boot AND each per-run stdio MCP child (up to 3 per K/Chief turn) —
so the full guarded-ALTER/backfill scan is now **version-gated**: `PRAGMA
user_version === SCHEMA_VERSION` → return immediately; otherwise run the full scan
(`migrateSlow`) and stamp the version **only on success**, so a failed migration
retries on the next open. **Bump discipline (documented at the constant in
`db.ts`):** adding any new migration to `migrateSlow()` requires bumping
`SCHEMA_VERSION` — an older-stamped DB then re-runs the scan and is re-stamped.
The per-step guards stay as belt-and-suspenders for the slow path and for
concurrent first-boots racing before the stamp lands.

**Sentinel guard against a poisoned stamp (F1).** The fast path above trusts `PRAGMA user_version`
blindly, which only holds if the stamp and the actual schema agree. `migrate()` now checks a
**sentinel column** (`SCHEMA_SENTINEL = { table: 'projects', column: 'budget_daily_usd' }`, updated
alongside every `SCHEMA_VERSION` bump) before honoring a matching stamp: if the sentinel column
doesn't actually exist on `projects`, the stamp is treated as poisoned — `migrate()` logs a warning
and falls through to the full `migrateSlow()` rescan regardless of what `user_version` says. Because
that rescan is idempotent (guarded ALTERs), it self-heals every missing column and re-stamps
correctly with no manual intervention.

**The 2026-07-13 poisoned-stamp incident (motivating F1).** The dev DB (`data/k.db`, repo root) was
found stamped `user_version = 12` with **zero** of the v12 columns present. Mechanism: a
`pnpm --filter @k/core dev:watch` process was running against the real DB during schema editing; an
intermediate save hot-restarted core mid-edit and stamped 12 before the v12 migration block existed
in `migrateSlow()`. The pre-F1 fast path trusted that stamp unconditionally, so `migrate()` returned
immediately on every later boot and the DB was never repaired. After the P5 merge landed, module-level
`db.prepare()` statements referencing v12 columns crashed core at import
(`SqliteError: no such column: budget_daily_usd`) → crash-loop → every `/api` route `503` — the whole
backend appeared dead. CI, all test suites, and live smokes all exercise fresh DBs
(`CREATE TABLE IF NOT EXISTS`), so none of them could have caught an upgrade-path bug like this — see
`pnpm smoke:upgrade` under Dev-stack hygiene, which now closes that gap.

**Recovery procedure** for a DB found in this state: stop every process pointed at it, force the
stamp back to zero (`PRAGMA user_version = 0`), then boot core **once** with the rest of the stack
stopped — the migration scan runs unconditionally at `user_version = 0`, and being idempotent, heals
every missing column and re-stamps to the current `SCHEMA_VERSION`. With F1 in place this manual
recovery is now also the automatic behavior the next time a poisoned stamp is opened.

**One-shot, flag-guarded migrations (P5.7).** Some evolutions cannot be
plain-idempotent ALTERs and run exactly once, guarded by an `app_config` flag
(re-checked *inside* an IMMEDIATE transaction, so racing processes no-op):

- `mig_work_items_run_scope` (D-053) — a **table REBUILD** of `work_items`
  (SQLite cannot alter a CHECK in place: copy → drop → rename with FKs toggled
  off) onto the final `run|personal|org|project` scope enum, re-stamping legacy
  `personal`/`org` rows to `'run'`.
- `mig_project_tasks_drop` (D-058) — the final `project_tasks → work_items`
  backfill followed by **`DROP TABLE project_tasks`** (fixes the boot-resurrection
  of API-deleted tasks); a partial UNIQUE `(project_id, issue_number)` index (after
  a dedupe) makes issue-mirroring idempotent.
- `migration.agentProfileModelReset.v1` (D-056) — un-freezes profile rows still
  pinning the historical `'claude-sonnet-4-6'` literal to the `''` runtime-default
  sentinel.
- `mig_agent_memory_profile_backfill` (D-053) — best-effort backfill of
  `agent_memory.profile_id` from each lesson's source-run activation.

`verification_reports.score_breakdown` (TEXT, JSON) was added via one of these
guarded idempotent ALTERs — it stores the four §07 score components (`ci`,
`coverage`, `bible`, `findings`) so the Verification tab can render per-weight
bars without recomputing. Older reports without the column still validate
(the breakdown is optional on read).

`verification_reports.coverage_pct` (REAL) was added the same way (F4) — it stores
the project's measured overall line-coverage % at verify time. `runVerification`
reads the *previous* report's `coverage_pct` to derive the live coverage **trend**
(§07): a coverage file present + below the prior reading → a real score penalty;
no coverage file → `unknown` → neutral. NULL for older reports / uninstrumented
projects; the field is nullable/optional on read.

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
  sockets with code `4401` before subscribing them.
- Setting `HOST=0.0.0.0` is still only safe **behind** Tailscale or an
  authenticating HTTPS reverse proxy (see Remote access). The non-loopback safety
  gate prevents booting that posture with a weak/empty token.

## Phase 5 — Agent Organization (storage / env / key files)

**The agent org's storage is BUILT end to end** — P5.0 laid the foundation (`agent_profiles` +
`agent_runs`, `authority.ts`, `startAgentRun`, D-037) and the later waves filled in every row below
(the last: the unified `work_items` finalization + `project_tasks` drop, P5.7). All tables follow
the migration discipline above (guarded ALTERs, one-shot flags where a rebuild/drop was required).

**Tables.**

| Table | Status | Holds |
|-------|--------|-------|
| `agent_profiles` | **BUILT (P5.0)** | one row per durable profile (K · Chief · orchestrator + the five leads): `tier`, `charter` (charter-asset basename), `default_model`, `allowed_tools` (JSON), `mcp_servers` (JSON), `skills` (JSON); `name` UNIQUE so the seed is idempotent |
| `agent_memory` | **BUILT** (kstore; `profile_id` added P5.0) | gated lessons (layer A): `run_id` (source run), `lesson`, `status` (`pending`/`accepted`/`rejected`), `created_at`, `reviewed_at`, + `profile_id` (P5.0) — the gated-reflection store |
| `agent_runs` | **BUILT (P5.0)** | one activation of a profile into a supervised run: `profile_id`, `run_id`, `trigger`, `goal`, `project_id`, `workflow_id`, `status` — the `startAgentRun` tracking row (rides the run-lifecycle seam) |
| `workflow_definitions` | **BUILT (P5.3b)** | named workflows (`NamedWorkflow`): `name`, `roles` (JSON), `prompt_scaffold`, `cross_project` — the generalization of the single `buildDelegationPrompt` (D-047) |
| `work_items` | **BUILT (unified — D-045/D-048/D-053/D-058)** | THE one scoped task store: `scope ∈ run\|personal\|org\|project` (`run` = ephemeral kstore default; `personal`/`org` durable operator-global; `project` carries `project_id` + issue-sync columns). `project_tasks` is **dropped** (one-shot `mig_project_tasks_drop`) |
| `lead_dispatches` | **BUILT (P5.6 loop-b)** | the Chief→lead dispatch intent queue (`pending`/`dispatched`/`failed`) drained by the main-process relay; completed intents retire by **liveness derivation** (D-060) |

**Org env / runtime config (as-built).** The kstore/logistics/mgmt MCP servers need **no env** —
they are stdio children whose command/env the synthesizer rewrites per run. The org loop's toggles:
`CHIEF_WAKE=0` (disable the Chief wake), `CHIEF_WAKE_CRON` (the schedule tick),
`LEAD_DISPATCH_RELAY=0` (disable the relay), plus two **`app_config`** keys governing event wakes
(P5.7, D-057): `chief_wake_max_per_hour` (rolling-hour cap, default 6) and
`chief_wake_events_enabled` (kill switch, `'1'` default, hot-flippable). **Still planned:** the
Google connector credentials K would mount (Calendar/Gmail/Drive — connectors not wired, §03) and a
flag for K's hybrid idle-timeout.

**Key files.**

| File | Status | Purpose |
|------|--------|---------|
| `core/src/profiles.ts` | **BUILT (P5.0)** | DB-backed `AgentProfile` registry (get/list/create/update + `seedProfiles`) |
| `core/src/authority.ts` | **BUILT (P5.0)** | tier → allowed tools/skills/MCPs resolution + the mcp↔allowlist grant guard |
| `core/src/agent-runs.ts` | **BUILT (P5.0)** | `startAgentRun` — generalizes `startRun`, riding the `run-lifecycle` seam |
| `core/src/routes/memory.ts` | **BUILT (P5.1b)** | the layer-A operator gate — `GET /api/memory/lessons` + `POST …/approve\|reject` (status transitions only) over the kstore `agent_memory` rows |
| `core/src/workflows.ts` | **BUILT (P5.3b)** | `renderWorkflowPrompt(scaffold, tasks)` over the seeded `NamedWorkflow` scaffolds (`buildDelegationPrompt` byte-identical); the task-dispatch route accepts an optional `workflowId` (P5.7 C2) |

## `request_input` — explicit operator asks (UI Adjustments Round 4, D-135)

Every interactive turn still parks its run at `awaiting_input` (`supervisor.ts`, untouched) so the
resume/session/metrics machinery is unaffected. Before Round 4 the Personal Inbox's `input_needed`
card and the `run_awaiting_input` notification fired on that bare park state — i.e. on **every**
interactive turn boundary, agent question or not. Round 4 adds a tool an agent must explicitly call
to actually notify the operator, narrowing both surfaces to genuine asks.

- **The tool.** `request_input` ships on the **kstore** MCP server (`core/src/mcp/k-store.ts`) —
  K's working-store server, mounted via the server-wide `mcp__kstore` grant at every interactive tier
  (chief/orchestrator/secretary — not a chief-only tool; a dispatched lead/worker is exactly who needs
  to ask the operator mid-task). Input: `{ question: string (1–2000 chars), kind?: 'question' |
  'verification' | 'feedback' }` (default `kind` reads as `'question'`). It requires a managed run
  context (`resolveOwnerRunId` — throws `request_input requires a managed run context` for a bare/no
  run id, same guard as `message_agent`).
- **What it writes.** A durable `input_request` event on the calling run's own event stream — **no
  schema bump**, it reuses the existing `events` table with `type='input_request'`, `text` = the
  literal question, `raw` = `{"kind": …}`. It's a pure marker write: no run-status or session mutation.
  The insert races the run's own event-seq counter under a bounded 8-attempt retry (recomputes `seq`
  on a dropped/constraint-failed insert) so a genuine ask is never silently lost.
- **"Unanswered" derivation.** Both `core/src/routes/inbox.ts`'s `listInputParked` query and
  `core/src/notify.ts`'s `awaiting_input` rule (via `eventsDb.hasUnansweredInputRequest`) key off the
  same predicate, kept in exact sync: the run is `awaiting_input` **and** it has an `input_request`
  event whose `ts` is newer than the run's own latest `status`/`'running'` event (i.e. no resume has
  happened since the ask). A card/notification is one row per run even if the agent asked more than
  once (correlated subquery pulls the *latest* `input_request`'s question). Once the operator replies,
  the run resumes to `running`, which retires the ask — the next `request_input` call (if any) starts
  the cycle over.
- **Net effect.** An ordinary agent reply that never calls `request_input` produces **no** inbox item
  and **no** `run_awaiting_input` notification — only an explicit question/verification/feedback ask
  surfaces to the operator. The Inbox card still renders as an `input_needed` kind (§08) carrying the
  agent's literal question; the operator's reply is delivered as the agent's next turn exactly as
  before — nothing about how a reply is delivered changed, only what triggers the surfacing.
