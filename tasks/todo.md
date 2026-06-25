# Phase 4 — Agent-Interaction UX + Desktop App

Branch: `feat/phase4-agent-ux-desktop` (off `main` after the redesign merge `f95e618`).
Plan: `~/.claude/plans/read-through-and-analyze-rippling-hanrahan.md`.
One reviewable commit per wave via the delegation loop (implementer → spec-review →
quality-review → controller verifies/commits); a code-review agent every wave.

**Goal:** make agent interaction first-class — a working per-run **model picker**, a better
**multiline prompt** surface, and **interactive HITL** (answer the agent's questions mid-run) —
then ship the **Phase 4 Tauri desktop app** (bundled-core sidecar, tray, native notifications),
and document it all in the bible.

**Verified CLI facts (claude v2.1.186):** `--input-format stream-json` needs `--print`;
`--permission-prompt-tool` is GONE → HITL is conversational-only (no edit-approval gating);
exact stdin envelope is unconfirmed → **smoke before coding A3**.

## Wave 0 — Land redesign, branch new work  ✅ DONE
- [x] Committed redesign finishing touches (`5ccef12`); merged to `main` no-ff (`f95e618`)
- [x] Branched `feat/phase4-agent-ux-desktop`; rewrote this todo
- [x] Verify: typecheck clean on new branch (tests below)

## TRACK A — Agent-interaction UX

### Wave A1 — Make model selection real + per-run picker  ✅ DONE (`b806876`)
- [x] `core/src/claude-args.ts` — `buildClaudeArgs` appends `--model <model>` (was inert)
- [x] `shared` — `KNOWN_MODELS` registry (opus-4-8 / sonnet-4-6 / haiku-4.5 / fable-5) + `isKnownModel`; `preferLocal`
- [x] `core/src/routes/runs.ts` — validate `model` → 400 unknown; thread `preferLocal`; explicit model overrides local hint
- [x] `web` — model `<select>` (Auto/4 Claude/Ollama) via pure `lib/run-models`; removed dead `RUN_DEFAULTS.model`
- [x] Tests: claude-args +3, runs-model +3, web run-models +7. Review applied (comment/guard/dead-const/aria/preferLocal test)
- [x] Verify: typecheck clean · core 466 · web 140 · build ✓  _(live run.model smoke deferred to Wave V)_

### Wave A2 — Better prompt surface (multiline composer)
- [ ] ⌘K dispatch path → auto-growing `<textarea>` (Enter send / Shift+Enter newline), glass tokens
- [ ] Keep nav/jump single-line + `parseProjectQuery` `@project` handling
- [ ] Verify: build + chord tests + live multiline round-trip
- [ ] Review → fix → commit

### Wave A3 — Interactive multi-turn HITL  (smoke-gated)
- [ ] **A3.0 live CLI smoke FIRST** — stdin stays open? envelope shape? awaiting-input event? cumulative cost?
- [ ] `shared/src/types.ts` — `awaiting_input` event type + run status; `SendInputBodySchema`
- [ ] `core` — `interactive` argv; retain `proc.stdin`; `sendInput(runId,text)`; status transitions;
      add `awaiting_input` to `reconcileStaleRuns` boot-sweep; detect boundary in `parseClaudeLine`
- [ ] `core/src/routes/runs.ts` — `POST /api/runs/:id/input` (409 if not awaiting; atomic transition)
- [ ] `web` — `runs.sendInput`; RunConsole answer box; non-terminal status handling
- [ ] Tests: proc-exits-while-awaiting, double-send 409, killed-while-awaiting EPIPE, idle-timeout
- [ ] Verify: live ask → answer → continue-same-session
- [ ] Review → fix → commit

## TRACK B — Phase 4 desktop app (Tauri + bundled core sidecar)

### Wave B1 — Packaging smoke + src-tauri scaffold  (smoke-gated)
- [ ] **B1.0 smoke FIRST** — `core/dist` under standalone `node.exe` from pruned prod `node_modules`,
      `better-sqlite3` opens DB + `node-pty` imports (ABI match)
- [ ] Scaffold `src-tauri/` (Cargo/tauri.conf/main.rs/lib.rs/build.rs + bundled node bin)
- [ ] Verify: `pnpm build` → web/dist+core/dist; smoke passes; `tauri dev` opens window
- [ ] Review → fix → commit

### Wave B2 — Sidecar spawn + token handoff + web Tauri-adapt
- [ ] Rust: spawn sidecar (free PORT + K_DATA_DIR), health-poll, read `auth-token`, inject to webview
- [ ] Web: detect Tauri → absolute API base + Authorization header + injected port (ws.ts/api.ts/TerminalPage)
- [ ] Lifecycle: kill sidecar tree on quit (no orphan node.exe)
- [ ] Verify: live launch/auto-auth/stream/quit-no-orphan/relaunch-reuses-token
- [ ] Review → fix → commit

### Wave B3 — Tray, native notifications, installer
- [ ] Tray menu + `tauri-plugin-notification`; Rust WS subscriber → notify run-complete + awaiting-input
- [ ] `tauri build` → Windows installer
- [ ] Verify: live notifications + tray + terminal graceful-degrade
- [ ] Review → fix → commit

## TRACK C — Documentation

### Wave C1 — Bible, decision log, plan doc
- [ ] `06-dashboard-ux.md` (composer/picker/HITL); new `11-desktop-app.md` + manifest; tick `07-roadmap.md`
- [ ] `08-decision-log.md` — D-014 (conversational HITL) + D-015 (Tauri sidecar)
- [ ] dated plan under `docs/superpowers/plans/`; recompile bible + assert D-014/D-015
- [ ] capture lessons (stdin smoke, inert model flag, sidecar ABI, dynamic-port parity)
- [ ] Review → fix → commit

## Wave V — Whole-effort verification (before merge)
- [ ] `pnpm -r typecheck` · `pnpm -r test` · `pnpm -r build` green
- [ ] Consolidated live smokes (model/multiline/HITL/desktop)
- [ ] Whole-effort review; fix HIGH/CRITICAL; merge → main no-ff

## Review notes
_(filled in as waves land)_
