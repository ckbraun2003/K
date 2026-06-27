---
title: Observability
icon: "👁"
status: active
updated: 2026-06-27
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

The harness delegation loop is **prose methodology**, not a code object, so its canonical shape lives as a single shared constant — `DELEGATION_WORKFLOW` in `@k/shared` — that both client and server import (no new endpoint for static data). The Workflows page (§08) renders two complementary views:

- **Defined loop** — a hand-laid CSS/SVG diagram of the four roles (controller → implementer → spec-review / quality-review → controller) with their responsibilities. A purpose-built diagram (not a force-graph) is the right tool for a tiny fixed hierarchy and carries no WebGL/AFRAME crash risk.
- **Live runtime sub-agent tree** — derived for a chosen run from that run's `delegate` tool calls. **Delegated agents run IN-PROCESS via the Agent/Task tool**, so a run's sub-agents *are* its `delegate` tool calls: `eventsToWorkflowTree` (`web/src/lib/workflow.ts`) reuses the D3/D4 pairing helpers to build root-plus-children, each child carrying status (running/done/error), the delegated prompt, and the result. There is no separate "sub-run" table to consult.

## Context observability + compaction (D6, D-018)

**The indicator.** Each run's header shows context pressure as `ctx X / Y · Z%` with a band-colored bar — **ok** < 70%, **warn ≥ 70%**, **danger ≥ 90%** — and a muted `ctx —` when the model's window is unknown (local/unrecognized model). The window comes from `modelContextWindow(id)` over the `KNOWN_MODELS` registry (200k for the Claude models). Pure logic lives in `web/src/lib/context.ts` (`latestContextTokens` picks the highest-`seq` context signal; `contextPressure` clamps the percent and buckets the band) and is fully unit-tested.

**Counting the right number.** The CLI's per-assistant-turn `usage.input_tokens` is **fresh input only** — it excludes cache. True context occupancy is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. The parser computes that sum into a separate `contextTokens` field (D6 left the per-turn `tokensIn` projections untouched, so cost/metrics accounting stays unchanged), and it is **persisted** as the `events.context_tokens` column so a reloaded run reflects the pressure it actually reached rather than falling back to the cache-excluding figure.

**Compaction — the `/compact` story (honest reversal).** D6 was planned around the assumption that REPL slash-commands can't be forced over the stream-json input wire, so it would degrade to a soft "summarize & continue". The **D6.0 live smoke overturned that**: sending one `{type:"user",message:{role:"user",content:"/compact"}}` turn made the CLI run its real compaction machinery (`{type:"system",subtype:"status",status:"compacting"}` → `compact_result`). So **on-demand compaction CAN be forced via `sendInput('/compact')`**, and Phase 4 shipped real compaction:

- A manual **Compact context** button in the HITL box that sends `/compact`.
- A **guarded, debounced auto-compaction** (`nextAutoCompact`, pure hysteresis): it fires `/compact` at most once per danger episode and re-arms only after context recovers to `ok`; it never fires unless the run is interactive and parked at `awaiting_input`, and never while a send is in flight or the operator is mid-answer. A `/compact` turn ends with `{type:"result"}` — the existing turn boundary — so the run re-parks at `awaiting_input` after compacting.

The end-to-end compact-and-**continue** success on a long, genuinely-full context is a Wave V live-verification item (the smoke proved the trigger fires; it "failed" only because the probe session was empty).

## Multi-tier org observability (PLANNED — Phase 5)

Today's runtime sub-agent tree observes **one run's** delegate calls (controller → role subagents).
The agent organization (§03) adds tiers **above** a run — K, the Chief, and the leads — so
observability extends from a single run's tree to the **whole org**:

- **One wire, every tier.** Because all three tiers ride the same **EventBus**, K's logistics
  activations, the Chief's assignments and autonomous wakes, and each lead's workflow runs all land
  as the same `AgentEvent` stream — the activity strip and Runs surface them uniformly, tagged by
  the activating profile.
- **The org tree.** The per-run delegation tree generalizes into a tier-aware view: a user request
  → K → Chief → lead → role subagents, each node carrying status, trigger kind (user / schedule /
  event / delegation), and the hand-off prompt + result — reusing the same pairing helpers, just
  rooted higher.
- **Memory provenance.** A gated reflection (§04) that proposes a lesson is itself an observable
  event, so you can trace *why* a profile's memory changed back to the run that earned the lesson.

This is the deferred growth point for observability; the enrichment foundation, pairing helpers, and
single-wire EventBus already make it a derivation, not a new subsystem.

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
