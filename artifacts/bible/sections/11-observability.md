---
title: Observability
icon: "👁"
status: active
updated: 2026-06-27
---

Phase 4's Track D makes the harness **observable**: you can see exactly what an agent did at runtime — every command, file edit, and delegated sub-agent — visualize the delegation loop both as designed and as it actually ran, and watch context pressure against the model's window. It all rests on one foundation: enriching each agent event with structured tool data at parse time, then deriving every view from that data on the client. This section tells that story end-to-end; §06 covers the dashboard *surfaces* it powers.

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

The harness delegation loop is **prose methodology**, not a code object, so its canonical shape lives as a single shared constant — `DELEGATION_WORKFLOW` in `@k/shared` — that both client and server import (no new endpoint for static data). The Workflows page (§06) renders two complementary views:

- **Defined loop** — a hand-laid CSS/SVG diagram of the four roles (controller → implementer → spec-review / quality-review → controller) with their responsibilities. A purpose-built diagram (not a force-graph) is the right tool for a tiny fixed hierarchy and carries no WebGL/AFRAME crash risk.
- **Live runtime sub-agent tree** — derived for a chosen run from that run's `delegate` tool calls. **Delegated agents run IN-PROCESS via the Agent/Task tool**, so a run's sub-agents *are* its `delegate` tool calls: `eventsToWorkflowTree` (`web/src/lib/workflow.ts`) reuses the D3/D4 pairing helpers to build root-plus-children, each child carrying status (running/done/error), the delegated prompt, and the result. There is no separate "sub-run" table to consult.

## Context observability + compaction (D6, D-018)

**The indicator.** Each run's header shows context pressure as `ctx X / Y · Z%` with a band-colored bar — **ok** < 70%, **warn ≥ 70%**, **danger ≥ 90%** — and a muted `ctx —` when the model's window is unknown (local/unrecognized model). The window comes from `modelContextWindow(id)` over the `KNOWN_MODELS` registry (200k for the Claude models). Pure logic lives in `web/src/lib/context.ts` (`latestContextTokens` picks the highest-`seq` context signal; `contextPressure` clamps the percent and buckets the band) and is fully unit-tested.

**Counting the right number.** The CLI's per-assistant-turn `usage.input_tokens` is **fresh input only** — it excludes cache. True context occupancy is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. The parser computes that sum into a separate `contextTokens` field (D6 left the per-turn `tokensIn` projections untouched, so cost/metrics accounting stays unchanged), and it is **persisted** as the `events.context_tokens` column so a reloaded run reflects the pressure it actually reached rather than falling back to the cache-excluding figure.

**Compaction — the `/compact` story (honest reversal).** D6 was planned around the assumption that REPL slash-commands can't be forced over the stream-json input wire, so it would degrade to a soft "summarize & continue". The **D6.0 live smoke overturned that**: sending one `{type:"user",message:{role:"user",content:"/compact"}}` turn made the CLI run its real compaction machinery (`{type:"system",subtype:"status",status:"compacting"}` → `compact_result`). So **on-demand compaction CAN be forced via `sendInput('/compact')`**, and Phase 4 shipped real compaction:

- A manual **Compact context** button in the HITL box that sends `/compact`.
- A **guarded, debounced auto-compaction** (`nextAutoCompact`, pure hysteresis): it fires `/compact` at most once per danger episode and re-arms only after context recovers to `ok`; it never fires unless the run is interactive and parked at `awaiting_input`, and never while a send is in flight or the operator is mid-answer. A `/compact` turn ends with `{type:"result"}` — the existing turn boundary — so the run re-parks at `awaiting_input` after compacting.

The end-to-end compact-and-**continue** success on a long, genuinely-full context is a Wave V live-verification item (the smoke proved the trigger fires; it "failed" only because the probe session was empty).
