# Phase 4 — Agent-UX + Observability (Monitoring & Visualization)

## Context

Phases 0/1/2 + Phase G + Phase 3 + Phase H are merged to `main`. The originally-planned "Phase 4 — Multi-Device" (Tauri desktop / PWA / remote hardening) was **re-scoped**: the desktop/mobile surfaces are deferred (D-019) and this phase instead finishes interactive HITL and makes the agentic system **observable and editable** — surface/edit the prompts & config that drive agents (skill prompts, the global system prompt, provider/auth status) and visualize what agents actually do at runtime (rich run console, workflow graphs, delegated sub-agents, context pressure).

**Method (delegation loop per wave):** implementer → spec-review → quality-review → controller applies fixes → ONE reviewable commit → CI verifies. A review agent every wave, no exceptions; a separate whole-implementation review before merge. Smoke-gated waves run a live `claude` probe FIRST to decide the design. Tracker in `tasks/todo.md`; lessons in `tasks/lessons.md`.

**Branch:** `feat/phase4-agent-ux-desktop` off `main`. Merged `--no-ff` to `main` on green CI (commit `30228fa`, 2026-06-27).

**Decisions taken this phase:** context = a live indicator now + smoke-gated compaction; workflow viz = a static defined-workflow + a live runtime sub-agent tree; the Tauri desktop app is **deferred**; the CLAUDE.md editor is global-only and guarded.

## Track A — Agent-interaction UX

- **A1 — Per-run model picker.** Shared `KNOWN_MODELS` registry (single source of truth for the picker); the route validates `model` against it.
- **A2 — Multiline prompt composer** + an **interactive toggle** in the ⌘K dispatch card.
- **A3 — Interactive multi-turn HITL (smoke-gated).** *A3.0 live smoke* confirmed the persistent-stdin strategy vs the real CLI: stdin persists across turns; `{type:"result"}` is the awaiting boundary; the operator-turn envelope `{type:"user",message:{role,content}}` is accepted verbatim; `total_cost_usd` is cumulative. Shipped: `awaiting_input` status/event; interactive argv; retained `proc.stdin`; `sendInput`/`endSession`; turn-boundary detection; boot-sweep of stale `awaiting_input`; `POST /api/runs/:id/input` (409 if not awaiting; **atomic conditional-UPDATE** double-send guard) + `/end`; the `RunConsole` answer box. (D-014)

## Track D — Observability: monitoring, visualization & editable config

- **D1 — Editable skill prompts.** `UpdateSkillSchema` accepts optional name/description/source; PATCH read-modify-write with a name-collision 409 and clear→NULL; per-row editor on `SkillsPage`. (D-017)
- **D2 — Settings page.** `GET /api/status` (claude/ollama/github/auth posture via real probes, never any secret); `GET`+`PUT /api/system-prompt` for the repo-root **global** CLAUDE.md only — backup-on-save, atomic temp+rename, gitnexus block preserved via `splitSystemPrompt`/`composeSystemPrompt`, schema-locked body. New Settings page + `g ,` chord. (D-017)
- **D3 — Event-data enrichment foundation (smoke-gated; unblocks D4/D5/D6).** *D3.0 live smoke* mapped the real field shapes (Bash→`input.command`, Write/Edit→`input.file_path`, delegate tool named `Agent`/`Task` with `subagent_type` absent when default, tool_result content string-vs-array, pairing by `tool_use_id` across separate events). Shipped: extended `AgentEvent` + `events` table (`toolUseId/toolKind/toolInput/toolResult/toolResultIsError/subagentType/childLabel`); enriched `parseClaudeLine` (pure `classifyTool` table-map); race-tolerant ALTER migration; defensive JSON projection. (D-015)
- **D4 — Rich run console (web; consumes D3).** Pure `lib/console.ts` (`pairToolCalls`/`groupConsoleItems` + defensive readers); `ToolCall.tsx` collapsed-by-default command/file/delegate rendering with framer-motion reveal honoring reduced-motion. Added RTL + jsdom (`@24`) scoped to `.test.tsx`.
- **D5 — Workflow visualization.** Shared `DELEGATION_WORKFLOW` constant (no new endpoint); `WorkflowsPage` (Defined diagram + live Run tree); `eventsToWorkflowTree` derives the tree from `delegate` tool calls (sub-agents run in-process via the Agent/Task tool). (D-016)
- **D6 — Context indicators + smoke-gated compaction.** *D6.0 live smoke REVERSED the plan*: `/compact` IS honored over the stream-json input wire (the CLI runs its compaction machinery), so on-demand compaction can be forced via `sendInput('/compact')`. Shipped: `contextWindow` per `KNOWN_MODELS` + `modelContextWindow`; a `contextTokens` field = full input (fresh + cache_creation + cache_read), **persisted** as `events.context_tokens`; pure `lib/context.ts` (`contextPressure` band ok/warn≥70/danger≥90; `nextAutoCompact` hysteresis); `ContextMeter` in the run header; a manual **Compact context** button + a guarded/debounced auto-compaction. (D-018)
- **Graph polish.** Node/edge overlap fix (`d3-force-3d` collide), then all three force-graph surfaces moved to **3D** (`react-force-graph-3d`) with a per-surface error boundary; the renderer-subpackage rule (never the `react-force-graph` aggregate → AFRAME blank-screen) re-proven by a static guard test.

## Wave V — whole-effort verification (before merge)

- Gates: `pnpm -r typecheck` · `pnpm -r test` · `pnpm -r build` green.
- Whole-effort pre-merge review (MERGE-READY; 0 CRITICAL/HIGH). In-scope review-fixes landed, including the **`context_tokens` persistence round-trip** (the indicator value rode the WS for live runs but was never persisted, so a reloaded run underreported pressure — fixed by mirroring the D3 enriched-column pattern: DDL + race-tolerant migration + `insertEvent` bind + `dbRowToEvent` projection, with DB-persistence and route-projection tests).
- Consolidated **live Playwright smoke** across the new surfaces (HITL ask→answer→continue, skill edit, settings/status, CLAUDE.md edit, rich console, workflow viz, context indicator). The compact-and-**continue** success on a long non-empty context is the remaining live item.
- Merged `--no-ff` to `main` (commit `30228fa`).

## Deferred to a later phase

- **Tauri desktop app** (bundled-core sidecar, tray, native notifications) — old Track B; full spec retained in `~/.claude/plans/read-through-and-analyze-rippling-hanrahan.md`. (D-019)
- **PWA mobile** (installable + push) and further **remote-access hardening** (reverse proxy / Tailscale).
