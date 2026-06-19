# K — Execution Tracker

Active branch: `feat/phase-3` · Current phase: **Phase 3 — Automation & Skills**

Method (all code waves): **subagent-driven development** — implementer → spec-review →
quality-review → controller applies fixes → one reviewable commit → CI verifies. A separate
whole-implementation review runs before merge. See `tasks/lessons.md` for accumulated patterns
and `docs/superpowers/plans/` for the per-phase plans.

---

## Phase 3 — Automation & Skills *(in progress)*

Plan: `~/.claude/plans/read-and-analyze-artifacts-project-bible-eventual-stonebraker.md`

| Wave | Scope | Status |
|------|-------|--------|
| **3-1** | Skill/Hook/Workflow Registry — `skills`/`skill_runs` tables, `skills.ts`, routes, `SkillsPage`, scheduler + event listener, boundary validation | ✅ done (`11b238c`, audit `e51ea3c`) |
| **0** | Cleanup & docs — consolidate this tracker, refine + recompile bible, rewrite `CLAUDE.md` as the harness system prompt | ✅ done (`ceb3815`, `aa59174`) |
| **3-2** | Ollama provider (replace stub) + cost-aware routing over run-outcome data; reachability check + graceful degrade to claude | ✅ done (`d79642b`) |
| **3-3** | eval-harness skill testing — `skill_evals` table; skill-test flow reusing `everything-claude-code:eval-harness`; `POST /api/skills/:id/test`, `GET /api/skills/:id/evals`; regression badge | ✅ done (`d896f61`) |
| **3-4** | Routing improvement dashboard — backend aggregation (cost/latency/success by provider+model) + `RoutingPage` (table, trend charts, recommendation) | ✅ done (`a14c71d`) |
| **3-6** | Web terminal — `node-pty` over the WS gateway (auth-guarded, cleanup on disconnect) + xterm.js component; feature-flagged (default off) | ✅ done (`eb72f61`) |
| **3-7** | Structured task/goal records + GitHub Issues sync — `GitHubProvider.syncIssues` w/ graceful degrade; Tasks-tab sync affordance | ✅ done (`5709e5f`) |
| **3-5** | Close-out — finalize bible Phase 3 sections + roadmap progress, tick this tracker, append lessons; whole-impl review; e2e verification; merge | ✅ done |
| **fix** | Blank-screen bug — all routes blank from `react-force-graph` aggregate pulling an `AFRAME`-referencing module that threw at eval time; swapped to `react-force-graph-2d` + static guard test (`5f786e4`). Verified live in headless Chromium across all 10 routes. | ✅ done |
| **review** | Whole-impl review fixes — PATCH skill cron/body validation, PR/issue `url` http(s) allowlist, terminal WS error/close banner (`65d51a8`) | ✅ done |

> Waves 3-6 and 3-7 were pulled into Phase 3 from the Phase 1 "deferred to Phase 3" notes
> (operator decision 2026-06-18) so the roadmap and this tracker agree.

### Acceptance criteria (per wave)
- **3-2** — unit tests green (no live Ollama); `route()` returns claude when `ENABLE_OLLAMA`
  unset; an unreachable/absent Ollama never breaks a run (warn + fall back to claude);
  supervisor needs no edits (the seam holds). Code comments stop saying "Architecture-C".
- **3-3** — pass/fail recorded per eval; regression (was-pass-now-fail vs prior baseline)
  detected and surfaced on `SkillsPage`; degrades cleanly when the eval run can't be dispatched.
- **3-4** — dashboard renders live aggregates and a sane empty state; reuses the existing
  stacked-SVG chart + `buildTimeseries` patterns and design tokens.
- **3-6** — pty session spawn/echo/exit works and cleans up; absent/unsupported pty degrades
  gracefully; auth-guarded WS.
- **3-7** — issue↔task mapping is correct with mocked `gh`; absent `gh` degrades (no crash).

### Close-out review (3-5, 2026-06-19)

- **Verification.** `pnpm -r typecheck` green (4/4); **core 345** + **web 81** tests green;
  `pnpm -r build` green. Booted core + Vite and drove all 10 routes in headless Chromium.
- **Blank-screen bug (found during verification, fixed).** Every route rendered blank because the
  three graph views imported the `react-force-graph` *aggregate*, whose 3D/VR/AR module body
  references a global `AFRAME` and threw at module-eval time — and `Shell` statically imports the
  graph pages, so the throw blanked the whole tree. typecheck/build/unit tests all passed anyway
  (runtime-only crash). Fix: import `react-force-graph-2d` (default export) + a static guard test
  (`web/test/bundle-guard.test.ts`). Bundle 2,683 kB → 1,069 kB. Lesson captured.
- **Whole-impl review** (code + security agents over `git diff main...HEAD`). **No blockers.**
  Landed the in-scope fixes (`65d51a8`): strict PATCH skill validation incl. cron; PR/issue `url`
  http(s) allowlist at ingest; terminal WS error/close banner. Deferred (documented above):
  Fastify v5 + Vite 6 (major upgrades, loopback-gated), `listSkills`-per-event perf (fine at scale).
- **Live render proof.** Registered a project; Home + `/graph` draw the ForceGraph2D canvas node;
  all routes show real content with zero page errors (terminal shows its disabled banner as designed).

---

## Completed phases *(history — see git log & bible §07 for detail)*

- **Phase 0 — Foundation + Command Deck** ✅ — monorepo scaffold, Zod schemas, SQLite, EventBus,
  ModelRouter interface, supervisor (worktree + claude CLI + stream-json), artifacts store,
  bible compiler, Fastify REST + WS, React Command Deck shell. 17 tasks, all green.
- **Phase 1 — Observability Core** ✅ — CI, auth pathname fix, supervisor permission-mode,
  `runs.project_id`, ⌘K @project dispatch, time-series + stacked SVG charts, replayable run
  timeline, run-list filters/kill/cost totals. 11 tasks; 86 core + 32 web green.
- **K Remediation (post-Phase-1 review)** ✅ — security (path-traversal, cwd validation, bible
  sanitize), correctness (falsy-zero guards, event re-sort), reliability (`reconcileOnBoot`,
  event dedup UNIQUE index, honest Provider seam). 223 core + 61 web green.
- **Phase 2 — Verification & Workspace Core** ✅ — bounded `/metrics/summary`, server-side run
  filters, lazy raw fetch, scaffolders, `onboarding` skill, two-layer verification
  (`computeHealthScore` + auditors + `verify-project` skill). 187 core + 57 web green.
- **Phase G — Workspace UI & Fleet Graph** ✅ (2026-06-18) — 7-tab project workspace, Knowledge
  + Fleet graphs (ForceGraph2D), node inspector, `project_tasks` CRUD, agent-opens-PR
  (`createPR` + modal + RunConsole footer). G-1…G-6, 285 tests green.

> Per-task spec/quality review notes for the above live in git history and prior revisions of
> this file; they are intentionally not carried forward here to keep the active tracker scannable.

---

## Backlog *(genuinely later-phase — not Phase 3)*

- **`/api/metrics/summary` unbounded full-table scan** (Phase 1 final review). Loads every run
  row per poll for a 14-day summary + lifetime `totalRuns`. Fix when the table grows / endpoint
  is polled hot: `SELECT COUNT(*)` for `totalRuns`, `COUNT(*) WHERE status IN ('running','queued')`
  for `activeRuns`, and bound the daily scan with `WHERE created_at >= windowStartMs(now, 14)`.
  Timeseries is already windowed.
- **Auth hardening (passkey/TOTP replacing bearer token)** → Phase 4 (remote-access hardening).
- **Judgment-findings re-scoring** — wire the deep `verify-project` agent's structured output
  back into a persisted `VerificationReport` (deferred in Phase 2 §05).
- **Adaptive GitHub polling cadence** — only if fixed-interval polling lag ever hurts.
- **EventBus persist/publish split** → Phase 5 seam (NATS/Redis Streams + workers).
- **`startEventListener` re-queries `listSkills()` on every `run_update` event** (Phase 3
  whole-impl review). A full `SELECT * FROM skills` per status event; fine at current single-user
  loopback scale, but cache with a short TTL (or invalidate on register/delete) before run volume
  grows. `core/src/skills.ts`.

### Accepted localhost risks *(tracked, not fixed — operator decision 2026-06-17)*

Per bible §09 "Accepted risks" — the default posture is `HOST=127.0.0.1` (loopback only).
**Close ALL of these before any `0.0.0.0` / remote exposure:** WS-upgrade auth (token on `/ws`);
timing-safe bearer compare (`crypto.timingSafeEqual`, incl. the `TERMINAL_TOKEN` gate in
`core/src/terminal.ts`); refuse-to-boot on default `HARNESS_TOKEN` with a non-loopback `HOST`;
stop logging the token at startup; `@fastify/rate-limit` on `POST /api/runs`; `localPath`
registration root allowlist.

**Dependency upgrades gating remote exposure** (Phase 3 whole-impl security review — both
require a major-version bump, so deferred from the close-out):
- **Fastify v4 → v5** — v4.29.1 has a body-validation bypass (tab in `Content-Type`); patched only
  in ≥5.7.2. Auth gate fires first at loopback, and Zod `safeParse` on bodies is a second layer, so
  it's not exploitable today; upgrade before `0.0.0.0`.
- **Vite 5 → 6** — v5.4.21 (latest 5.x) has a Windows `server.fs.deny` bypass; no 5.x patch exists,
  the fix is in 6.x. Dev-server-only (the Vite proxy injects `HARNESS_TOKEN`), so it matters only
  if the dev server is ever exposed. Upgrade with the Phase 4 toolchain pass.

---

## Environment notes

- **`gh` CLI not installed** here — GitHub features degrade gracefully (poller warns, cache
  serves empty); CI status via GitHub web UI / unauthenticated REST.
- **Ollama not installed** here — 3-2 is verified by unit tests + the degradation path only.
- **node-pty builds here** (prebuilds, no compile) — listed in `pnpm-workspace.yaml`
  `onlyBuiltDependencies`. The web terminal (3-6) is default-off (`ENABLE_TERMINAL`),
  auth-guarded by the scoped `TERMINAL_TOKEN` (separate from `HARNESS_TOKEN`), and
  was verified live end-to-end (real shell echo on a valid token; no spawn on a bad
  token). node-pty is dynamically imported so a missing binding degrades, never crashes.
- `pnpm --filter @k/core dev` (tsx watch) hangs under the agent harness; for e2e run one-shot:
  `cd core && ./node_modules/.bin/tsx src/index.ts` (background).
- Web dev auth: the Vite proxy injects the bearer header (`web/vite.config.ts`).
- Run guarded migration `ALTER`s with the dev server stopped (first boot only).
- **Commit policy:** authored skills (`.claude/skills/onboarding`, `.claude/skills/verify-project`)
  are committed; external GitNexus tooling (`.claude/skills/gitnexus`, `.gitnexus/`) and
  `.claude/worktrees/` stay out. `CLAUDE.md` IS tracked (watch the case-insensitive `claude.md`
  gitignore collision — verify with `git check-ignore CLAUDE.md`).
