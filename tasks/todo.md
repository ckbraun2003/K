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

### Wave D2 — Settings page: auth/status + guarded system-prompt (CLAUDE.md) editor  ✅ DONE
- [x] `GET /api/status` — Claude / Ollama / GitHub / auth posture via pure `buildStatus` + real probes (`claude --version` 2s, `gh auth status` 3s, never-throw via execa no-shell; `isOllamaReachable`); status only, no secrets; `StatusSchema`; 15s probe cache
- [x] `GET`+`PUT /api/system-prompt` — root CLAUDE.md only (fixed path, env override tests-only); backup-on-save (eviction keeps last 50) + atomic temp+rename write; preserve gitnexus block via pure `splitSystemPrompt`/`composeSystemPrompt`; schema-locked (`.strict()`, only `md`); rejects submitted gitnexus markers → 400
- [x] `web` — new Settings page + route/Shell/Sidebar/`g ,` chord; status cards (pure `settings-status` verdict mapping); CLAUDE.md editor with `ConfirmDialog` before-save warning
- [x] Tests: `/api/status` shape + no-secret; system-prompt round-trip + gitnexus-preserve + backup + extra-key/oversize/marker-reject 400; web status + save-confirm
- [x] Review applied: 2 HIGH (reject gitnexus markers in body → 400 + test; atomic temp+rename write w/ cleanup) · 2 MEDIUM (15s probe cache; backup eviction keep-50) · LOW (char-vs-byte schema comment). Security review: 0 CRITICAL (no token leak / traversal / injection / XSS / auth bypass)
- [x] Verify: typecheck clean · core 507 · web 152 · repo-root CLAUDE.md untouched (`git status`)  _(live status + edit→save smoke deferred to Wave V)_

### Wave D3 — Event-data enrichment foundation  (smoke-gated; unblocks D4/D5/D6)
- [x] **D3.0 smoke** (live, user-authorized; `claude -p ... --output-format stream-json --verbose --allowedTools "Bash Write Task"`). Verified field map:
      · Bash → `input.command` (+`description`); `tool_result.content` = **string**
      · Write/Edit → `input.file_path` (+`content`); result string; `is_error` often **absent**
      · **delegate tool is named `Agent` (also accept `Task`)**; `input` = `description`+`prompt`, **`subagent_type` absent when default**; `tool_result.content` = **array of `{type:"text",text}`** (incl. an `agentId:` line)
      · **pairing is by `tool_use_id`** — `tool_use` (assistant) and `tool_result` (user) arrive in SEPARATE events → need a stored `toolUseId` to join
- [x] `shared` + `core/src/db.ts` — extended `AgentEvent`/events table: `toolUseId`, `toolKind` (command|file|delegate|other), `toolInput`/`toolResult` (JSON), `toolResultIsError`, `subagentType`/`childLabel`; kept `raw`. New cols in CREATE TABLE + **race-tolerant** `addColumn()` migration (tolerates `duplicate column` → multi-process/CI safe; project_tasks ALTERs hardened too)
- [x] `core/src/providers.ts` — enriched `parseClaudeLine`: pure `classifyTool()` table-map; captures FIRST tool_use's structured fields (legacy `event.tool` now first-wins, full line kept in `raw`); new `user`/tool_result branch (string|array content, tri-state `is_error`); **zero** token/cost behavior change (result branch byte-identical)
- [x] `core/src/events.ts` + `routes/runs.ts` `dbRowToEvent` — persist (JSON-stringify w/ `!== undefined` guard) + project the new columns via defensive `safeJsonColumn()` (one corrupt row can't 500 the list)
- [x] Tests: `providers-enrich.test.ts` (+17) — Bash/Write/Agent(no subagent_type)/Task(with) fixtures, tool_result string-vs-array, is_error tri-state, classifyTool, backward-compat + token/cost unchanged, DB round-trip
- [x] Review applied: HIGH (race-tolerant ALTER) · MEDIUM (guarded JSON.parse) · LOW (first-wins doc). LOW size-cap on toolResult deferred (raw already duplicates; revisit if rows bloat)
- [x] Verify: typecheck clean · core 524 · web 152 · CLAUDE.md untouched  _(live enriched-run column-populate smoke deferred to Wave V)_

### Graph fix — prevent node/edge overlap in force-graph surfaces  (small, web-only)  ✅ DONE
- [x] `web` added `d3-force-3d@^3.0.6` (the exact engine react-force-graph-2d uses — lockfile-confirmed same 3.0.6, no version split); pure `collideRadius()` + `configureGraphForces(fg)` in `lib/graph.ts` registering `forceCollide(size+pad)` + tuned `GRAPH_LINK_DISTANCE`/`GRAPH_CHARGE_STRENGTH` so nodes never overlap & edges rarely cross nodes; null-ref no-op
- [x] applied via ref `useEffect` on all three surfaces: `KnowledgeGraphTab` (had ref), `FleetGraphPage` + `HomeFleetGraph` (refs added); comment notes edge–edge crossings can't be fully eliminated (non-planar)
- [x] Tests: `graph-forces.test.ts` (+8) collide-radius invariant + force-wiring spies + no-op safety; `bundle-guard` still green (force-graph-2d only)
- [x] Review: APPROVED — 0 CRITICAL/HIGH; API names verified vs the lib `.d.ts`; only optional LOW nits (left per minimize-impact). Verify: typecheck clean · web 160

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
