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
| **0** | Cleanup & docs — consolidate this tracker, refine + recompile bible, rewrite `CLAUDE.md` as the harness system prompt | ⏳ in progress |
| **3-2** | Ollama provider (replace stub) + cost-aware routing over run-outcome data; reachability check + graceful degrade to claude | ☐ |
| **3-3** | eval-harness skill testing — `skill_evals` table; skill-test flow reusing `everything-claude-code:eval-harness`; `POST /api/skills/:id/test`, `GET /api/skills/:id/evals`; regression badge | ☐ |
| **3-4** | Routing improvement dashboard — backend aggregation (cost/latency/success by provider+model+task) + `RoutingPage` (table, trend charts, recommendation) | ☐ |
| **3-6** | Web terminal — `node-pty` over the WS gateway (auth-guarded, cleanup on disconnect) + xterm.js component; feature-flag if it destabilizes Windows CI | ☐ |
| **3-7** | Structured task/goal records + GitHub Issues sync — implement `GitHubProvider.syncIssues` w/ graceful degrade; Tasks-tab sync affordance | ☐ |
| **3-5** | Close-out — finalize bible Phase 3 sections + roadmap progress, tick this tracker, append lessons; whole-impl review; e2e verification; PR → merge | ☐ |

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

### Accepted localhost risks *(tracked, not fixed — operator decision 2026-06-17)*

Per bible §09 "Accepted risks" — the default posture is `HOST=127.0.0.1` (loopback only).
**Close ALL of these before any `0.0.0.0` / remote exposure:** WS-upgrade auth (token on `/ws`);
timing-safe bearer compare (`crypto.timingSafeEqual`); refuse-to-boot on default `HARNESS_TOKEN`
with a non-loopback `HOST`; stop logging the token at startup; `@fastify/rate-limit` on
`POST /api/runs`; `localPath` registration root allowlist.

---

## Environment notes

- **`gh` CLI not installed** here — GitHub features degrade gracefully (poller warns, cache
  serves empty); CI status via GitHub web UI / unauthenticated REST.
- **Ollama not installed** here — 3-2 is verified by unit tests + the degradation path only.
- `pnpm --filter @k/core dev` (tsx watch) hangs under the agent harness; for e2e run one-shot:
  `cd core && ./node_modules/.bin/tsx src/index.ts` (background).
- Web dev auth: the Vite proxy injects the bearer header (`web/vite.config.ts`).
- Run guarded migration `ALTER`s with the dev server stopped (first boot only).
- **Commit policy:** authored skills (`.claude/skills/onboarding`, `.claude/skills/verify-project`)
  are committed; external GitNexus tooling (`.claude/skills/gitnexus`, `.gitnexus/`) and
  `.claude/worktrees/` stay out. `CLAUDE.md` IS tracked (watch the case-insensitive `claude.md`
  gitignore collision — verify with `git check-ignore CLAUDE.md`).
