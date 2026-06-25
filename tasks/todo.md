# Phase 4 — Agent-UX + Observability (Monitoring & Visualization)

Branch: `feat/phase4-agent-ux-desktop` (off `main` after redesign merge `f95e618`).
Plan: `~/.claude/plans/idempotent-swinging-karp.md`.
One reviewable commit per wave via the delegation loop (implementer → spec-review →
quality-review → controller verifies/commits); a code-review agent every wave, no exceptions.
The controller delegates and verifies — does **not** write feature code.

**Goal:** finish interactive HITL, then make the agentic system **observable and editable** —
surface/edit the prompts & config that drive agents (skill prompts, global system prompt,
provider/auth status) and visualize what agents actually do at runtime (rich run console,
workflow graphs, delegated sub-agents, context pressure).

**Decisions (this session):** context = indicator now + compaction smoke-gated · workflow viz =
static defined-workflow + live runtime sub-agent tree · Tauri desktop app **deferred** to a later
phase · CLAUDE.md editor = global-only, guarded (backup + gitnexus-block preserved + confirm).

## Landed
- [x] Wave 0 — redesign merged (`f95e618`), branch + todo set up
- [x] Wave A1 — per-run model picker (`b806876`)
- [x] Wave A2 — multiline prompt composer (`05dc9af`)

## TRACK A — Agent-interaction UX

### Wave A3 — Interactive multi-turn HITL  (smoke-gated)  ✅ DONE
- [x] **A3.0 live CLI smoke** — gate HOLDS vs claude v2.1.186: stdin persists across turns; `{type:"result"}` is the awaiting boundary; envelope `{type:"user",message:{role,content}}` accepted verbatim; `total_cost_usd` cumulative (last-wins `accumulate` correct). Strategy 1 (persistent stdin) confirmed
- [x] `shared/src/types.ts` — `awaiting_input` event type + run status; `SendInputBodySchema`
- [x] `core` — `interactive` argv; retain `proc.stdin`; `sendInput`/`endSession`; status transitions;
      `awaiting_input` in `reconcileStaleRuns` boot-sweep; turn-boundary detection
- [x] `core/src/routes/runs.ts` — `POST /api/runs/:id/input` (409 if not awaiting; **atomic** conditional-UPDATE transition) + `/end`
- [x] `web` — `runs.sendInput`/`end`; RunConsole answer box (+autofocus); non-terminal status; CommandBar interactive toggle
- [x] Tests: proc-exits-while-awaiting, double-send 409, killed-while-awaiting EPIPE, idle-timeout, route 404/400, project-delete-guard, metrics active-set
- [x] Review applied: 3 HIGH (project-delete guard +awaiting_input, tracked endSession SIGTERM timer, atomic double-send UPDATE) + MEDIUM (activeRuns metric) + autofocus
- [x] Verify: typecheck clean · core 487 · web 140  _(live ask→answer→continue smoke deferred to Wave V)_

## TRACK D — Observability: monitoring, visualization & editable config

### Wave D1 — Editable skill prompts  (small, independent)  ✅ DONE
- [x] `shared` — extracted shared `skillName/skillDescription/skillSource` bounds; `UpdateSkillSchema` accepts optional `source`/`name`/`description` (`.strict()`); unset-vs-empty via `!== undefined`
- [x] `core` — `db.updateSkillContent` stmt; PATCH applies content fields (read-modify-write), 409 on name collision (self-rename ok), cleared description → NULL → undefined
- [x] `web` — `api.skills.update`; per-row `SkillEditor` (`AutoTextarea`) on SkillsPage; partial PATCH (trimmed-diff), invalidate `['skills']`, surfaces 400/409
- [x] Tests: core +7 (update/partial-preserve/400/409/clear); web +3 (api shape/errors)
- [x] Review applied: HIGH stale-editor remount key · MEDIUM trim-diff rename / clear→null / label a11y · LOW Esc-cancel
- [x] Verify: typecheck clean · core 494 · web 143  _(live edit→re-trigger smoke deferred to Wave V)_

### Wave D2 — Settings page: auth/status + guarded system-prompt (CLAUDE.md) editor
- [ ] `GET /api/status` — Claude / Ollama / GitHub / auth posture (status only, no secrets); `StatusSchema`
- [ ] `GET`+`PUT /api/system-prompt` — root CLAUDE.md only (fixed path); backup-on-save; preserve gitnexus block; schema-locked (`additionalProperties:false`, only `md`)
- [ ] `web` — new Settings page + route/Shell/Sidebar/`g ,` chord; status cards; CLAUDE.md editor with confirm-before-save warning
- [ ] Tests: `/api/status` shape; system-prompt round-trip + gitnexus-preserve + traversal-reject; web status + save-confirm
- [ ] Verify: live status accurate; CLAUDE.md edit+save → backup written + gitnexus block intact (`git diff`). Review → commit

### Wave D3 — Event-data enrichment foundation  (smoke-gated; unblocks D4/D5/D6)
- [ ] **D3.0 smoke FIRST** — capture real stream-json for Bash + Write/Edit + Task; fix the tool field map (`command`, `file_path`, `subagent_type`/`prompt`, tool_result pairing)
- [ ] `shared` + `core/src/db.ts` — `AgentEvent`/events table: `toolInput`/`toolResult`, `toolKind` (command|file|delegate|other), `subagentType`/`childLabel`; keep `raw`
- [ ] `core/src/providers.ts` — enrich `parseClaudeLine` (currently discards `block.input`); pure table-driven map; no token/cost behavior change
- [ ] Tests: parse fixtures for each tool shape; backward-compat for old events
- [ ] Verify: live run with command + file-write + delegation populates new columns. Review → commit

### Wave D4 — Rich run console: commands, files, delegated agents  (web only, consumes D3)
- [ ] `RunConsole.tsx` (+ small components) — expandable tool calls: commands (`$ cmd` + output), file ops (path + diff/preview), delegated agents (parent→child card/tree with subagentType + prompt); group + collapse by default; keep raw/timeline toggle
- [ ] Tests: render command/file/delegate events from fixtures; collapse/expand; reduced-motion
- [ ] Verify: live delegation run shows sub-agents + prompts + commands + files. Review → commit

### Wave D5 — Workflow visualization (static defined-workflow + live runtime tree)
- [ ] Static: expose delegation workflow definition (`GET /api/workflows/definition` or shared const) from `workflows.ts` roles; diagram with viewable role prompts
- [ ] Live: pure builder (D3 delegate events → parent→child tree); render via `react-force-graph-2d` + `graph.ts` helpers; click node → prompt + sub-agent events
- [ ] `web` — new Workflows view (route/Shell/Sidebar/chord); reuse `makeGraphUpdateHandler`
- [ ] Tests: events→tree builder; definition shape; bundle-guard (force-graph-2d only)
- [ ] Verify: live run → runtime tree matches console; static diagram renders prompts. Review → commit

### Wave D6 — Context indicators + smoke-gated compaction
- [ ] Indicator: `contextWindow` per `KNOWN_MODELS` entry; per-run context-pressure indicator (latest-turn input tokens vs limit + warning band); pure tested `lib/context`
- [ ] **D6.0 smoke** — can an interactive session compact mid-run? If yes → auto-compact at threshold on `awaiting_input` + manual button; if no → manual "summarize & continue" + documented honest limit
- [ ] Tests: `lib/context` thresholds/percent; indicator bands; compaction trigger gated+debounced (if feasible)
- [ ] Verify: live long interactive run → indicator climbs; compaction per smoke. Review → commit

## TRACK C — Documentation

### Wave C1 — Bible, decision log, plan doc, lessons
- [ ] `06-dashboard-ux.md` (HITL box, model picker, composer, rich console, context indicator, Settings); new `11-observability.md` + manifest; tick Phase-4 + note desktop deferral in `07-roadmap.md`
- [ ] `08-decision-log.md` — D-014 HITL · D-015 event-enrichment · D-016 workflow viz · D-017 editable prompts/config · D-018 context+compaction · D-019 desktop deferred
- [ ] dated plan/spec under `docs/superpowers/plans/`; recompile bible + assert D-014…D-019
- [ ] capture lessons (stdin smoke, tool-input-discarded, event-derived delegation, gitnexus-block preserve, context-cannot-be-forced)
- [ ] Review → commit

## Wave V — Whole-effort verification (before merge)
- [ ] `pnpm -r typecheck` · `pnpm -r test` · `pnpm -r build` green
- [ ] Consolidated live smokes (HITL · skill edit · settings/status · CLAUDE.md edit · rich console · workflow viz · context)
- [ ] Whole-effort review; fix HIGH/CRITICAL; merge → main no-ff

## Deferred to a later phase
- Tauri desktop app (bundled-core sidecar, tray, native notifications) — old Track B; full spec retained in `~/.claude/plans/read-through-and-analyze-rippling-hanrahan.md`.

## Review notes
_(filled in as waves land)_
