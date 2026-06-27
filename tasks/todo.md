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

### Graph 3D — move all force-graph surfaces into 3D space (edges stop intersecting)  (user-requested: ALL surfaces)  ✅ DONE
- [x] swapped `react-force-graph-2d` → `react-force-graph-3d` (Three.js; deps `3d-force-graph`/`react-kapsule`/`three@0.185` — **no AFRAME** pulled, blank-screen lesson not retriggered) on all three: `KnowledgeGraphTab`, `FleetGraphPage`, `HomeFleetGraph`
- [x] 3D render: declarative `nodeColor`/`nodeVal`/`nodeOpacity`/`nodeResolution`/`nodeLabel`(hover) replace canvas paint; `configureGraphForces` kept (d3-force-3d/forceCollide 3D-native); node-click → 3D `cameraPosition(...)` fly-to (origin-NaN guarded); `zoomToFit` for 'f'; orbit nav controls on
- [x] `GraphErrorBoundary` wraps every WebGL surface — a context-creation throw degrades to a fallback instead of blanking the route (neutralizes the old failure SHAPE with a new trigger)
- [x] `bundle-guard` — widened to forbid aggregate + `-vr`/`-ar` across `from`/side-effect/dynamic imports; allows `-2d`/`-3d`; comment updated
- [x] live render verify: `pnpm --filter web build` ✓ AND word-boundary `\bAFRAME\b` grep of `web/dist` → **absent**; no `aframe` package in store  _(full in-browser rotate smoke folded into Wave V)_
- [x] Review: 0 CRITICAL/HIGH (API verified vs lib `.d.ts`; AFRAME re-proven). Applied: MEDIUM error boundary · LOW origin-camera · LOW guard regex. Deferred LOW: three-spritetext in-scene labels, manualChunks lazy-load of graph pages, drop unused `react-force-graph-2d` dep. Verify: typecheck clean · web 160 · build ✓

### Wave D4 — Rich run console: commands, files, delegated agents  (web only, consumes D3)  ✅ DONE
**Decision (this session):** test approach = **add RTL + jsdom** (user-chosen) — true component render/collapse-expand/reduced-motion tests, scoped to `.test.tsx` (existing `.test.ts` stay node-env). Pairing/grouping kept as pure helpers (also unit-tested). Delegate display = inline expandable card (the graph/tree is D5). No backend changes.
- [x] `lib/console.ts` (NEW, pure) — `pairToolCalls` joins tool_use↔tool_result by `toolUseId` (dedupes duplicate ids, drops orphan/consumed result rows), `groupConsoleItems` coalesces consecutive tools, + defensive derivation helpers (command/file write-preview & edit/multiedit-diff/delegate label+prompt+result); `??` data layer, never throws
- [x] `ToolCall.tsx` (NEW) — collapsed-by-default `ExpandableRow` + `CommandCall`/`FileCall`/`DelegateCall`/`OtherCall`; framer-motion reveal (honors global `MotionConfig` reduced-motion); error styling only when `toolResultIsError===true`; `||` placeholders kept (empty-string→placeholder)
- [x] `RunConsole.tsx` — console branch renders `useMemo(groupConsoleItems(pairToolCalls(events)))` in left-rail groups; `EventLine` preserves legacy/non-tool rendering verbatim (pre-D3 `⚙ tool()` fallback); live WS append now `mergeEvents(prev,[e])` (seq-sorted/deduped → stable grouping). HITL box, toggle, RunTimeline, footer, Kill, `EVENT_COLOR` export untouched
- [x] Added `@testing-library/react`+`user-event`+`jsdom@24` (web only); `environmentMatchGlobs` jsdom for `*.test.tsx`; include `test/**/*.test.{ts,tsx}`; `plugins:[react()]`
- [x] Tests: `console-items.test.ts` (23 pure) + `tool-call.test.tsx` (10 RTL: command/write/edit/multiedit/delegate render, collapse→expand, pending badge, error tri-state, reduced-motion)
- [x] Review: spec + quality both APPROVE-WITH-NITS (0 CRITICAL/0 happy-path bugs/0 XSS). Applied: HIGH seq-sorted live append · MEDIUM memoize / exported+tested grouping / drop orphan results · LOW dedupe toolUseId / MultiEdit+pending tests. Kept `||` placeholders; CLAUDE.md (user edits) out of commit
- [x] Verify: typecheck clean · web **196** (+33 D4) · build ✓  _(live delegation-run in-browser smoke folded into Wave V)_

### Wave D5 — Workflow visualization (static defined-workflow + live runtime tree)  ✅ DONE
**Decisions (this session):** (1) definition = **shared constant** `DELEGATION_WORKFLOW` in `@k/shared` (no new endpoint — client+server agree via one import; data is static). (2) rendering = **purpose-built SVG/CSS tree/diagram** (user-chosen) — NOT a force-graph; data is a small shallow hierarchy, so no WebGL/AFRAME/tick risk, bundle-guard trivially green. (3) live tree reuses D4 `lib/console.ts` helpers (a delegate child = a paired delegate tool-call). No core logic changes.
- [x] `shared/src/types.ts` — `DELEGATION_WORKFLOW` const + `WorkflowRole`/`WorkflowEdge`/`WorkflowDefinition` types: 4 roles (controller/implementer/spec-review/quality-review) with honest responsibility descriptions (no canned-prompt claims) + 5 edges forming the loop
- [x] `web/src/lib/workflow.ts` (pure) — `eventsToWorkflowTree(events, run?)` via `pairToolCalls` → keep delegate tool-calls → child per delegate (status running/done/error via `isPending`/`isError`, prompt/result via D4 readers); root from run; never throws
- [x] `web` — `WorkflowsPage` (Defined/Run tabs + run picker + `#/workflows/:runId` deep-link; backfill `api.runs.events` + WS live append via `mergeEvents`, `useMemo` tree); `WorkflowDiagram` (hand-laid CSS hierarchy, click role → description) + `RunTree` (indented tree, click node → prompt/result; `key={selectedRunId}` resets selection on switch). Registered: `route.ts`, `Sidebar` (`⋔`), `chords.ts` (`g w`), `Shell`
- [x] Tests: `workflow.test.ts` (8) · `workflow-def.test.ts` (6, incl. exact edge-topology drift guard) · `workflows-page.test.tsx` (5) · `chords.test.ts` (+1)
- [x] Review: spec + quality both APPROVE-WITH-NITS (0 CRITICAL/HIGH, WS effect mirrors RunConsole, 0 XSS, defensive builder). Applied: MEDIUM `key` selection-reset · LOW deep-link tab sync / tab a11y / edge-drift guard. Kept `||` placeholders + honest descriptions; CLAUDE.md out of commit
- [x] Verify: typecheck shared+web clean · web **216** (+20 D5) · build ✓  _(live delegation-run in-browser smoke folded into Wave V)_

### Wave D6 — Context indicators + smoke-gated compaction  ✅ DONE
- [x] Indicator: `contextWindow: 200_000` per `KNOWN_MODELS` entry (+ `modelContextWindow(id)` helper); new OPTIONAL `AgentEvent.contextTokens` (full input context = fresh `input_tokens` + `cache_creation` + `cache_read`, distinct from `tokensIn` so cost/metrics accounting is unchanged); `parseClaudeLine` populates it on both the assistant and result branches. Pure tested `web/src/lib/context.ts` (`latestContextTokens` by MAX seq, defensive/never-throws; `contextPressure` → percent + ok/warn/danger band at 70/90; unknown/local model → band `unknown`). `ContextMeter.tsx` compact header meter (`ctx 142k / 200k · 71%` + band-colored bar; `role="img"` aria-label; `ctx —` + title when window unknown), mounted in the RunConsole header meta row.
- [x] **D6.0 smoke** (live, this env; claude **v2.1.195**; interactive stream-json mirroring `buildClaudeArgs` + `userTurnEnvelope`). **Method:** spawned `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`, wrote ONE operator turn `{type:"user",message:{role:"user",content:"/compact"}}` after SessionStart hooks settled, read a hard-bounded ~20s window, classified each output line. **Result (verbatim):** the CLI emitted `{"type":"system","subtype":"status","status":"compacting"}` → `{"type":"system","subtype":"status","status":null,"compact_result":"failed","compact_error":"Not enough messages to compact."}` → an `assistant` + `result/success` both = "Not enough messages to compact." Those `status:"compacting"`/`compact_result` lines are produced by the CLI's compaction machinery, not the model. **Conclusion — CONTRARY to the planned premise:** `/compact` **IS honored** over the stream-json input wire; compaction actually ran and failed ONLY because the fresh probe session had no messages to compact. So on-demand compaction CAN be forced through the supervisor stdin protocol. (A first 10s probe was inconclusive: this env's heavy SessionStart/superpowers hook injection consumed the window and yielded a false-positive "compact" text match on an injected *previous-session* summary; the 2nd longer probe produced the clean live signal above.)
- [x] **Design decision this wave (took the plan's "yes" branch — `/compact` is forceable):** shipped REAL CLI compaction, not a soft summary. (1) Manual **"Compact context"** button (`run-compact-btn`, disabled while sending, reuses the shared `submitTurn`/`api.runs.sendInput` path) sends `/compact` as an operator turn. (2) Guarded + debounced **auto-compaction**: pure `nextAutoCompact(prev,inputs)` in `lib/context.ts` (hysteresis — fire at most once per danger episode, re-arm only when band returns to `'ok'`; never fire if not interactive, not `awaiting_input`, a send is in flight, or the operator is mid-answer); RunConsole holds an `autoCompactRef` and an effect keyed on `[pressure.band, run.status, sending, answer]` that calls the SAME `submitTurn('/compact')`. (3) `danger`-band inline hint updated to "Context near limit — compacting automatically." Web `Run` carries no `interactive` flag, so interactivity is proxied by `awaiting_input` (only interactive runs reach it — noted in code). **Structural safety confirmed against source:** a `/compact` turn ends with `{type:"result"}`, which `isTurnEndLine` (supervisor.ts:298) already treats as the turn boundary → the run re-parks at `awaiting_input` after compacting; intermediate `system/status:"compacting"` lines trip nothing. The soft "Summarize & continue" path + its false "can't be forced" copy were removed. **Unverified (folds into Wave V):** the end-to-end compact-and-CONTINUE SUCCESS path on a real NON-empty run (the smoke only proved the trigger fires; it failed on an empty session by design).
- [x] Tests: `web/test/context.test.ts` (node) thresholds/percent/band boundaries (69 ok / 70 warn / 89 warn / 90 danger) + max-seq pick + contextTokens-over-tokensIn + malformed-never-throws, **plus `nextAutoCompact` (+10):** fires once on first danger+awaiting, no re-fire while still danger, re-arms at `'ok'` then fires again, never fires when not awaiting / not interactive / sending / operator-typing / band warn|ok|unknown, holds-armed-on-blocked-danger; `web/test/context-meter.test.tsx` (+8, jsdom) percent text, ok/warn/danger fill class, unknown `—`/aria-label, rounded percent; `core/test/providers-enrich.test.ts` (+4) contextTokens = full sum on assistant & result, `tokensIn` stays fresh input, omitted when no usage. (RunConsole itself stays unscaffolded for component tests as today — the manual button + the auto-compact effect wiring + live-climb smoke fold into Wave V; the debounce LOGIC is fully unit-tested via the pure `nextAutoCompact`.)
- [x] Verify: `pnpm --filter shared typecheck` clean · `core typecheck` clean · **core test 528** (+4) · `web typecheck` clean · **web test 251** (+35) · **web build** ✓ · repo-root `CLAUDE.md` untouched. _(Live long-run "indicator climbs" + real compact-and-continue SUCCESS fold into Wave V.)_ Review → commit owned by the controller.
- [x] **Review fix pass (APPROVE-WITH-NITS, 0 CRITICAL/HIGH):** MEDIUM-1 danger-hint copy now varies on a display-only `autoCompactFired` mirror (armed → "compacting automatically"; after a fired-but-still-danger episode → "automatic compaction attempted — press Compact to retry"); the `autoCompactRef` re-entrancy guard kept as-is. MEDIUM-2 `submitTurn` wrapped in `useCallback([runId, sending])`; auto-compact effect now lists full real deps (`run`, `pressure.band`, `sending`, `answer`, `submitTurn`, `autoCompactFired`) and the broad `eslint-disable` was deleted (no render loop — `sending` guard + armed ref still prevent re-fire; web has no lint script, `tsc` clean). LOW-1 `latestContextTokens` uses strictly-`>` so highest seq wins / first-wins-on-tie (+1 tie test). LOW-2 the `⚠` glyph is `aria-hidden`. Acknowledged-no-change: LOW-3 old-CLI fresh-input fallback, the `interactive≈awaiting_input` proxy, and reopen-while-danger immediate compact.
- [x] **Whole-effort pre-merge review fix (LOW — `contextTokens` persistence round-trip):** the indicator rode `contextTokens` over the WS (live runs correct) but it was never persisted, so a RELOADED Claude run fell back to `tokensIn` (cache-excluding) and UNDERREPORTED pressure. Fixed by mirroring the D3 enriched-column pattern: `context_tokens INTEGER` in the `events` DDL + a race-tolerant `addColumn('events','context_tokens','INTEGER')` migration (under the `hasTable` guard); `insertEvent` binds `@contextTokens` and `events.ts` writes `e.contextTokens ?? null`; `dbRowToEvent` projects `context_tokens → contextTokens` (plain number, no `safeJsonColumn`). Tests: providers-enrich round-trip asserts the persisted `context_tokens` column (+1); a new app-routes test seeds an event and asserts `GET /events` projects `contextTokens` end-to-end through the route (+1); the two direct `insertEvent.run` fixtures in `event-raw.test.ts` gained `contextTokens: null`. Verify: `core typecheck` clean · **core test 530** (+2). (Coordinator commits this as the Wave V review-fix.)

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
