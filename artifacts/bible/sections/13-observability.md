---
title: Observability
icon: "👁"
status: active
updated: 2026-07-14
---

Phase 4's Track D makes the harness **observable**: you can see exactly what an agent did at runtime — every command, file edit, and delegated sub-agent — visualize the delegation loop both as designed and as it actually ran, and watch context pressure against the model's window. It all rests on one foundation: enriching each agent event with structured tool data at parse time, then deriving every view from that data on the client. This section tells that story end-to-end; §08 covers the dashboard *surfaces* it powers. The *Implementation history* appendix at the end records the as-built dashboard milestones (Phases G / H / 4) moved out of §08 so that section stays a spec.

## Event-data enrichment foundation (D3, D-015)

The Claude CLI streams newline-delimited JSON (`--output-format stream-json`). Historically the supervisor kept only a display string + token/cost projections, so the UI could show a flat transcript but nothing structured. D3 enriched `parseClaudeLine` (`core/src/providers.ts`) so each `AgentEvent` now carries the structured fields the richer views need:

- `toolUseId` — the join key (`block.id` on a `tool_use`, `block.tool_use_id` on a `tool_result`).
- `toolKind` — `command | file | delegate | other`, from a pure table-driven `classifyTool(name)` (`Bash`→command; `Write`/`Edit`/`MultiEdit`/`NotebookEdit`→file; `Task`/`Agent`→delegate; else other).
- `toolInput` / `toolResult` — the raw input object and the result content, stored as JSON.
- `toolResultIsError` — the tri-state `is_error` (often absent → left unset).
- `subagentType` / `childLabel` — delegate-only: the sub-agent type (absent → default agent) and a human label.
- `contextTokens` — the full input context size for the turn (see Context observability below).

**Pairing by `tool_use_id`.** A `tool_use` block arrives on an **assistant** event and its matching `tool_result` arrives later on a separate **user** event — they are never one event. So the enriched event stores `toolUseId` as a durable join key, and the client pairs them by equal id (`pairToolCalls` in `web/src/lib/console.ts`). A tool whose result hasn't arrived yet renders as **pending**.

**Persistence.** The `events` table gained the matching columns via a **race-tolerant** `ALTER TABLE ADD COLUMN` migration (tolerates a concurrent connection's "duplicate column" so multi-process / CI boots are safe); JSON columns are projected back defensively so one corrupt row can't 500 the list. The fields ride the WebSocket inline for live runs **and** persist, so a reloaded historical run shows the same structured detail.

## Rich run console (D4)

The console derives entirely from the enriched events — it never re-parses raw JSON per render. Pure helpers in `web/src/lib/console.ts` pair tool calls and coalesce consecutive ones into visual groups; `ToolCall.tsx` renders each kind collapsed-by-default with a framer-motion reveal (honoring the app-wide reduced-motion config):

- **Command** — the `$ command` summary; output (and the optional description) on expand.
- **File** — `Write` shows a new-content preview; `Edit`/`MultiEdit` show old→new diff hunks (one labelled hunk per edit).
- **Delegate** — the sub-agent type + label as the summary; the full delegated prompt and the sub-agent's result on expand.

Error styling appears only when a result is explicitly flagged an error. Every derivation helper tolerates malformed shapes and never throws — a single bad event can't crash the list.

## Workflow visualization (D5, D-016)

The harness delegation loop is **prose methodology**, not a code object, so its canonical shape lives as a single shared constant — `DELEGATION_WORKFLOW` in `@k/shared` — that both client and server import (no new endpoint for static data). The Workflows page (§08) renders three complementary views:

- **Defined loop** — a hand-laid CSS/SVG diagram of the four roles (orchestrator → implementer → spec-review / quality-review → orchestrator) with their responsibilities. A purpose-built diagram (not a force-graph) is the right tool for a tiny fixed hierarchy and carries no WebGL/AFRAME crash risk.
- **Live runtime sub-agent tree** — derived for a chosen run from that run's `delegate` tool calls. **Delegated agents run IN-PROCESS via the `Task` tool** (the CLI's subagent-spawn tool-id; "agent" stays the prose concept — §03), so a run's sub-agents *are* its `delegate` tool calls: `eventsToWorkflowTree` (`web/src/lib/workflow.ts`) reuses the D3/D4 pairing helpers to build root-plus-children, each child carrying status (running/done/error), the delegated prompt, and the result. There is no separate "sub-run" table to consult.
- **Workflow status checklist (Phase 5)** — the *explicit* progress surface, distinct from the inferred tree above: what the orchestrator **says** it is doing. The orchestrator reports each ticket, loop phase, review, and the **CI** gate through the kstore status-write tools (`workflow_step_set` / `workflow_status_set`), which write the `workflow_steps` table keyed to the run's `workflow_runs` row (resolved from the injected `K_RUN_ID`). `GET /api/runs/:id/workflow-steps` returns them seq-ordered, and the `WorkflowChecklist` panel renders each step with its kind (ticket · phase · review · CI) and status (pending / in_progress / done / blocked / failed), polling while the run is live. The inferred tree shows what *happened*; the checklist shows what the orchestrator *intends and tracks*.

## Context observability + compaction (D6, D-018)

**The indicator.** Each run's header shows context pressure as `ctx X / Y · Z%` with a band-colored bar — **ok** < 70%, **warn ≥ 70%**, **danger ≥ 90%** — and a muted `ctx —` when the model's window is unknown (local/unrecognized model). The window comes from `modelContextWindow(id)` over the `KNOWN_MODELS` registry (200k for the Claude models). Pure logic lives in `web/src/lib/context.ts` (`latestContextTokens` picks the highest-`seq` context signal; `contextPressure` clamps the percent and buckets the band) and is fully unit-tested.

**Counting the right number.** The CLI's per-assistant-turn `usage.input_tokens` is **fresh input only** — it excludes cache. True context occupancy is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. The parser computes that sum into a separate `contextTokens` field (D6 left the per-turn `tokensIn` projections untouched, so cost/metrics accounting stays unchanged), and it is **persisted** as the `events.context_tokens` column so a reloaded run reflects the pressure it actually reached rather than falling back to the cache-excluding figure.

**Compaction — the `/compact` story (honest reversal).** D6 was planned around the assumption that REPL slash-commands can't be forced over the stream-json input wire, so it would degrade to a soft "summarize & continue". The **D6.0 live smoke overturned that**: sending one `{type:"user",message:{role:"user",content:"/compact"}}` turn made the CLI run its real compaction machinery (`{type:"system",subtype:"status",status:"compacting"}` → `compact_result`). So **on-demand compaction CAN be forced via `sendInput('/compact')`**, and Phase 4 shipped real compaction:

- A manual **Compact context** button in the HITL box that sends `/compact`.
- A **guarded, debounced auto-compaction** (`nextAutoCompact`, pure hysteresis): it fires `/compact` at most once per danger episode and re-arms only after context recovers to `ok`; it never fires unless the run is interactive and parked at `awaiting_input`, and never while a send is in flight or the operator is mid-answer. A `/compact` turn ends with `{type:"result"}` — the existing turn boundary — so the run re-parks at `awaiting_input` after compacting.

The end-to-end compact-and-**continue** success on a long, genuinely-full context is a Wave V live-verification item (the smoke proved the trigger fires; it "failed" only because the probe session was empty).

## Multi-tier org observability (BUILT — Phase 5, through loop-b b2)

Today's runtime sub-agent tree observes **one run's** delegate calls (orchestrator → worker agents).
The agent organization (§03) adds tiers **above** a run — K, the Chief, and the leads — so
observability extends from a single run's tree to the **whole org**:

- **One wire, every tier.** Because all three tiers ride the same **EventBus**, K's logistics
  activations, the Chief's assignments and autonomous wakes, and each lead's workflow runs all land
  as the same `AgentEvent` stream — the activity strip and Runs surface them uniformly, tagged by
  the activating profile.
- **The org tree (BUILT — P5.2a).** The per-run delegation tree generalizes into a tier-aware view:
  Chief → each lead → the lead's role subagents, each node carrying status and (for a lead) its
  latest run's prompt. This is a **derivation, not a new subsystem** — a reusable, generic
  `DelegationTree` component (`web/src/components/DelegationTree.tsx`) renders any `DelegationNode`
  root, and a pure builder (`web/src/lib/delegation.ts`) assembles the whole-org root by **reusing
  `eventsToWorkflowTree` unchanged** for each lead's sub-agent level. It is fed by ONE batched read,
  `GET /api/chief/org` (`ChiefOrgPayload`: the Chief profile, each lead's latest run + events +
  wakes, the Chief's own wakes, recent assignments, and a THIN health line), surfaced on the **Chief**
  org-overview page (§08) alongside the Objectives panel (from the mgmt store's assignments) and the
  Chief's autonomous-wake history.
- **The autonomous-wake history is now REAL (BUILT — P5.2b, D-044).** The `chiefWakes` list in that
  payload (rendered by the ChiefPage `WakeRow`) is fed by **actual autonomous wakes**, not a hand-seed:
  `core/src/chief-wake.ts` wires the reused scheduler + EventBus into `startAgentRun('chief', …)`, so
  each wake is an `agent_runs` row (`profile_id='chief'`) that the route already reads. Every row carries
  the four wake facts straight from existing columns — **trigger** (`schedule` | `event`), **time**
  (`created_at`), **run id** (`run_id`, a view-run link), and **outcome** (`status`: running → completed
  | failed). The wake is debounced + already-running- + self-wake-guarded — and since P5.7 **governed**
  (org-relevant terminals only, a rolling-hour cap, a kill switch — D-057, §03; a suppressed wake
  creates **no** ledger row) — and a dispatch failure lands as a `failed` row via the `startAgentRun`
  rollback: the observed history is faithful to what actually fired.
- **The Chief→lead link is now DERIVABLE (BUILT — loop-a, D-049).** With the autonomous dispatch built
  (§03), a Chief→lead edge is derivable from the stored data with **no new table**: an assignment's
  `run_id` is the Chief run (parent), its `lead_run_id` is the dispatched lead run (child), and the
  lead activation's `agent_runs.trigger='delegation'` marks the hop — the exact mirror of K→Chief's
  `k_thread_turns.run_id` + trigger. The lead's outcome is filed back as a mgmt `report` on the Chief's
  run, so it lands in the same store the org page already reads. **loop-b b1 (D-050) makes this edge
  fill for a REAL run:** the dispatch executes in the long-lived main process (a `lead_dispatches`
  queue drained by `lead-dispatch-relay.ts`), so the lead's `agent_runs` row finalizes and the
  report-back fires on the main EventBus (visible to the WS + org tree) instead of dying with the
  mgmt-server child; a boot sweep (`reconcileOrphanedActivations`) finalizes any activation orphaned by
  a mid-dispatch child exit.
- **The WHOLE-ORG tree is now RENDERED, and the up-chain reaches K (BUILT — loop-b b2, D-051).** Two
  gaps closed exit-criterion #3 ("the result reports back up the chain — all visible in the org tree"):
  - **The multi-tier tree DERIVATION render.** `web/src/lib/delegation.ts::fullOrgToDelegationTree`
    wraps the existing Chief subtree (`orgToDelegationTree`, unchanged) under two ancestor tiers —
    **user → K → Chief → lead → sub-agent** — reusing the same generic `DelegationTree` component
    (arbitrary depth) the Chief page already renders. The **K→Chief edge** is a pure derivation from the
    existing links, **no new table**: `ChiefOrgPayload.kDelegations` counts the Chief's
    **successful** `trigger='delegation'` activations — `failed` rows are excluded since P5.7, a
    documented undercount of raw attempts (every counted one is a K hand-up — `delegateToChief` is the
    only path that sets the trigger; autonomous wakes use `schedule`/`event`). K's node rides the chain
    (running while the Chief subtree is active); the user root is the operator anchor. So the full
    chain is VISIBLE end to end on the one batched `GET /api/chief/org` read (whose live-leads count
    is the server-authoritative `leadsActive` — the client no longer re-derives it).
  - **The Chief→K report continuation.** A Chief's bounded activation can end BEFORE the lead it
    dispatched finishes, so the Chief-terminal report-back (`reportDelegationBack`, D-046) could surface
    a PRE-lead status. The continuation closes that: riding the **same lead-terminal signal** the
    lead→Chief mgmt report uses (`lead-dispatch-relay.ts`, main EventBus), `k-thread.ts::continueLeadOutcomeToK`
    resolves whether the parent Chief run was itself a K delegation (a `k_thread_turns` row links it to a
    thread — `getThreadIdByTurnRunId`) and, if so, appends the lead's outcome one more hop UP onto K's
    durable thread ("Chief (via <lead>) completed: …"), linked to the lead run so it stays traceable.
    Idempotent (the run-lifecycle once-latch), and a **no-op when the Chief woke autonomously** (no
    linked thread) — then the outcome stays in the Chief's mgmt store only.
- **Memory provenance.** A gated reflection (§04) that proposes a lesson is itself an observable
  event, so you can trace *why* a profile's memory changed back to the run that earned the lesson.

With loop-b b2 the org observability chain is COMPLETE: an engineering ask flows K→Chief→lead→PR and
its result reports back up to K, and every tier — user, K, Chief, each lead, each sub-agent — is
visible in one derived multi-tier tree over the same enrichment foundation, pairing helpers, and
single-wire EventBus. No new table was added at any hop; the whole chain stays a derivation.

## Capability + local-runtime observability (BUILT — host-integration program)

The capability catalog (§04, §08) and the D-072 local runtime ride the same live wire:

- **The `capabilities_update` WS event** broadcasts when a rescan completes or the enable/trust
  overlay changes; `live-invalidate.ts` invalidates the `['capabilities']` queries so all four
  Skills tabs (and the pickers) re-render live — the same throttled-invalidator wiring
  `run_update` uses.
- **Stat-strip methodology.** The CapabilityStatRow totals are `ceil(chars/4)` estimates (±25%,
  `core/src/token-estimate.ts`), labeled `est`/`~` everywhere with an "estimates, not billed
  tokens" tooltip; entries without an estimate (e.g. an unprobed MCP server) are **counted and
  footnoted**, never silently dropped — the strip can under-state, but never hides.
- **Local runs report real usage.** An ollama tool-loop run emits genuine token counts
  (`prompt_eval_count` / `eval_count`) at `costUsd: 0` on the same per-turn usage events claude
  runs use — so Metrics and Routing aggregate local runs on **real tokens at zero cost** instead
  of fabricated zeros, and the provider grouping needed no change.
- **The truthful run-start runtime event.** Every ollama-agent run opens with a `system` event
  declaring the engine and its tool support, rendered as the RunConsole badge — **"local ·
  tools"** vs **"local · prompt-only"** (§08). A degraded run is *visibly* degraded; it never
  silently becomes a claude run.

## Org Timeline feed — a read-time union projection (P3, E-09, D-085)

The Org Timeline (§08) is **not a persisted feed table** — it is a **read-time UNION PROJECTION**
(`GET /api/feed`, `core/src/routes/feed.ts`) computed on demand over four sources the harness
already writes:

- **run heads** — each run's current state, mapped to a milestone kind by its status
  (`running/queued`→dispatch, `awaiting_plan`→plan_gate, `awaiting_input`→park, `done`→done,
  `error/killed/interrupted`→failure),
- **review-ready notifications** — the `run_review_ready` rows (runs that finished with a diff to review),
- **`verify_results`** — completed `pass`/`fail` verification outcomes, and
- **open-PR `github_cache`** — the PRs currently open.

Each source contributes only these **curated milestone kinds** — not every event, just the ones
worth a timeline row. The projection is read under **one shared query key, `['feed']`**, with a
**`['feed', 500]` timeline variant** for the deeper history view, so K-home's "recent" and the
Timeline page read the *same* projection and cannot drift. Each source is **capped**
(`SOURCE_CAP = 500`); the endpoint clamps the display `limit` to `1..500` (default 100), returns
per-kind `counts` and the pre-slice `total`, and the UI surfaces the overflow honestly as
**"showing N of M events"** rather than hiding it. Because there is no feed table there is no write
path to keep in sync and nothing that can diverge from the sources (the same discipline as the
D-081 read-time Inbox). The live **ActivityStrip is intentionally left pointed at running runs** —
it needs complete, uncapped coverage of non-terminal runs plus richer Run fields, which a capped
historical feed cannot provide.

## Measured cost lens (P3, E-13, D-087)

The cost lens is **measured-only** — it never multiplies a token count by a price. Two things are
derived, both from the stored `cost_usd`:

- **Roll-ups** — measured `cost_usd` summed **run → lead → project → day**.
- **Dispatch recent-actuals** — the **median and p90 `$/run`** over a recency window, computed from
  the pool of runs with **`cost_usd > 0`**, scoped **agent-profile → project → global** with a
  fallback when a scope has fewer than 5 samples (thin history degrades to the broader scope rather
  than reporting a noisy number).

There is **no price-per-token table and no `price × tokens` estimate** anywhere in the cost path —
the program bans price-coupled estimation (measured actuals only). The rule is **mechanically
enforced** by a committed **no-price-tables grep gate** (`core/test/no-price-tables.test.ts`) that
fails if a price table reappears. The catalog's relative **weight bands** (§08) convey *context*
cost without implying a dollar figure.

## Autonomy budget + retry observability (BUILT — P5 Autonomy, E-17/E-18)

The autonomy stack (§03) adds two measured lenses on Insights → Charts (§08), both **derivations over
data already stored — no forecasting, no new spend**:

- **Budget burn-down (measured, 24h).** `core/src/budget-governor.ts::budgetStatus` sums
  `runs.cost_usd` over a **rolling 24h window** against the org cap (autonomy settings) and any
  per-project caps (`projects.budget_daily_usd`), classifying each scope `ok | warn | capped`
  (`classifyBudget` is pure: null cap → always `ok`; `capped` iff spent ≥ cap; `warn` iff spent ≥
  cap·warnPct). It is **REACTIVE — ZERO forecasting**: no price×token math, no projected spend, only
  measured actuals, so the same no-price-tables grep gate that guards the cost lens above still holds.
  At a cap a dispatch is **parked = refused-with-reason** (`BudgetCapError` / `429`), never queued —
  the burn-down surfaces the `capped` state and a `budget_update` WS event nudges the chart; the
  operator raises the cap to proceed (D-112). Gated dispatch paths: `startAgentRun` (autonomous),
  manual `POST /api/runs`, operator→Chief `delegateToChief`, and autonomous scheduled/event skill
  dispatch; **interactive/persistent K turns are exempt** (the operator's own conversation is never
  budget-blocked). Because the cap is a safety limit it applies **even while autonomy is OFF** once
  set (§03, D-108).
- **Retry rate (measured).** `core/src/retry-metrics.ts` counts self-heal retries off the
  `runs.retry_of` lineage (E-18, §07) against total runs over a day-bucketed window — the rate is real
  because a retry is a real row stamped `retry_of`/`retry_count`, and a `run_retried` WS event
  invalidates the series live. A retry is a fallback-model re-dispatch, so the chart reads how often the
  org is self-correcting rather than parking.

### Success-rate definition (one number, everywhere)

**Success rate = `done / (done + error + interrupted)`** — operator-**killed** runs excluded
(F-082) — over the SELECTED window's **whole terminal population**. Any multi-day aggregate is
**terminal-run-weighted**, **never a mean of daily rates**: a 1-run 100% day must not offset a
20-run 30% day. The formula lives in two mirror helpers pinned equal, not a single import:
`overallSuccessRate` (`core/src/metrics.ts`, server side) and **`weightedSuccessRate({terminalRuns,
successRate})`** (`web/src/lib/format-metrics.ts`, client side), which re-weights per-day rates by
each day's terminal-run count. Both **Charts** and **Overview** consume it: Charts reads the weighted
number directly, and the **Overview success-rate delta** compares `weightedSuccessRate` over each half
of the window (BE-3a / INT.2) — it previously took a flat unweighted `mean()` of daily rates, the
"Overview 80% vs Charts 34.7%" contradiction the audit caught (`mean()` survives only for the latency
delta, which is correctly unweighted). Two tests pin it: `core/test/success-rate-definition.test.ts`
(core ≡ web) and `web/test/insights-overview.test.tsx` (a 1-run-100% vs 20-run-30% fixture proves the
tile renders the terminal-weighted delta, not the naive-mean one).

## Implementation history (dashboard)

> Moved here from §08 so that section stays a UI *spec*. These are the as-built milestone records
> for the dashboard surfaces (Phases G / H / 4); the live roadmap is §09.

### Phase G — Command Deck + Knowledge + Verification (✓ complete 2026-06-18)

All items below were delivered in Phase G (G-1 through G-6):

- **Project Workspace 7-tab scaffold (G-1)** — hash-segment routing `#/project/:id/tab` with
  `subParam` in `route.ts`; roving `tabIndex` keyboard nav across all 7 tabs.
- **Overview / Verification / Bible tabs (G-2)** — Overview (health breakdown, latest verification,
  recent runs, open PRs, bible freshness, quick actions); Verification (timeline, findings with
  severity badges, fixes applied, re-run; `GET /api/projects/:id/verifications`); Bible (compiled
  bible in an iframe; per-section edit modal + recompile via `POST /api/bible/compile`).
- **Runs / Tasks / PRs & CI tabs (G-3)** — project-scoped run list + dispatch + embedded RunConsole;
  `project_tasks` table + CRUD via `GET/POST /api/projects/:id/tasks` and `PATCH …/:taskId`; PRs & CI
  with check status, diff links, Actions history, PR-creation modal.
- **Knowledge Graph tab + Fleet Graph (G-4)** — per-project ForceGraph from `GET …/graph` (reads
  `.gitnexus/graph.json`); node inspector; stale-index banner; Fleet Graph on Home + full-screen
  `/graph`; graph API normalizes the GitNexus `graph.json` shape (`edges`/`links`).
- **Agent-opens-PR (G-5)** — `createPR` (`core/src/github.ts`) invokes `gh pr create` via execa with
  an argv array (injection-safe), sanitizes stderr; `POST /api/projects/:id/prs` (Zod-validated, 400
  on no remote, 201 on success); PR modal in PRs & CI; "Create PR from Run →" footer in RunConsole.
- **G-6 close-out** — `tasks-route.test.ts`, `create-pr.test.ts`, bible updates, root `.env.example`.

### Phase H — Knowledge graph engine + experience polish

- **Hybrid glass (extends D-007, D-009)** — glass tokens/utilities (`web/src/index.css`),
  `@supports` opaque fallback, applied to hero surfaces only (command bar, modals, node inspector,
  activity strip); data tables stay flat.
- **Motion (reduced-motion-safe)** — centralized `web/src/lib/motion.ts` variants; top-level
  `MotionConfig reducedMotion="user"`; pulse reserved for genuinely-live elements.
- **Graph engine (D-009/D-010)** — `project_graphs` table + `POST /api/projects/:id/graph/build`
  (runs `npx gitnexus analyze` via an injected `analyze` seam, in-flight guard); live node
  enrichment; `POST …/graph/dispatch` (node-scoped run); debounced auto-reindex on run completion
  (`GRAPH_AUTO_REINDEX`); renderer-subpackage rule (never the `react-force-graph` aggregate).
- **UI as a self-demonstrating artifact (D-010/D-011)** — `core/src/ui-artifact.ts`
  (`compileUiArtifact` writes rich HTML verbatim) + `POST /api/ui-artifact/compile`; served in a
  sandboxed iframe (`allow-scripts`, no `allow-same-origin`); `create-web-ui-artifact` skill authors
  per-project demos.

### Tasks tab — delegation workflow over selected todos (✓ 2026-06-24)

The Tasks tab (`web/src/pages/tabs/TasksTab.tsx`) multi-selects todos and launches one supervised
delegation workflow over the selection (one reviewable commit / PR), backed by `core/src/workflows.ts`
(§04). Per-row + indeterminate select-all checkboxes (selection pruned after every refetch); sticky
**Run delegation workflow** action bar → `api.projects.tasks.dispatchWorkflow`; `in_progress` on
dispatch, never auto-`done` (the PR decides completion); success toast with **View run →**.

### Phase 4 — Agent-UX + Observability (✓ merged 2026-06-27)

The dashboard *surfaces* delivered in Phase 4 (internals above):

- **Interactive multi-turn HITL — the answer box (Track A, D-014)** — a run dispatched interactive
  parks at non-terminal `awaiting_input` at each `{type:"result"}` turn boundary; the answer box
  (autofocused) feeds the next turn (`POST /api/runs/:id/input`, ⇧↵ newline); **End session** closes
  stdin → `done`; **Compact context** sends real `/compact`; a danger-band inline hint.
- **⌘K dispatch card (Track A, D-006)** — per-run model picker from `KNOWN_MODELS` (route-validated),
  multiline composer (⏎ submit · ⇧⏎ newline), interactive toggle.
- **Rich run console (Track D, D4)** — structured collapsed commands / file diffs / delegated
  sub-agents; Console ↔ Timeline; consecutive tool calls coalesce; pre-enrichment runs keep the
  legacy `⚙ tool()` line.
- **Context-pressure indicator (Track D, D6, D-018)** — `ctx X / Y · Z%` band-colored meter (ok <70 /
  warn ≥70 / danger ≥90; `ctx —` when the window is unknown), counting full input context incl. cache,
  persisted.
- **Settings page (Track D, D2, D-017)** — provider/auth status cards (no secrets) + guarded global
  CLAUDE.md editor.
- **Workflows page (Track D, D5, D-016)** — Defined (hand-laid delegation-loop diagram from
  `DELEGATION_WORKFLOW`) + Run (live runtime sub-agent tree from a run's `delegate` calls).
- **Force-graph surfaces → 3D** — all three force-graph surfaces moved to `react-force-graph-3d` with
  a collision force + per-surface error boundary; the renderer-subpackage rule still holds.
