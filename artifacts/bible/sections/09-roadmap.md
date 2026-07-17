---
title: Roadmap
icon: "➤"
status: active
updated: 2026-07-16
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

**Update (2026-07-10) — the desktop app is now DELIVERED, re-scoped from Tauri to Electron.** The bundled-core / tray / native-notification desktop app deferred above shipped as a **Windows Electron app** in a new `desktop/` workspace: core runs as a Node-20 child, the SPA is served same-origin, the shell auto-authenticates, and it installs via NSIS with unsigned auto-update from public GitHub Releases. See **§15 Desktop App** and **D-089 → D-094**. (PWA mobile, cross-platform builds, code-signing, and passkey/TOTP auth hardening remain deferred.)

## Stabilization (Foundation) — reboot to a running org *(✓ 2026-06-30)*

> Before building the org (Phase 5), take K from "well-built substrate + parked work" to a solid, verified
> foundation: fix the confirmed bug backlog, pay down structural debt that would otherwise be copied into the
> org layer, lift the eval methodology into the engine, and make the last stubbed health factor live. Plan of
> record: `~/.claude/plans/read-through-and-analyze-floating-sifakis.md`. One reviewable commit per wave
> (implementer → review → controller); a whole-foundation fresh-eyes review before close.

- [x] **F0 — Baseline & hygiene.** Pushed local `main` (the unbacked-up Phase-5 groundwork) to `origin/main`;
  folded the rigorous-testing campaign + the `testing/` infra & `regressions/` quarantine into trunk; cut the
  `feat/k-reboot` integration branch; pruned stale branches; recorded a clean-tree baseline.
- [x] **F1 — Fault triage & remediation.** All **18 confirmed faults** (2 High · 6 Med · 10 Low) fixed at
  root; each RED quarantine test promoted into the gating suite with its FAULT row dropped —
  `test:regressions` quarantine is **empty** (core + web).
- [x] **F2 — Core structural refinement** *(behavior-preserving)*. Extracted the 3×-duplicated supervised-run
  lifecycle into `run-lifecycle.ts::trackSupervisedRun` (**the seam `startAgentRun` extends in 5.1**); de-duplicated
  the path-guard / `escHtml` / `TERMINAL`-set / row-mapper utilities; removed dead parser params. Campaign LOCK
  tests guarded against drift.
- [x] **F3 — Eval, integrated into the engine** (D-035). Lifted the out-of-band `testing/eval/` harness into
  `core/src/eval/*` as a DB-backed (`eval_systems`/`eval_cases`/`eval_runs`/`eval_results`/`eval_baselines`),
  dashboard-surfaced, operator-triggerable subsystem; `POST /api/evals/run` + report/baseline GETs; an **Evals**
  dashboard. **Token-gated:** every layer (service · route · runner) defaults `dry:true`; a real spend run needs
  an explicit `dry:false`.
- [x] **F4 — Stabilization close-out** (D-036). Wired a **live coverage-trend signal** into `verify.ts`
  (killed the hardcoded `unknown` stub so the 20-pt factor is live); whole-foundation fresh-eyes SEAMS review;
  bible + decision-log close-out; full clean-tree gate. **GATE: substrate solid** — the precondition for Phase 5.

## Phase 5 — Agentic Org *(✓ 2026-07-02 — the Agentic Org delivered on `feat/k-org`; `--no-ff` merge to `main` at close-out)*

> Re-frame the product from "an operator drives a dashboard" to "the user directs an agent
> **organization**" (§03, §04): **K** the friendly secretary → the **Chief** manager → staff-engineer
> **orchestrator leads** → workflow definitions → role subagents. All three durable tiers are one
> `AgentProfile` entity gated by an **authority tier**, enforced by **tier-scoped MCP servers** +
> the `--allowedTools` allowlist. Memory starts at **layer A** (file lessons + gated reflection).
> Decisions D-020 → D-025 (+ D-030 / D-031 for local-model management & voice). One reviewable commit
> per wave (delegation loop + review every wave).

### 5.1 — Foundation + K

- [x] `AgentProfile` entity (tier · charter · defaultModel · allowedTools · mcpServers · skills) + storage
- [x] `startAgentRun(profileId, { trigger, goal|thread, projectId?, workflowId? })` generalizing `startRun`
- [x] Authority gating: `--allowedTools` allowlist per tier (coding tools at lead tier only)
- [x] `logistics-mcp` (K) — shipped (D-039). **Honesty note (2026-07-02):** the second half of this
  box over-claimed — the **Google Calendar / Gmail / Drive connectors are NOT wired into K** (they
  remain operator-side only; K's tier mounts kstore + logistics and nothing else — §03). Wiring the
  real connectors stays an open follow-up
- [x] Memory layer A: per-profile markdown lessons + gated end-of-run reflection (operator-approved)
- [x] K runtime (hybrid): durable thread + warm interactive session + fresh-seeded run on restart/idle/wake
  — **runtime redesigned (2026-07-04, D-062):** the warm/fresh hybrid became a **resumable one-shot**
  (a stable per-thread `--session-id`/`--resume` CLI session, answer-and-exit, no park); the durable
  thread stays the source of truth
- [x] `agent_tasks` (K-owned global checklists) distinct from `project_tasks` — **delivered as the
  OPPOSITE design (2026-07-02 annotation):** there is no `agent_tasks` table and no split — the
  as-built model is the **unified `work_items` store with scopes** (`run`/`personal`/`org`/`project`,
  D-026 → D-048 → D-053); `project_tasks` itself was later dropped (D-058). The *capability* the box
  wanted (K-owned durable checklists) ships as the `personal`/`org` scopes
- [x] K-home dashboard surface (the friendly landing)

### 5.2 — Chief

- [x] Chief profile (chief tier) + `mgmt-mcp` (assign-lead / pick-workflow / scope-projects / report)
- [x] Reuse GitNexus MCP read-only for the Chief
- [x] Autonomous wake via the Phase-3 scheduler + event listener (schedule/event triggers)
- [x] K → Chief delegation (engineering work only) + report-back up the chain
- [x] Chief dashboard surface (assignments board, wake history, read-only control-plane mirror)

### 5.3 — Roster + Workflows

- [x] Orchestrator leads (Frontend · Backend · Systems · Security · Network) as profiles + charters
- [x] Status-write MCP for leads; per-lead skills/tools/MCP scoping (the control plane)
- [x] `WorkflowDefinition` generalizing `buildDelegationPrompt`; `implement+review` as the first definition
- [x] Cross-project scope flag in the schema (multi-project execution deferred)
- [x] Orchestrator-detail surface: charter/skills/tools/MCP/memory editors + persistent authority panel + live delegation tree
- [x] Settings org / MCP authority-tier panel

### 5.4 — Voice

> Talk to your agents instead of typing. v1 is **push-to-talk in** via a new TranscriptionProvider
> B-seam + a local Whisper service; voice-out (TTS) is a later wave. Decision D-031.

- [x] **Push-to-talk in (v1).** `TranscriptionProvider` B-seam (`transcribe(audio)→{text}`) + a default local Whisper (faster-whisper) impl; `POST /api/transcribe` (core proxies — browser holds no key); `ENABLE_VOICE` / `WHISPER_BASE_URL` config; graceful degrade to keyboard when unreachable
- [x] **Mic in every composer.** `useVoiceRecorder` (`MediaRecorder`) + a `MicButton` wired into the K composer, the ⌘K bar, and the HITL reply box; transcript inserts as ordinary text into the existing dispatch / reply flow
- [x] **Voice status card** in Settings (engine reachable · model · enable toggle)
- [ ] Voice **out** (TTS — K talks back) — **deferred** to a later wave *(un-checked 2026-07-02:
  this line was marked done while saying "deferred"; nothing TTS has shipped)*

### 5.5 — Local model management *(extends the ModelRouter seam — independent of the org tiers)*

> See and shape the local models behind the router from the UI: discover, download, and select —
> with the selection applied live. Decision D-030.

- [x] `app_config` store + `route()` getters → the active Ollama model is operator-selectable and **hot-swappable, no restart**
- [x] Model surface over the Ollama HTTP API: list installed (`/api/tags`), pull with live progress on the EventBus→WS wire (`/api/pull`), remove (`/api/delete`)
- [x] Curated catalog (sizes) + `fs.statfs` disk-fit check; advanced free-form "pull any tag"
- [x] Settings → **Local models** surface (installed · catalog · active selector · live download progress); dynamic Ollama models in the dispatch picker

### 5.6 — Close-out *(✓ 2026-07-02)*

> Multi-tier org observability, the whole-org SEAMS review, docs + decision-log finalize, and the
> `--no-ff` merge to `main`.

- [x] **Autonomous execution loop** (D-049 → D-051) — split into `a` (dispatch intent + wake wiring),
  `b1` (the MAIN-process `lead-dispatch-relay` decoupling: `dispatch_lead` records a `pending` intent
  in the mgmt-server child, the main process CAS-claims + executes it so the lead's `agent_runs`
  finalizes and the lead→Chief report-back fires on the main EventBus), and `b2` (Chief→K continuation
  + the multi-tier org `DelegationTree` render).
- [x] **Multi-tier org observability** — the per-run sub-agent tree generalized to the whole-org tree
  (`fullOrgToDelegationTree` over the tagged `AgentEvent` stream + `agent_runs`/`k_thread_turns` links;
  the K→Chief edge derived from `kDelegations`), §13.
- [x] **Whole-org fresh-eyes SEAMS review** across the full `feat/k-org` diff — 7 seams PASS,
  0 blocker/major, 1 minor fixed pre-merge (the lead charter referenced a non-existent `github` MCP
  tool; corrected to `gh pr create` over the granted Bash path). Verdict: MERGE-WITH-FOLLOWUPS.
- [x] **Full verification green from a clean tree** — typecheck · core 1317 / web 407 · build; CI green
  on `feat/k-org`.
- [x] Bible §03/§04/§08/§13 + this roadmap + decision log (D-020 → D-052) finalized; lessons captured.

**Live smokes passed** (each an operator-approved narrow real dispatch): P5.0 `startAgentRun` reaches
terminal + finalizes once; "talk to K" routes a request with the route shown inline; the
autonomous-loop **relay** drains a Chief-recorded intent → a real lead run runs, finalizes
(`agent_runs`→completed), links the assignment, and reports back up the chain.

**Delivered via splits** (each its own reviewable wave): 5.1 → a–f (K profile · logistics-mcp ·
memory-A · hybrid runtime · task-model scope + the `work_items` storage collapse · K-home UI);
5.2 → a/b (Chief + mgmt-mcp + wake · Chief org-status UI + the reusable `DelegationTree`); 5.3 → a/b
(roster + `WorkflowDefinition` + control plane · Orchestrators/Workflows UI + editors).

**Deferred (post-merge follow-ups, non-breaking):** the P5.1d2b task-store reroute (drop
`project_tasks`; move `routes/projects.ts` / `syncIssues` / Tasks-UI off the compat shim; the
`work_item_create` `scope='project'` guard + the `updateProjectTaskFromIssue` project_id bind); the
full K→Chief→lead→**PR** end-to-end live run (operator-gated token spend — the relay mechanic is
already smoke-proven); and the low-severity review nits (hardcoded operator name; grant-guard
substring→typed error class; `concatAssistantText` unbounded read; `kDelegations` counts failed).
*(The d2b reroute and every listed nit were delivered in 5.7 below; the live PR run stays
token-gated.)*

### 5.7 — Post-merge fix delivery *(✓ 2026-07-02)*

> A deep whole-system review of the merged Phase-5 org surfaced honesty gaps (cosmetic authority
> editors, ignored project scoping, frozen model seeds, run-scoped stores that should be durable,
> the d2b debt, unguarded wake spend, and UI drift from the approved demo). Six waves on
> `feat/k-fixes` closed them — every wave conductor-reviewed, all integrated CI-green.

- [x] **C1 — web bug fixes.** K-home no longer auto-navigates on send (the 5 s undo toast stays in
  place with a *View run →* link; a second send restarts the countdown); dialog focus traps + ⌘K
  a11y; live `run_update` WS invalidation of chief-org / orchestrators queries (throttled 250 ms);
  real TopBar breadcrumbs (Orchestrators › name, Workflows › name, Projects › name); shared
  runs-query key module; visible error states on K-home; `--on-accent` token; `.worktrees/`
  gitignored.
- [x] **B1 — authority enforcement + project-scoped dispatch + runtime model (D-054/D-055/D-056).**
  `synthesizeConfigDir` honors the per-profile authority rows within the tier CEILING, fail-closed
  validate-before-mutate; the relay resolves `scope_projects` → the projects registry and passes
  `projectId`+`cwd` so leads run in the scoped repo; `default_model` un-frozen to the `''`
  "runtime default" sentinel + one-shot migration; per-ask model override wins over profile over
  runtime.
- [x] **A1 — durable operator-global stores (D-053).** `work_items` scope `'run'|'personal'|'org'|
  'project'` (new `'run'` = the old run-isolated semantics, kstore default); durable personal/org +
  the `GET/POST/PATCH /api/k/work-items` surface; one-shot table rebuild re-stamping legacy
  personal AND org rows to `'run'`; logistics de-run-scoped; mgmt `assignment_list`/`report_list`
  read tools; `agent_memory.profile_id` populated + backfilled.
- [x] **A2 — d2b completion (D-058).** `project_tasks` DROPPED after a final one-shot backfill
  (kills the boot-resurrection of deleted tasks); `projectTasksDb`→`projectWorkItemsDb` as the
  first-class project surface (zero HTTP shape change); partial UNIQUE `(project_id, issue_number)`
  index + dedupe; `updateProjectTaskFromIssue` binds `project_id`; poller `pathMissing` degrade.
- [x] **B2 — hygiene + wake governor (D-057/D-059).** Org-relevance filter + rolling-hour cap
  (`chief_wake_max_per_hour`, default 6; suppressed wakes create no rows) + `chief_wake_events_enabled`
  kill switch on event wakes; K routing logistics-precedence; bounded assistant-text reads +
  report caps; `isPathWithin` resolves both sides (fixes the mixed-separator dispatch brick); typed
  `GrantError`; `migrate()` `user_version` fast path; stranded-thread boot sweep.
- [x] **C2 — UI pragmatic parity (+ D-060).** K-home real durable personal work items + Notes +
  Schedule cards (`GET /api/k/notes`/`/api/k/schedule`) + composer power controls (model override +
  forced route); Chief actuation (hand-work composer, operator reassign `PATCH
  /api/chief/assignments/:id`, tree inspector Open-lead / View-run / Stop-run); per-lead recent-health
  lines + `effectiveModel` chip + authority add-affordances; the "Run this workflow" launcher
  (dispatch accepts `workflowId`, scaffold swap) + workflow-filtered run-tree picker; plus the
  dispatch-retirement liveness fix (D-060) unwedging re-dispatch/reassign.

**Gates.** Full fresh-tree verification after every wave; final: typecheck · **core 1317 → 1463**
passed (1 skipped) · **web 407 → 457** passed · build, CI green on `feat/k-fixes`.

**Conductor-review catches** (each fixed in-wave, none shipped broken): the relay's post-claim
**strand window** (a scope-read throw left a claimed intent `'dispatched'` forever → degrade-to-failed
inside the try); the **legacy-org escalation** (the A1 re-stamp originally covered only `personal` —
an untouched legacy `org` row would have silently entered the durable operator view); the
**version-gate ordering hazard** (stamp only after a successful scan; second-migrate tests reset
`user_version` so slow-path idempotency stays under test); and the **dispatch-retirement wedge**
(one successful dispatch permanently blocked re-dispatch and reassign — D-060).

**Deferred / consciously not built:** `isPathWithin` Windows **case-insensitivity** (two casings of
one path can still compare unequal — fail-safe: it rejects, never escapes); the **MemoryPage
double-fetch** (filter options derive from a second lessons read); **mixed-intent messages
under-escalate by design** (a logistics keyword keeps an engineering ask with K — the cheap failure
direction, D-057); the demo's **Interactive checkbox for K sends dropped** (it maps to nothing — the
K path is already interactive by design); and the demo's **health scores/bands, tier radios, and
per-lead hues** consciously not built (pragmatic parity: real derived health lines shipped instead
of invented numbers).

## K Expansion — Phase 5: Autonomy *(✓ 2026-07-13 — `feat/exp-p5`, schema v11→v12)*

> The K Expansion Program's autonomy phase (E-14..E-18, E-27): the org can generate its own work,
> pull it, retry its own failures, cap its own spend, and derive its own lessons — **all behind one
> persisted, default-OFF operator choice** (Settings → Autonomous Org, D-107..D-109). Decisions
> D-107..D-113. One reviewable commit per lane; a whole-phase SEAMS review before merge.

- [x] **Front door — Autonomous Org (D-107..D-109).** `CHIEF_WAKE` → a persisted `app_config`
  (`autonomy.settings`) choice: master `enabled` (default OFF) + sub-toggles + max-concurrency + org
  budget cap + warn %, on a new `SettingsAutonomy.tsx` section; the env is deprecated warn-only; the
  schedulers always wire + gate per-tick so enabling ON needs no restart; Agents→Org shows a read-only
  status chip (§03, §08).
- [x] **Master gate (D-108).** `autonomySettings().enabled` gates chief auto-wake + proposals +
  backlog auto-pull + self-heal; the **budget governor is the always-on exception** (a safety cap,
  applies even when autonomy is OFF once set).
- [x] **E-14 proposals.** Deterministic ZERO-TOKEN collectors (ci_failed / verify_finding / open_issue
  / stale_bible) on a 15m cron → `blocked` `org` work_items with `source`/`source_key`, deduped +
  open-capped; Inbox proposal cards approve→`open` / dismiss→`cancelled` (sticky). Honest one-shot-per-
  project + no-undo limitations documented (D-111; §04, §07, §08).
- [x] **E-15 backlog auto-pull.** An interval relay CAS-claims the oldest `open` org item
  (`open→in_progress`), governed by the budget gate + max-concurrency; dispatches under the default
  orchestrator (§04).
- [x] **E-17 budget governor.** Reactive caps on MEASURED `runs.cost_usd` over a rolling 24h window —
  ZERO forecasting; org + per-project caps; at cap a dispatch is PARKED (`429`/`BudgetCapError`), no
  queue. Interactive/persistent K exempt; operator-action routes a tracked follow-up (D-112; §13).
- [x] **E-18 self-heal.** Deterministic failure classification off the last error event → retry with a
  fallback model (retry_count<2, budget headroom, original cwd, `retry_of` lineage, `run_retried`) or
  PARK an Inbox proposal with a one-line diagnosis; killed/interrupted skipped (§07).
- [x] **E-27 eval-derived lessons.** Repeated (≥2) same-signature failures → ONE deduped, capped
  pending `agent_memory` lesson through the existing D-041 gate (no new UI); off `verify_results` only,
  `eval_results` deferred (D-113; §04 memory layer C, §07).
- [x] **E-16 routines first-class.** The Automations tab (Agents→Skills) gains an NL→cron helper
  (rules-only, `400` on unmappable), next-run display, and measured cost per routine — no new table,
  no new rail slot (D-110; §08).
- [x] **Insights → Charts.** Budget burn-down (measured 24h) + retry-rate charts (§13).
- [x] **Schema v11→v12.** `work_items.source`/`source_key` (+ partial-unique idx); `runs.retry_of`/
  `retry_count`/`failure_class`; `projects.budget_daily_usd`; the `autonomy.settings` blob.

**Deferred / honest limits (default-OFF, tracked):** ~~project-keyed proposal source_keys are
**one-shot per project** (a genuine recurrence isn't re-surfaced until the row clears) and inbox
dismiss has **no undo** (D-111); the budget park does not yet gate operator-initiated action routes
(rewind / review-fix / deep-verify / workflows / run-skill-now — D-112); E-27 covers `verify_results`
only (`eval_results` has no failure-reason column — D-113).~~ **All four resolved in the Impressive
Wave (below):** proposal re-nag after 7 days (P5-FU-3), inbox dismiss undo (FE-7), budget park now
gates the operator action routes (P5-FU-1), and `eval_results.failure_reason` now feeds the lesson
gate (P5-FU-5).

## Impressive Wave — Liquid Glass 2.0 + feature verticals + backlog burn-down *(✓ 2026-07-16 — `feat/impressive-wave`, schema v12→v13)*

> Made the Command Deck **impressive, not just professional**, closed the artifacts / help / code-review
> feature gaps, and burned down the P5 + dev-env-hardening follow-up backlog. Method: a Wave 0 Liquid
> Glass 2.0 foundation that freezes cross-lane contracts → two parallel lane worktrees (FE 16 tasks /
> BE 13 tasks, each whole-lane-reviewed MERGE-READY) → serial integration + a whole-implementation
> review (STANDARDS HELD) + a 1440×900 visual/blur sweep + a real-dispatch live smoke ($0.131255
> measured). Decisions **D-115..D-118**.

- [x] **Liquid Glass 2.0 (D-115).** Living hue-drift ambient blobs, SVG `#lg-refract` edge refraction
  (Chromium-first, `@supports`-guarded, additive fallback), specular gradient borders, cursor
  `.glass-interactive` sheen; tier fills .55/.72/.82→**.48/.64/.76** (AA-gated, not aesthetic); motion
  v2 (`useCountUp` / `chartDraw` / `successSweep`). Token-driven, reduced-motion/coarse-pointer safe (§08).
- [x] **In-app Help guide (D-116).** A 7-page `web/src/help` dialog (first-run auto-open once); Help no
  longer deep-links the bible (§08, §12).
- [x] **Artifact registry + scan (D-117).** `artifacts.project_id` + `origin`, idempotent path-guarded
  filesystem scan (`POST /api/projects/:id/artifacts/scan`); ArtifactsTab becomes a gallery of ALL of a
  project's `.html` artifacts, not just the bible (§05, §11).
- [x] **Changes surface + DiffViewer v2 (D-118).** Full-screen `#/pr-review/<projectId>/<n>` GitHub-style
  review — file tree, refractor syntax highlight (`--code-*` tokens), word-level diff, unified/split,
  viewed marks, run context-expand; PR side read-only (§08, §12).
- [x] **Impressive pass.** One `Row` primitive + one empty-state system, glass-where-it-matters sweep,
  chart tooltips + KPI sparklines, TopBar "Message K" pill removed, Insights defaults to Charts; the 5
  audit defects fixed (bible-iframe overflow, single-node giant-sphere graph, raw-markdown run console,
  FAB overlap, duplicate bible rail entry).
- [x] **Data honesty (BE-3).** ONE terminal-weighted success-rate definition shared by Overview + Charts
  (resolves the 80%-vs-34.7% contradiction); `verify-result` returns 200-null (no 404 noise); the
  claude-probe status contradiction reconciled (§13).
- [x] **P5 follow-ups closed.** Budget park gates the operator action routes (P5-FU-1, D-112); proposal
  re-nag after 7 days (P5-FU-3, D-111); retry-rate zero-fill (P5-FU-4); `eval_results.failure_reason`
  feeds the D-041 lesson gate (P5-FU-5, D-113).
- [x] **Dev-env hardening closed.** Bible §11 data-locations fix (DEH-FU-1), upgrade-smoke hardenings
  (FU-2), committed poisoned-fixture CI gate (FU-3), ollama-branch env scrub (FU-4), vitest realpath
  live-dir guard (FU-6).
- [x] **Schema v12→v13.** `artifacts.project_id` / `origin`; `eval_results.failure_reason`.

**Accepted deviation:** Home → Overview lands at **8** simultaneously-blurred regions vs the soft ≤6
budget (5 glass widget cells + 3 glass chrome bars) — accepted as a documented, perf-justified
exception (the INT.5 trace measured a `LayoutCount` delta of 0 at eight regions); ≤6 remains the target
for new surfaces (§08).

**Deferred (non-blocking fast-follows):** DiffViewer's "viewed" toggle uses a raw checkbox rather than
the `Checkbox` primitive; the HelpGuide remembers its page across reopen; §12's broader "Dashboard tour"
still narrates the pre-UI-Simplification shell (the mandated Help + run/PR-review sections landed this
wave; a full §12 rewrite is deferred); a pre-existing latent `/^routes\s*/` escape in the ui-demo's
`dispatchSend` predates this program.

## Orchestration Program — Phase 1: Executable Pipeline Engine (D-119)

*The deferred D-012 `workflow_stages`, built 2026-07-16 on `feat/pipeline-engine` (schema v13→v14). Turns prose-delegation-in-one-run into real staged, per-stage-visible pipelines — the substrate for the later phases below.*

- [x] **Executable pipeline DAG.** `PipelineSpec` (evolves `workflow_definitions.spec`) with `agent`/`deterministic`/`gate`/`hook` stages + per-edge handoff (`share-tree`/`branch`/`merge`, parallel fan-out/fan-in); a main-process `PipelineEngine`+scheduler (lead-relay-shaped: DB ledger + CAS claim), checkpoint handoff to sweep-immune `refs/k-pipelines/…`, retry-in-place (factored self-heal brain + `runs.pipeline_stage_id` ownership guard), gates (declarative + dynamic `insertGate`, CAS resolve) + conditional forward routing (`markSkips` + skip-aware finalize), reboot reconcile, `StageExecutor` seam (Docker later).
- [x] **Delegation + API + UI.** `delegate_pipeline` (kstore tool → `pipeline-dispatch-relay` → `onPipelineTerminal` report-back to K); `GET/POST /api/pipelines/*` (8 endpoints, budget-gated `/run`, gate/rewind/cancel); an upgraded Agents→Pipelines tab (hand-laid live DAG + stage cards + gate dialog + launcher, `pipeline_update` WS).
- [x] **Reference pipelines + hook stages.** Seeded `code-wave`/`investigate`/`refactor`; the `hook` stage kind's script `HookResult` contract (`continue`/`gate`/`transform`).

**Deferred within Phase 1 (documented):** repair-LOOP back-edges (forward routing + retry-in-place instead); `commit`/`ci` deterministic actions (agents open their own PRs); hook `inject` cross-stage propagation + agent-hook structured `HookResult`.

## Orchestration Program — Phase 2: Pipeline Library, IA & Orchestration Visibility (D-120)

*Made the Phase-1 engine usable, built 2026-07-16 on `feat/orchestration-p2` (schema v14→v15). Method: a W0 shared-contract foundation → three parallel reviewed worktree lanes (engine / registry+schedules / UI+integration) → serial integration → two opus SEAMS reviews (both approved).*

- [x] **Agents IA restructure.** Top tabs **Org / Catalog / Automations** (`AgentsPage`); Catalog's 4 sub-tabs **Skills / MCP / Hooks / Sub Agents**; Automations unifies **Library / Runs / Schedules** into one pipeline surface — replaces D-101's Org·Skills·Pipelines split; legacy `#/agents/skills/*` and `#/agents/pipelines/*` deep links redirect in.
- [x] **Editable sub-agent worker registry.** K-native workers (`agent-config/agents/*.md`, forkable, read-only until forked) + full-CRUD operator workers (`sub_agent_defs` table, `/api/sub-agents`); a pipeline `agent` stage names its worker via `subagentType`.
- [x] **Bounded loops.** `when:'loop'` edges + `maxIterations` (≤10) in the engine, with a corrected finalize that never yields a false-COMPLETED mid-loop.
- [x] **Standard pipeline library.** 6 seeded, executable pipelines — Implementation Cycle, Deep Research, Bug Triage & Fix, Refactor, Security Audit, Quick Task — composing sequential/parallel/loop/gate patterns with K-native workers as stage actors.
- [x] **Legacy migration.** `NamedWorkflow` templates + `type:'workflow'` skills convert to `PipelineSpec` defs at boot (idempotent, fail-safe); the legacy `WorkflowsView` UI retired.
- [x] **Progress ledger + orchestrator multi-pipeline view.** `pipeline_ledger` (per-run append-only) + a `pipeline_update` WS ledger cursor; pipeline runs group by owning orchestrator via `pipeline_runs.owner_profile_id`, stamped from the delegating orchestrator (incl. retries).
- [x] **Pipeline cron schedules.** A scheduled `skills` routine can target a pipeline via `skills.pipeline_def_id` — manual + cron, surfaced on Automations → Schedules.
- [x] **Input-sweep + header polish.** Raw `<input>`/`<textarea>`/`<select>` swept to the `ui/Field.tsx` primitives; the page-header tab icon removed from `TopBar`'s title (title/breadcrumb only now).
- [x] **Schema v14→v15.**

**Deferred (documented):** **operator-worker EXECUTION** (Phase 2.5 — registry/editing/K-native execution all work, but an operator-authored worker isn't yet mounted as a live stage actor: the create-time materializer, DB row → confined `data/agents/<id>/` file, is unbuilt, and the operator mount is nested while Claude Code discovers subagents flat — this is the code-execution entrypoint and gets its own design + security pass); the **autonomous multi-pipeline supervision loop** (a later phase; this wave built the ledger + hook seams it will consume); **event triggers** for pipelines (manual + cron shipped, event deferred); **loop re-fork semantics** (a loop re-entry re-forks from the loop head's pre-loop base, not the prior iteration's result tree — deliberate; cross-stage tree-carry is a Phase-3/injection concern).

**Later phases of the Orchestration Program:**
- [ ] **Phase 1.5 — Run-internal operator hooks.** Generalize the config-dir hook mounting (PreToolUse/PreSkill), confined operator scripts, gitnexus-as-registry-row, trust card. *(Operator-deferred from Phase 1; pairs with Phase 3.)*
- [ ] **Phase 2.5 — Operator-worker execution.** The create-time materializer (DB row → confined `data/agents/<id>/` file) + a flat-discovery-compatible mount, so an operator-authored sub-agent worker actually runs as a live pipeline stage actor, not just a registry row. *(Deferred from Phase 2, above.)*
- [ ] **Phase 3 — Context/memory injection intelligence.** The ContextAssembler + memory-retrieval loop that fills the hook-`inject` + injection seam (subsumes the old "memory layer B" item below).
- [ ] **Phase 4 — Sandboxes.** Docker `StageExecutor`; ephemeral + persistent sandboxes; Playwright / native-desktop verification stages.
- [ ] **Phase 5 — Token-efficiency & scale.** Skill promotion, caching/dedup, cheap-model routing for mechanical stages, high-concurrency scheduling; **+ intent & auto-delegation** (moved here from the old Phase-2 slot — K decomposes/scopes and auto-selects a pipeline from a vague request, be-less-precise).

## Phase 6 — Intelligence & Scale *(optional)*

- [ ] EventBus → NATS/Redis Streams + worker processes
- [ ] Analytics on run data for routing improvement (memory layer B: structured store + outcome-weighted retrieval)
- [ ] Verification/eval-derived lessons (memory layer C)
- [ ] Knowledge-graph-driven agent context (GitNexus → agent prompts)
