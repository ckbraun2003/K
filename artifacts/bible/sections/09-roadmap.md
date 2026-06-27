---
title: Roadmap
icon: "➤"
status: active
updated: 2026-06-27
---

Re-baselined 2026-06-10 to fold in the compiled-bible, registry, GitHub, verification, and Command Deck designs.

<!-- @live:roadmap-progress -->

## Phase 0 — Foundation

> Running skeleton: prompt → supervised agent → live stream → persisted run + artifacts + compiled bible

- [x] Monorepo scaffold (`shared/`, `core/`, `web/`)
- [x] Shared Zod schemas (AgentEvent, Run, Artifact, WsMessage)
- [x] SQLite schema + helpers (runs, events, artifacts)
- [x] EventBus seam (`events.ts`) — persist + push to WS subscribers
- [x] ModelRouter interface (`router.ts`) — claude default, ollama stub
- [x] Agent Supervisor (`supervisor.ts`) — worktree + claude CLI + stream-json parser
- [x] Artifacts store (`artifacts.ts`) — md → styled HTML
- [x] Bible compiler (`bible.ts`) — sections + live data → self-contained HTML
- [x] Project/VerificationReport schemas + tables (groundwork)
- [x] Fastify REST + WS gateway end-to-end verification pass
- [x] React dashboard — Command Deck shell (sidebar · ⌘K · stage · activity strip)

## Phase 1 — Visibility + Fleet plumbing

> Full observability, plus the registry and GitHub seams go live

- [x] Project registry API (register path / clone URL)
- [x] Onboarding skill (scaffold bible + CI)
- [x] GitHubProvider via `gh` CLI — PR list/status, CI runs, polling + SQLite cache
- [x] Metrics summary endpoint + dashboard metrics row
- [x] Token time-series charts (per day/project/model) — stacked SVG, top-8 + other
- [x] Full run event timeline (replayable from SQLite via `?raw=1`)
- [x] Run list kill switch, status filters, cost totals

**Deferred out of Phase 1** (re-homed to their target phases so this phase reflects only its
delivered scope): web terminal → **Phase 3 (3-6)**; structured task/goal records + GitHub Issues
sync → **Phase 3 (3-7)**; auth hardening (passkey/TOTP) → originally targeted **Phase 4**
(remote-access hardening), but the re-scoped Phase 4 (Agent-UX + Observability) did **not** ship it —
passkey/TOTP auth hardening is **deferred to a later phase** (see the Phase 4 *Deferred* list, D-019).

## Phase G — Command Deck + Knowledge + Verification *(✓ complete 2026-06-18)*

> The approved dashboard design built for real; graphs and the verify-project skill live

> *Phase G builds the originally-numbered "Phase 2 — Command Deck" design; it was renamed to avoid collision with the merged Phase 2 verification-core work.*

- [x] Command Deck frame: icon sidebar, ⌘K bar, stage, activity strip
- [x] Home stage: metrics row, needs-attention project cards, fleet graph pane
- [x] Project workspace: 7 tabs incl. per-project Knowledge Graph (GitNexus)
- [x] Node inspector with dispatch-agent actions
- [x] `verify-project` skill: agent team, VerificationReport, health scores
- [x] CI scaffolding/repair by the CI auditor
- [x] Agent-opens-PR flow surfaced in PRs & CI tab
- [x] Fleet Graph on Home page + full-screen /graph route
- [x] Knowledge Graph tab: ForceGraph2D, node inspector, stale-index banner
- [x] Task CRUD: `project_tasks` table + `GET/POST/PATCH /api/projects/:id/tasks`
- [x] `createPR` via `gh` CLI (argv array, sanitized errors) + `POST /api/projects/:id/prs`
- [x] "Create PR from Run →" footer in RunConsole
- [x] G-6: tasks-route tests, create-pr tests, bible §08+§09 updates, .env.example

## Phase 3 — Automation & Skills *(✓ complete 2026-06-18)*

> Skills run themselves on schedules and events; the model router goes live with cost-aware
> routing; skills are tested for regressions; and run-outcome data becomes visible and
> actionable. Waves 3-6 and 3-7 are the Phase-1 deferrals, re-homed here.

- [x] **3-1 — Skill/Hook/Workflow Registry.** `skills` + `skill_runs` tables, `skills.ts`,
  REST routes, `SkillsPage`, cron scheduler + event listener, boundary validation.
  *Done — CRUD plus manual / schedule / event triggers dispatch runs; invalid cron or
  trigger-field mismatch is rejected with 400 at the API boundary.*
- [x] **3-2 — Ollama provider + cost-aware routing.** Replaced the `ollamaProvider` stub with a
  real `ollama run` provider; extended `route()` with `preferLocal`/`maxCostUsd` hints, mean
  completed-claude-cost run-outcome data, and a background reachability probe.
  *Done — `route()` returns claude unless `ENABLE_OLLAMA` AND a probe confirms reachability;
  an unreachable/absent Ollama degrades to claude (warn, never fails a run); supervisor unchanged
  (it dispatches + parses on the routed provider, so an ollama run can't run/parse as claude).*
- [x] **3-3 — Skill testing via eval-harness.** `skill_evals` table; `runSkillTest` dispatches a
  supervised eval run (eval-harness methodology, `EVAL VERDICT` marker); `POST /api/skills/:id/test`
  + `GET …/evals`. *Done — each test records pass/fail; a regression (was-pass, now-fail vs the
  prior baseline) is flagged + badged on `SkillsPage`; a non-dispatchable eval degrades to a
  durable failed eval.*
- [x] **3-4 — Routing improvement dashboard.** Pure `aggregateRouting` over windowed runs
  (cost / latency / success by provider+model — there is no task taxonomy on `runs`, so
  provider+model is the routing dimension); `GET /api/metrics/routing`; `RoutingPage` with an
  outcome table, a cost-by-model trend (reusing the stacked-SVG chart), a plain-language
  recommendation, and an empty state. *Done.*
- [x] **3-6 — Web terminal** *(re-homed from Phase 1).* A `node-pty` shell bridged over a new
  `/ws/terminal` WS route, rendered with xterm.js. *Done — default-OFF (`ENABLE_TERMINAL`);
  auth-guarded by a scoped `TERMINAL_TOKEN` (distinct from `HARNESS_TOKEN`, the only token in the
  web bundle); node-pty dynamically imported so a missing binding degrades to a clean error, never
  crashing boot; session disposed on disconnect. Verified live (real echo on a valid token; no
  shell spawned on a bad token).*
- [x] **3-7 — Structured task/goal records + GitHub Issues sync** *(re-homed from Phase 1).*
  `GitHubProvider.syncIssues` reconciles `gh issue list` into `project_tasks` (insert / close /
  reopen / no-clobber of `in_progress`); Tasks-tab sync button. *Done — mapping verified with a
  mocked `gh`; absent `gh` (or a no-remote project) degrades to `{ synced: 0, degraded: true }`
  at 200, matching the PR/CI poller posture.*
- [x] **3-5 — Phase 3 close-out.** These sections + roadmap progress finalized, lessons captured,
  whole-implementation review (no blockers; in-scope fixes landed) + full verification
  (typecheck · core 345 / web 81 tests · build) green, merged to `main`. Live headless-Chromium
  pass across all 10 routes caught and fixed a blank-screen regression — the `react-force-graph`
  aggregate threw `AFRAME is not defined` at module-eval time, blanking every route; switched to
  the 2D-only `react-force-graph-2d` subpackage (guarded by a static import test).

## Phase H — Knowledge Graph Engine & Experience Polish

> Every registered project gets a live, navigable, actionable code graph; the interface feels finished (hybrid glass + motion); the bible self-demonstrates via a real UI artifact. One reviewable commit per wave (implementer → spec-review → quality-review → controller → CI).

> *Phase H is experience-focused and lettered like Phase G; it slots in before Phase 4 (originally Multi-Device).*

- [x] **H-1 — Graph build engine (core).** `project_graphs` table (status/built_at/last_commit/node+edge counts/error); `buildGraph()` runs `npx gitnexus analyze` via an injected seam with an in-flight guard + EventBus emit; `POST /api/projects/:id/graph/build` + status/stale on `GET …/graph`; transient `graph_update` WS; shared graph-status schema; `graph.test.ts` (CI never invokes real GitNexus).
- [x] **H-2 — Enrichment, dispatch, auto-reindex (core).** Live node enrichment in `GET …/graph` (last-touched run, verify findings, bible — bible scoped to the harness project only); `POST /api/projects/:id/graph/dispatch` (node-scoped run via `startRun`, single-line input guard → 400); auto-reindex via an `onRunUpdate` subscriber (per-project debounced, guarded; env flag `GRAPH_AUTO_REINDEX`, default on).
- [x] **H-3 — Knowledge Graph UI.** Build/Refresh button + building spinner + last-built/stale/error chips + WS-driven auto-refresh; node inspector enriched facts + enabled Dispatch Agent (confirm-card → dispatch → transient notice); graph polish (status coloring, legend, spring physics, center/zoom on click, reduced-motion); fleet-graph polish (nodes-only, no invented edges).
- [x] **H-4 — Hybrid glass + motion.** Glass tokens + backdrop-blur utilities + `@supports` fallback (`index.css`); glass applied to hero surfaces only (command bar, modals, node inspector, activity strip); centralized `lib/motion.ts` variants + `MotionConfig` reduced-motion; 60fps check.
- [x] **H-5 — UI artifact system.** `core/src/ui-artifact.ts` (`compileUiArtifact` writes rich HTML to disk verbatim + upserts md); `POST /api/ui-artifact/compile`; seeded harness `ui-demo` (interactive mini Command Deck, hybrid-glass); DocViewer UI badge/link; `ui-artifact.test.ts` (preserves interactive HTML, output-path isolation).
- [x] **H-6 — `create-web-ui-artifact` skill + bible docs.** New `.claude/skills/create-web-ui-artifact/SKILL.md` (UI counterpart to `onboarding`), seeded into the skills registry as a manual workflow; bible §08 (hybrid glass + motion + graph engine + UI artifact), §09 (this Phase H), §10 (D-009/D-010/D-011); skill-registration + bible-isolation tests.
- [ ] **H-7 — Verify, CI, whole-implementation review.** `verify-project` / health audit; `pnpm typecheck && pnpm -r test && pnpm build` + CI green on the branch; whole-implementation review across all waves; recompile bible; merge `--no-ff`.

## Todo delegation workflow *(✓ delivered 2026-06-24)*

> The Tasks tab can multi-select todos and run the harness delegation loop over the selection as one supervised orchestrator run. Decision D-012.

- [x] `workflows.ts` seam: `buildDelegationPrompt` (pure) + `dispatchTaskWorkflow` lifecycle (lock tasks → insert `workflow_runs` → `startRun` → finalize on terminal run, with degrade-on-throw) + `deriveWorkflowStatus` / `finalizeWorkflowRun` + typed `TaskNotFoundError`.
- [x] `workflow_runs` table + `(project_id, created_at)` index + `workflowRunsDb` helpers (`db.ts`).
- [x] `POST /api/projects/:id/tasks/dispatch` (body `{ taskIds }`, 1..50) → **202** `{ workflowRunId, runId }`; 404 unknown project; 400 invalid body / foreign taskId (`TaskNotFoundError`); 500 otherwise. Web api `api.projects.tasks.dispatchWorkflow`.
- [x] Tasks-tab multi-select (per-row checkboxes, indeterminate select-all), sticky **Run delegation workflow** action bar, `in_progress`-on-dispatch (never auto-`done`), success toast with **"View run →"**.

**Follow-on:** staged, per-stage visible/retryable execution (Idea 2) — a `workflow_stages` table with `dispatchTaskWorkflow` spawning one `startRun` per stage chained on `eventBus` (shared branch threaded across stages); the route, api client, and UI stay unchanged (D-012).

## Phase 4 — Agent-UX + Observability *(✓ merged 2026-06-27, commit 30228fa)*

> Finish interactive HITL, then make the agentic system **observable and editable** — surface/edit the prompts & config that drive agents and visualize what agents actually do at runtime. One reviewable commit per wave (implementer → spec-review → quality-review → controller → CI); a whole-effort review + live Playwright smoke before merge.

> *The originally-planned "Phase 4 — Multi-Device" was re-scoped: the desktop/mobile surfaces are deferred (see below, D-019) and this phase delivered the agent-interaction UX (Track A) and observability (Track D) instead.*

**Track A — Agent-interaction UX**
- [x] **A1 — Per-run model picker.** `KNOWN_MODELS` registry drives the dispatch dropdown; the route validates `model` against it.
- [x] **A2 — Multiline prompt composer** + an **interactive toggle** in the ⌘K dispatch card.
- [x] **A3 — Interactive multi-turn HITL.** Persistent stdin; `{type:"result"}` turn boundary → park at non-terminal `awaiting_input`; answer box (ask → answer → continue), End session, atomic conditional-UPDATE double-send guard; boot-sweep handling (D-014).

**Track D — Observability: monitoring, visualization & editable config**
- [x] **D1 — Editable skill prompts.** PATCH partial update, name-collision → 409, clear→NULL (D-017).
- [x] **D2 — Settings page.** Provider/auth status cards (no secrets) + a guarded global CLAUDE.md editor (fixed path, gitnexus block preserved, atomic temp+rename, backups, confirm) (D-017).
- [x] **D3 — Event-data enrichment foundation.** Structured tool fields + `tool_use`↔`tool_result` pairing by `tool_use_id`; race-tolerant ALTER migration (D-015).
- [x] **D4 — Rich run console.** Commands / file diffs / delegated sub-agents rendered structured + collapsed; Console ↔ Timeline.
- [x] **D5 — Workflow visualization.** Static defined-loop diagram (shared `DELEGATION_WORKFLOW`) + live runtime sub-agent tree from `delegate` tool calls (D-016).
- [x] **D6 — Context-pressure indicator + real `/compact`.** Full-input (incl. cache) `context_tokens`, persisted; manual Compact button + guarded/debounced auto-compaction (D-018).
- [x] **Graph polish → 3D.** Node/edge overlap fix; all three force-graph surfaces moved to 3D (`react-force-graph-3d`) with an error boundary per WebGL surface.
- [x] **Wave V — whole-effort verification.** Gates green (typecheck · core/web tests · build), whole-effort pre-merge review (MERGE-READY; in-scope review-fixes landed incl. `context_tokens` persistence round-trip), live Playwright smoke; merged `--no-ff` to `main`.

**Deferred to a later phase** (D-019): the **Tauri desktop app** (bundled-core sidecar, tray, native notifications) — old Track B; full spec retained in `~/.claude/plans/read-through-and-analyze-rippling-hanrahan.md`. Also deferred: **PWA mobile** (installable + push), further **remote-access hardening** (reverse proxy / Tailscale), and **passkey/TOTP auth hardening** (the Phase-1 → Phase-4 re-homing above — not shipped in the re-scoped Phase 4).

## Phase 5 — Agentic Org *(next — headline program)*

> Re-frame the product from "an operator drives a dashboard" to "the user directs an agent
> **organization**" (§03, §04): **K** the friendly secretary → the **Chief** manager → staff-engineer
> **orchestrator leads** → workflow definitions → role subagents. All three durable tiers are one
> `AgentProfile` entity gated by an **authority tier**, enforced by **tier-scoped MCP servers** +
> the `--allowedTools` allowlist. Memory starts at **layer A** (file lessons + gated reflection).
> Decisions D-020 → D-025. One reviewable commit per wave (delegation loop + review every wave).

### 5.1 — Foundation + K

- [ ] `AgentProfile` entity (tier · charter · defaultModel · allowedTools · mcpServers · skills) + storage
- [ ] `startAgentRun(profileId, { trigger, goal|thread, projectId?, workflowId? })` generalizing `startRun`
- [ ] Authority gating: `--allowedTools` allowlist per tier (coding tools at lead tier only)
- [ ] `logistics-mcp` (K) + reuse Google Calendar / Gmail / Drive connectors
- [ ] Memory layer A: per-profile markdown lessons + gated end-of-run reflection (operator-approved)
- [ ] K runtime (hybrid): durable thread + warm interactive session + fresh-seeded run on restart/idle/wake
- [ ] `agent_tasks` (K-owned global checklists) distinct from `project_tasks`
- [ ] K-home dashboard surface (the friendly landing)

### 5.2 — Chief

- [ ] Chief profile (chief tier) + `mgmt-mcp` (assign-lead / pick-workflow / scope-projects / report)
- [ ] Reuse GitNexus MCP read-only for the Chief
- [ ] Autonomous wake via the Phase-3 scheduler + event listener (schedule/event triggers)
- [ ] K → Chief delegation (engineering work only) + report-back up the chain
- [ ] Chief dashboard surface (assignments board, wake history, read-only control-plane mirror)

### 5.3 — Roster + Workflows

- [ ] Orchestrator leads (Frontend · Backend · Systems · Security · Network) as profiles + charters
- [ ] Status-write MCP for leads; per-lead skills/tools/MCP scoping (the control plane)
- [ ] `WorkflowDefinition` generalizing `buildDelegationPrompt`; `implement+review` as the first definition
- [ ] Cross-project scope flag in the schema (multi-project execution deferred)
- [ ] Orchestrator-detail surface: charter/skills/tools/MCP/memory editors + persistent authority panel + live delegation tree
- [ ] Settings org / MCP authority-tier panel

### 5.4 — Voice

- [ ] Voice in/out for the K conversation (talk to K hands-free)

## Phase 6 — Intelligence & Scale *(optional)*

- [ ] EventBus → NATS/Redis Streams + worker processes
- [ ] Analytics on run data for routing improvement (memory layer B: structured store + outcome-weighted retrieval)
- [ ] Verification/eval-derived lessons (memory layer C)
- [ ] Knowledge-graph-driven agent context (GitNexus → agent prompts)
